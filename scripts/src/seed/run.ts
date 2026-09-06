import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { privateKeyToAccount } from 'viem/accounts'
import type { PgBoss } from 'pg-boss'
import {
  accounts,
  chainTx,
  listings,
  platformSettings,
  wallets,
  workflowNodes,
  workflows,
  type Database,
} from '@agent-desk/db'
import { QUEUES, intentKeys, toBaseUnits } from '@agent-desk/schemas'
import {
  addressesFor,
  assertDeployed,
  createChainReader,
  createContractCalls,
  createPublicChainClient,
} from '@agent-desk/adapters/chain'
import {
  checkFloors,
  checkWorkerHeartbeat,
  formatChecks,
  probeFacilitator,
  type Check,
  type FloorTarget,
} from '../checks.ts'
import type { ScriptsEnv } from '../env.ts'
import { explorerLink } from '../explorer.ts'
import { importPlatformWallet, PLATFORM_ACCOUNT_EMAIL } from '../platform-wallet.ts'
import { createEngine } from '../wiring/index.ts'
import {
  SEED_AGENTS,
  SLOPPY_RESEARCH_2,
  assertSeedAgents,
  formatSeedAgentVerdicts,
  unhealthySeedAgents,
  type ListedAgentRow,
  type SeedAgent,
  type SeedAgentVerdict,
} from './agents.ts'
import {
  applySpareSwap,
  ensureDemoAccounts,
  ensureDemoMode,
  ensureDemoWorkflows,
  ensureTelegramChatId,
  readWorkflowOwners,
  type SeededAccount,
  type TelegramOutcome,
} from './demo.ts'
import type { SeedEnv } from './env.ts'
import {
  SEED_BINANCE_TICKER,
  SEED_BUILDER,
  SEED_GOOD_CHAIN,
  SEED_OPERATOR,
  SEED_SLOPPY_CHAIN,
  SEED_WORKFLOW,
} from './fixtures.ts'
import { SeedRefused } from './refusal.ts'
import { formatSpareSwapPlan, planSpareSwap, type DemoPair } from './spare.ts'
import { ensureTusd, ensureWalletReady } from './wallets.ts'

export { SeedRefused } from './refusal.ts'

/**
 * `pnpm seed` — Story 1.10, extended by Stories 2.3 to 2.6 and 2.10.
 *
 * The order below is the only one that works, and every step in it is
 * idempotent, because "running `pnpm seed` twice changes nothing" is an
 * acceptance criterion and not a nicety:
 *
 *   0. every gas-paying key is at its BNB floor, or nothing happens at all;
 *   1. `importPlatformWallet()` — the Platform Account, the Platform Wallet row
 *      and `platform_settings.platform_account_id` (AD-5, AD-10). The worker
 *      refuses to boot before this, so it comes first. The Platform Account is
 *      also the Operator login, so the seed gives it a password and
 *      `is_operator = true` here (Story 2.1);
 *   2. `mode = 'demo'` (AD-10). It comes before any wallet, because
 *      `wallet.create` mints tUSD only in demo mode, and before any Listing,
 *      because the mode read at tick time governs every Settlement that follows;
 *   3. the Platform Wallet's own `wallet.create`, which is what sets its
 *      `ready_at` from the `approve:` receipt — `list(...)` pulls the Stake
 *      through that allowance, so no Listing can go on chain before it — and
 *      its tUSD;
 *   4. the six demo Accounts of NFR-2 and addendum §5 — two Builders, two
 *      Creators, one spare pair — each through the same `wallet.create` path a
 *      real sign-up takes, each funded with tUSD and given the 100 tUSD demo
 *      Daily Fee Budget;
 *   5. the six Seed Listings of FR-44 with `skip_verification`, published to
 *      `listing.verify` and waited on until `status = 'active'`, then asserted
 *      against the PRD addendum §2 prices;
 *   6. the Workflows: Story 1.10's one-Node chain and Story 2.10's good and
 *      sloppy five-Node chains;
 *   7. the demo pair — primary, or the spare one under `--activate-spare` —
 *      applied to the Workflows and to `.env.seed`.
 *
 * Step 5 is the only one that needs another process. AD-2 says a Listing
 * reaches the chain through `listing.verify` and through nothing else, and that
 * job is registered by `apps/worker`, which `scripts/` may not import (AD-1).
 * So the seed publishes the job and waits on the row, and says plainly when the
 * worker is not running rather than doing the work itself behind AD-2's back.
 *
 * Steps 3 and 4 call `runWalletCreate` directly, which is the seam
 * `packages/core/signing/wallet-create.ts` documents: the same function body
 * the worker registers for the `wallet.create` queue, called in-process so the
 * seed can wait for `ready_at` without a second service.
 */

export interface SeedDeps {
  db: Database
  boss: PgBoss
  env: ScriptsEnv
  seedEnv: SeedEnv
  log: (line: string) => void
  /** Story 2.10: point the demo Workflows at the failover pair of addendum §5. */
  activateSpare?: boolean
  /** How long step 5 waits for the worker to finish `listing.verify`. */
  listingTimeoutMs?: number
}

export interface SeededListing {
  agent: SeedAgent
  status: string
  /** The endpoint the engine pays, from `listings.endpoint`. */
  endpoint: string
  /** AD-2: the frozen `agentURI`, read back from the `identity:` payload. */
  agentUri: string | null
  identityTxHash: string | null
  listTxHash: string | null
}

export interface SeedResult {
  platformAccountId: string
  platformWalletId: string
  platformWalletAddress: string
  /** Story 1.10 named these; they are the demo Builder's, unchanged. */
  builderAccountId: string
  builderWalletId: string
  builderWalletAddress: string
  /** FR-44: the six Seed Listings, in `SEED_AGENTS` order. */
  seedListings: readonly SeededListing[]
  /** The addendum §2 price assertion, one verdict per Seed Agent. */
  verdicts: readonly SeedAgentVerdict[]
  /** The six demo Accounts and their System Wallets, in roster order. */
  demoAccounts: readonly SeededAccount[]
  /** Which pair the Workflows and `.env.seed` point at. */
  pair: DemoPair
  telegram: TelegramOutcome
  /** Story 1.10's one-Node Workflow, kept as Epic 1's exit criterion. */
  workflowId: string
  goodChainWorkflowId: string
  sloppyChainWorkflowId: string
  /** The :4107 endpoint the demo Creator lists live in Story 3.4. */
  sloppyResearch2Url: string
  /** `AGENT_PAYTO` as written to `.env.seed`: the demo Creator's wallet. */
  agentPayTo: string
  /** Where AD-4 says a Run is inserted, so the summary can print a curl that works. */
  webBaseUrl: string
}

const DEFAULT_LISTING_TIMEOUT_MS = 120_000
const LISTING_POLL_MS = 500

export async function runSeed(deps: SeedDeps): Promise<SeedResult> {
  const { db, env, seedEnv, log } = deps
  const listingTimeoutMs = deps.listingTimeoutMs ?? DEFAULT_LISTING_TIMEOUT_MS

  const addresses = assertDeployed(addressesFor(env.CHAIN_ID))
  const reader = createChainReader({
    publicClient: createPublicChainClient({ chainId: env.CHAIN_ID, rpcUrls: env.RPC_URLS }),
    addresses,
  })
  const calls = createContractCalls(addresses)

  // ------------------------------------------------------------- 0. floors
  //
  // Derived from the key rather than from the database, so the refusal happens
  // before the seed has written a single row. `privateKeyToAccount` only reads
  // the public half; the key is sealed under `MASTER_KEY` in step 1.
  const platformAddress = privateKeyToAccount(
    env.PLATFORM_WALLET_KEY as `0x${string}`,
  ).address.toLowerCase()

  const { targets, extra } = await floorTargets(db, env, platformAddress)
  const floorChecks = [...(await checkFloors(targets, reader.nativeBalance)), ...extra]
  log('BNB floors')
  log(formatChecks(floorChecks))
  const failed = floorChecks.filter((check) => !check.ok)
  if (failed.length > 0) {
    throw new SeedRefused(
      `refusing to seed: ${failed.length} BNB floor check(s) failed. Fund the keys and run again.`,
      failed,
    )
  }
  log('')

  // ----------------------------------------------------- 1. Platform Wallet
  const platform = await importPlatformWallet({
    db,
    platformWalletKey: env.PLATFORM_WALLET_KEY,
    masterKey: env.MASTER_KEY,
  })
  log(
    `platform account   ${platform.accountId}  ${PLATFORM_ACCOUNT_EMAIL}` +
      (platform.created ? '  (wallet imported)' : '  (already present)'),
  )
  await ensureCredentials(db, platform.accountId, SEED_OPERATOR, true, 'operator sign-in  ', log)

  // -------------------------------------------------------------- 2. demo mode
  await ensureDemoMode(db, log)

  const engine = createEngine({
    db,
    chainId: env.CHAIN_ID,
    rpcUrls: env.RPC_URLS,
    masterKey: env.MASTER_KEY,
    platformWalletId: platform.walletId,
    walletGasFloor: env.WALLET_GAS_FLOOR,
    platformWalletBnbFloor: env.PLATFORM_WALLET_BNB_FLOOR,
    creatorWalletBnbFloor: env.CREATOR_WALLET_BNB_FLOOR,
    demoMintAmount: env.DEMO_MINT_AMOUNT,
  })

  // --------------------------------- 3. the Platform Wallet, ready and funded
  const platformWallet = await ensureWalletReady(engine, platform.accountId, 'Platform Wallet', log)
  await ensureTusd(engine, calls, env, platform.walletId, platformWallet.address, platform.walletId, log)

  // ---------------------------------------------------- 4. the demo Accounts
  log('')
  const demoAccounts = await ensureDemoAccounts({
    db,
    engine,
    calls,
    env,
    platformWalletId: platform.walletId,
    log,
  })

  // ------------------------------------------------------ 5. the six Listings
  log('')
  const seedListings: SeededListing[] = []
  for (const agent of SEED_AGENTS) {
    const endpoint = seedEnv.endpoints[agent.key]
    await ensureListing(db, platform.accountId, platformWallet.address, agent, endpoint, log)
    const status = await verifyListing(deps, agent, listingTimeoutMs)
    const identity = await readChainTx(db, intentKeys.identity(agent.listingId))
    const list = await readChainTx(db, intentKeys.list(agent.listingId))
    const [row] = await db
      .select({ endpoint: listings.endpoint })
      .from(listings)
      .where(eq(listings.id, agent.listingId))
      .limit(1)
    seedListings.push({
      agent,
      status,
      endpoint: row?.endpoint ?? endpoint,
      agentUri: agentUriOfPayload(identity?.payload),
      identityTxHash: identity?.txHash ?? null,
      listTxHash: list?.txHash ?? null,
    })
  }

  const verdicts = await assertListedAtAddendumPrices(db, log)

  // ------------------------------------------------------- 6. the Workflows
  log('')
  await ensureWorkflow(db, SEED_BUILDER.accountId, log)
  await ensureDemoWorkflows(db, SEED_BUILDER.accountId, log)

  // ---------------------------------------------------- 7. the demo pair
  log('')
  const plan = planSpareSwap(deps.activateSpare === true, await readWorkflowOwners(db))
  log(formatSpareSwapPlan(plan))
  await applySpareSwap(db, plan)

  const telegram = await ensureTelegramChatId(
    db,
    plan.pair.builder.accountId,
    seedEnv.telegramChatId,
    log,
  )

  const creatorWallet = demoAccounts.find(
    (seeded) => seeded.account.accountId === plan.pair.creator.accountId,
  )
  if (!creatorWallet) {
    throw new SeedRefused(`the demo Creator ${plan.pair.creator.email} has no System Wallet`)
  }
  writeSeedEnvFiles(creatorWallet.wallet.address, platformWallet.address, log)

  const builderWallet = demoAccounts.find(
    (seeded) => seeded.account.accountId === SEED_BUILDER.accountId,
  )
  if (!builderWallet) throw new SeedRefused('the demo Builder has no System Wallet')

  return {
    platformAccountId: platform.accountId,
    platformWalletId: platform.walletId,
    platformWalletAddress: platformWallet.address,
    builderAccountId: SEED_BUILDER.accountId,
    builderWalletId: builderWallet.wallet.walletId,
    builderWalletAddress: builderWallet.wallet.address,
    seedListings,
    verdicts,
    demoAccounts,
    pair: plan.pair,
    telegram,
    workflowId: SEED_WORKFLOW.workflowId,
    goodChainWorkflowId: SEED_GOOD_CHAIN.workflowId,
    sloppyChainWorkflowId: SEED_SLOPPY_CHAIN.workflowId,
    sloppyResearch2Url: seedEnv.sloppyResearch2Url,
    agentPayTo: creatorWallet.wallet.address,
    webBaseUrl: seedEnv.webBaseUrl,
  }
}

// --------------------------------------------------------------------- floors

/**
 * The three floors Story 1.10 names, resolved against this database rather than
 * against a fixed list: the Platform Wallet, the facilitator relayer, and every
 * Creator wallet — which is every wallet that has put a Listing on chain, plus
 * `DEMO_CREATOR_ADDRESS` when the team funds a Creator key outside the platform.
 *
 * A wallet that has never created a Listing is held to `WALLET_GAS_FLOOR` by
 * `wallet.create` and is not a Creator, so it is not checked here; holding it to
 * `CREATOR_WALLET_BNB_FLOOR` would fail a wallet the platform itself topped up.
 */
async function floorTargets(
  db: Database,
  env: ScriptsEnv,
  platformAddress: string,
): Promise<{ targets: FloorTarget[]; extra: Check[] }> {
  const targets: FloorTarget[] = [
    { label: 'Platform Wallet', address: platformAddress, floorBnb: env.PLATFORM_WALLET_BNB_FLOOR },
  ]
  const extra: Check[] = []

  // AD-5: the relayer *key* lives only in `apps/facilitator`, so the address
  // comes from the env or from the facilitator's own `/health`, never from a key.
  let relayer = env.FACILITATOR_RELAYER_ADDRESS.toLowerCase()
  if (relayer === '') {
    relayer = (await probeFacilitator(env.FACILITATOR_URL)).relayerAddress ?? ''
  }
  if (relayer === '') {
    extra.push({
      name: 'BNB floor: facilitator relayer',
      ok: false,
      detail:
        'unknown: set FACILITATOR_RELAYER_ADDRESS, or start the facilitator so /health can report it',
    })
  } else {
    targets.push({
      label: 'facilitator relayer',
      address: relayer,
      floorBnb: env.FACILITATOR_RELAYER_BNB_FLOOR,
    })
  }

  for (const address of await creatorAddresses(db, env, platformAddress)) {
    targets.push({
      label: `Creator ${address}`,
      address,
      floorBnb: env.CREATOR_WALLET_BNB_FLOOR,
    })
  }
  return { targets, extra }
}

async function creatorAddresses(
  db: Database,
  env: ScriptsEnv,
  platformAddress: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ address: wallets.address })
    .from(wallets)
    .innerJoin(listings, eq(listings.creatorAccountId, wallets.accountId))
  const found = new Set(rows.map((row) => row.address.toLowerCase()))
  if (env.DEMO_CREATOR_ADDRESS !== '') found.add(env.DEMO_CREATOR_ADDRESS.toLowerCase())
  // The Platform Wallet is a Creator of the Seed Listings, but it is already on
  // the list under its own, higher floor.
  found.delete(platformAddress)
  return [...found].sort()
}

// -------------------------------------------------------------- credentials

interface SeedCredentials {
  email: string
  password: string
  /** bcrypt, cost `BCRYPT_COST`. See `fixtures.ts` for why it is a constant. */
  passwordHash: string
}

/**
 * Story 2.1 signs in as the seeded accounts, so each needs a usable
 * `password_hash`, and the Platform Account needs `is_operator = true`.
 *
 * The demo roster's hashes are on their inserts (`ensureDemoAccounts`); this is
 * for the Platform Account, which genuinely needs it: `importPlatformWallet`
 * inserts an unusable hash on purpose, because a production bring-up imports the
 * Platform Wallet and wants no login on that account at all. A known password is
 * a demo fixture, so it is set here, where `--reset` restores it, rather than
 * there.
 */
async function ensureCredentials(
  db: Database,
  accountId: string,
  credentials: SeedCredentials,
  isOperator: boolean,
  label: string,
  log: (line: string) => void,
): Promise<void> {
  const [current] = await db
    .select({ passwordHash: accounts.passwordHash, isOperator: accounts.isOperator })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)
  if (!current) throw new SeedRefused(`account ${accountId} is missing; cannot set its password`)

  const settled =
    current.passwordHash === credentials.passwordHash && current.isOperator === isOperator
  if (!settled) {
    await db
      .update(accounts)
      .set({ passwordHash: credentials.passwordHash, isOperator })
      .where(eq(accounts.id, accountId))
  }

  log(
    `${label} ${credentials.email} / ${credentials.password}  ` +
      `(is_operator = ${isOperator}, ${settled ? 'already set' : 'set'})`,
  )
}

// --------------------------------------------------------------- the Listings

/**
 * AD-2: the seed writes the form-owned columns and `skip_verification`, and
 * nothing else. `price`, `stake`, `agent_id` and the rest are filled by
 * `refreshListingFromChain` from the `list:` receipt, which is why this row
 * starts `verifying` with every chain-owned column null.
 *
 * AD-10 is why every Seed Listing belongs to the Platform Account: only
 * `platform_account_id` may list an `execution` Agent, and the six are operated
 * by the platform.
 */
async function ensureListing(
  db: Database,
  platformAccountId: string,
  payoutWallet: string,
  agent: SeedAgent,
  endpoint: string,
  log: (line: string) => void,
): Promise<void> {
  await db
    .insert(listings)
    .values({
      id: agent.listingId,
      creatorAccountId: platformAccountId,
      name: agent.name,
      description: agent.description,
      type: agent.type,
      endpoint,
      declaredPrice: toBaseUnits(agent.priceUsdt).toString(),
      declaredStake: toBaseUnits(agent.stakeUsdt).toString(),
      payoutWallet,
      status: 'verifying',
      // Story 1.10 and Stories 2.3 to 2.6 are the callers allowed to set this;
      // Story 3.4 replaces it with a real paid verification Call for everyone else.
      skipVerification: true,
    })
    .onConflictDoNothing({ target: listings.id })

  const row = await readListing(db, agent.listingId)
  if (!row) throw new SeedRefused(`the Seed Listing ${agent.listingId} was not inserted`)

  if (row.status === 'failed') {
    // A previous attempt refused. Nothing is on chain that a retry would
    // duplicate — `chainWrite` owns that — so the row goes back to `verifying`.
    log(`listing            ${agent.name}: previous attempt failed: ${row.lastError ?? 'no reason recorded'}`)
    await db
      .update(listings)
      .set({ status: 'verifying', lastError: null, updatedAt: new Date() })
      .where(eq(listings.id, agent.listingId))
  }
  if (row.endpoint !== endpoint) {
    // AD-2: `endpoint` is chain-owned from the first receipt, so the seed does
    // not rewrite it. Say so rather than silently pay a different host.
    log(
      `listing            NOTE ${agent.name} points at ${row.endpoint}, not ${agent.endpointEnv} ` +
        `(${endpoint}); the chain owns it now.`,
    )
  }
}

async function verifyListing(
  deps: SeedDeps,
  agent: SeedAgent,
  timeoutMs: number,
): Promise<string> {
  const { db, log } = deps
  const listingId = agent.listingId
  const row = await readListing(db, listingId)
  if (row?.status === 'active' || row?.status === 'paused') {
    log(`listing            ${agent.name.padEnd(24)} ${listingId}  already on chain (${row.status})`)
    return row.status
  }

  const [settings] = await db
    .select({ workerSeenAt: platformSettings.workerSeenAt })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)
  const heartbeat = checkWorkerHeartbeat(settings?.workerSeenAt ?? null, new Date())
  if (!heartbeat.ok) {
    log(
      `listing            the worker is not running (${heartbeat.detail}); ` +
        'listing.verify will run as soon as it starts.',
    )
  }

  // AD-2: one pipeline puts a Listing on chain, and it is registered by the
  // worker. The queue is exclusive on `listing_id`, so publishing twice is safe.
  await deps.boss.send(QUEUES.listingVerify, { listing_id: listingId }, { singletonKey: listingId })
  log(`listing            ${agent.name.padEnd(24)} ${listingId}  listing.verify published`)

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const current = await readListing(db, listingId)
    if (current?.status === 'active' || current?.status === 'paused') return current.status
    if (current?.status === 'failed') {
      throw new SeedRefused(
        `listing.verify refused ${agent.name} (${listingId}): ${current.lastError ?? 'no reason recorded'}`,
      )
    }
    if (Date.now() > deadline) {
      throw new SeedRefused(
        `${agent.name} (${listingId}) is still ${current?.status ?? 'missing'} after ` +
          `${timeoutMs / 1000} s. Is the worker running? \`pnpm doctor\` says.`,
      )
    }
    await sleep(LISTING_POLL_MS)
  }
}

/**
 * Story 2.10: "asserts all six Seed Agents are `active` at the PRD addendum §2
 * prices and lists any that are missing".
 *
 * The list is printed whether or not anything is wrong, because "six Providers,
 * these prices" is the fact the rest of the demo rests on; a failure is a
 * `SeedRefused`, not a warning, so the seed cannot end "Seeded." with a Node
 * that has no Provider.
 */
async function assertListedAtAddendumPrices(
  db: Database,
  log: (line: string) => void,
): Promise<SeedAgentVerdict[]> {
  const rows = await db
    .select({
      id: listings.id,
      status: listings.status,
      price: listings.price,
      type: listings.type,
    })
    .from(listings)
  const byId = new Map<string, ListedAgentRow>(
    rows.map((row) => [row.id, { status: row.status, price: row.price, type: row.type }]),
  )

  const verdicts = assertSeedAgents(byId)
  log('')
  log('Seed Agents (PRD addendum §2)')
  log(formatSeedAgentVerdicts(verdicts))

  const unhealthy = unhealthySeedAgents(verdicts)
  if (unhealthy.length > 0) {
    throw new SeedRefused(
      `${unhealthy.length} of ${verdicts.length} Seed Agents are not active at their addendum §2 price:\n` +
        unhealthy.map((verdict) => `  ${verdict.agent.name}: ${verdict.detail}`).join('\n'),
    )
  }
  return verdicts
}

async function readListing(db: Database, listingId: string) {
  const [row] = await db
    .select({
      status: listings.status,
      lastError: listings.lastError,
      endpoint: listings.endpoint,
    })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1)
  return row ?? null
}

// -------------------------------------------------------------- the Workflow

/**
 * Story 1.10's one-Node Workflow: the whole of Epic 1's exit criterion is a Run
 * of this. Story 2.10's five-Node chains are in `demo.ts`; this one is kept
 * because the Workflow id an Operator copied out of an earlier run still has to
 * resolve.
 */
async function ensureWorkflow(
  db: Database,
  builderAccountId: string,
  log: (line: string) => void,
): Promise<void> {
  await db
    .insert(workflows)
    .values({
      id: SEED_WORKFLOW.workflowId,
      accountId: builderAccountId,
      name: SEED_WORKFLOW.name,
      symbol: SEED_WORKFLOW.symbol,
      // No `execution` Node, so FR-4's Order Cap does not apply (Story 2.7).
      orderCapUsdt: null,
    })
    .onConflictDoNothing({ target: workflows.id })

  await db
    .insert(workflowNodes)
    .values({
      workflowId: SEED_WORKFLOW.workflowId,
      nodeIndex: 0,
      nodeType: SEED_BINANCE_TICKER.type,
      listingId: SEED_BINANCE_TICKER.listingId,
    })
    .onConflictDoNothing()

  log(`workflow           ${SEED_WORKFLOW.workflowId}  ${SEED_WORKFLOW.name} (1 node, data)`)
}

// -------------------------------------------------------------------- output

async function readChainTx(db: Database, intentKey: string) {
  const [row] = await db
    .select({ txHash: chainTx.txHash, payload: chainTx.payload, status: chainTx.status })
    .from(chainTx)
    .where(eq(chainTx.intentKey, intentKey))
    .limit(1)
  return row ?? null
}

function agentUriOfPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as { agent_uri?: unknown }).agent_uri
  return typeof value === 'string' ? value : null
}

/**
 * Story 2.10: "writes `.env.seed` with `AGENT_PAYTO` = the demo Creator wallet".
 *
 * ┌─ Two files, on purpose ────────────────────────────────────────────────┐
 * │ `.env.seed` is the demo Creator's wallet, for `agent-sloppy-research-2` │
 * │ on :4107 — the endpoint a stranger lists live in Story 3.4, which is    │
 * │ only a Creator's Agent if its payout wallet is not the platform's.      │
 * │                                                                        │
 * │ `.env.seed.platform` is the Platform Wallet, for the six agents on      │
 * │ :4101-:4106, whose Seed Listings are created under the Platform Account │
 * │ with the Platform Wallet as `payout_wallet`. AD-6 has the engine        │
 * │ compare the 402's `payTo` with the Price Lock's and call any difference │
 * │ `price_mismatch`, so an agent paid to the wrong wallet fails every Call.│
 * │                                                                        │
 * │ `docker-compose.yml` today gives every agent `.env.seed`; that has to   │
 * │ change to `.env.seed.platform` for the shared base, leaving `.env.seed` │
 * │ to :4107 alone. Until it does, the note printed below says so.          │
 * └────────────────────────────────────────────────────────────────────────┘
 */
export function seedEnvPath(): string {
  return join(import.meta.dirname, '..', '..', '..', '.env.seed')
}

export function platformSeedEnvPath(): string {
  return `${seedEnvPath()}.platform`
}

function writeSeedEnvFiles(
  creatorPayTo: string,
  platformPayTo: string,
  log: (line: string) => void,
): void {
  writeEnvFile(
    seedEnvPath(),
    '# Written by `pnpm seed`; read by the agent-sloppy-research-2 compose service.\n' +
      '# The demo Creator wallet, so the :4107 Listing of Story 3.4 pays a Creator.\n',
    creatorPayTo,
  )
  writeEnvFile(
    platformSeedEnvPath(),
    '# Written by `pnpm seed`; read by the six platform agent compose services.\n' +
      '# The Platform Wallet, which is the payout_wallet of every Seed Listing.\n',
    platformPayTo,
  )
  log(`.env.seed          AGENT_PAYTO=${creatorPayTo}  (demo Creator, for :4107)`)
  log(`.env.seed.platform AGENT_PAYTO=${platformPayTo}  (Platform Wallet, for :4101-:4106)`)
}

function writeEnvFile(path: string, header: string, payTo: string): void {
  const contents = `${header}AGENT_PAYTO=${payTo}\n`
  if (existsSync(path) && readFileSync(path, 'utf8') === contents) return
  writeFileSync(path, contents)
}

export function formatSeedSummary(result: SeedResult, explorerUrl: string): string {
  const lines = [
    '',
    'Seeded.',
    '',
    `  Mode                demo`,
    `  Demo pair           ${result.pair.spare ? 'SPARE' : 'primary'} — ` +
      `${result.pair.builder.email} builds, ${result.pair.creator.email} creates`,
    `  Operator sign-in    ${SEED_OPERATOR.email} / ${SEED_OPERATOR.password}`,
    '',
    '  Accounts (all at a 100 tUSD Daily Fee Budget):',
    ...result.demoAccounts.map(
      (seeded) =>
        `    ${seeded.account.label.padEnd(16)} ${seeded.account.email.padEnd(30)} / ` +
        `${seeded.account.password.padEnd(10)} ${seeded.wallet.address}`,
    ),
    '',
    '  Seed Agents:',
    ...result.seedListings.map(
      (listed) =>
        `    ${listed.agent.name.padEnd(24)} ${listed.agent.priceUsdt.padEnd(6)} tUSD  ` +
        `${listed.status.padEnd(9)} ${listed.endpoint}`,
    ),
    '',
    `  Good chain          ${result.goodChainWorkflowId}`,
    `  Sloppy chain        ${result.sloppyChainWorkflowId}`,
    `  Ticker chain        ${result.workflowId}  (Story 1.10, one Node)`,
    `  Telegram chat id    ${result.telegram}`,
    '',
    `  Platform Wallet     ${explorerLink('address', result.platformWalletAddress, explorerUrl)}`,
    `  Builder Wallet      ${explorerLink('address', result.builderWalletAddress, explorerUrl)}`,
    `  AGENT_PAYTO         ${result.agentPayTo}  (demo Creator)`,
    '',
    '  List the second Sloppy Research live (Story 3.4) with this endpoint:',
    `    ${result.sloppyResearch2Url}`,
    '',
    '  AD-6: the engine compares the 402 `payTo` with the Price Lock and calls any',
    '  difference `price_mismatch`, so the six platform agents must read',
    '  .env.seed.platform and only :4107 may read .env.seed. If docker-compose.yml',
    '  still gives `x-agent-base` `.env.seed`, change it before restarting anything;',
    '  otherwise all six agents start asking to be paid the demo Creator and every',
    '  Call fails.',
    '',
    '  The :4107 container read AGENT_PAYTO when it started, so it is still paying',
    '  the old address until it is restarted. Run:',
    `    docker compose restart ${SLOPPY_RESEARCH_2.service}`,
    '  The seed cannot do this itself: it talks to Postgres and the chain, not to',
    '  the Docker socket, and a script that could restart containers would be a',
    '  second way to change what the stack is running.',
    '',
    '  Start a Run of the good chain:',
    `    curl -sS -X POST ${result.webBaseUrl}/api/runs -H 'content-type: application/json' \\`,
    `      -d '{"workflow_id":"${result.goodChainWorkflowId}"}'`,
    '',
  ]
  return lines.join('\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
