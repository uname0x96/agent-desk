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
import { QUEUES, intentKeys, toDecimalUsdt } from '@agent-desk/schemas'
import {
  addressesFor,
  assertDeployed,
  createChainReader,
  createContractCalls,
  createPublicChainClient,
} from '@agent-desk/adapters/chain'
import { bnbToWei } from '@agent-desk/core/signing'
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
import { createEngine, type Engine } from '../wiring/index.ts'
import {
  SEED_BINANCE_TICKER,
  SEED_BINANCE_TICKER_PRICE,
  SEED_BINANCE_TICKER_STAKE,
  SEED_BUILDER,
  SEED_OPERATOR,
  SEED_WORKFLOW,
} from './fixtures.ts'

/**
 * `pnpm seed` — Story 1.10.
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
 *   2. the Platform Wallet's own `wallet.create`, which is what sets its
 *      `ready_at` from the `approve:` receipt — `list(...)` pulls the Stake
 *      through that allowance, so the Listing cannot go on chain before it;
 *   3. tUSD for the Platform Wallet, so it can post that Stake;
 *   4. the Builder account with its own password, its wallet through
 *      `wallet.create`, and its tUSD;
 *   5. the Binance Ticker Listing with `skip_verification`, published to
 *      `listing.verify` and waited on until `status = 'active'`;
 *   6. the Builder's one-node Workflow.
 *
 * Step 5 is the only one that needs another process. AD-2 says a Listing
 * reaches the chain through `listing.verify` and through nothing else, and that
 * job is registered by `apps/worker`, which `scripts/` may not import (AD-1).
 * So the seed publishes the job and waits on the row, and says plainly when the
 * worker is not running rather than doing the work itself behind AD-2's back.
 *
 * Steps 2 and 4 call `runWalletCreate` directly, which is the seam
 * `packages/core/signing/wallet-create.ts` documents: the same function body
 * the worker registers for the `wallet.create` queue, called in-process so the
 * seed can wait for `ready_at` without a second service.
 */

export interface SeedDeps {
  db: Database
  boss: PgBoss
  env: ScriptsEnv
  log: (line: string) => void
  /** How long step 5 waits for the worker to finish `listing.verify`. */
  listingTimeoutMs?: number
}

export interface SeedResult {
  platformAccountId: string
  platformWalletId: string
  platformWalletAddress: string
  builderAccountId: string
  builderWalletId: string
  builderWalletAddress: string
  listingId: string
  listingStatus: string
  /** The endpoint the engine pays, from `listings.endpoint`. */
  agentUrl: string
  /** AD-2: the frozen `agentURI`, read back from the `identity:` payload. */
  agentUri: string | null
  workflowId: string
  identityTxHash: string | null
  listTxHash: string | null
}

/** A refusal the Operator has to act on. The CLI prints it and exits 1. */
export class SeedRefused extends Error {
  readonly checks: readonly Check[]
  constructor(reason: string, checks: readonly Check[] = []) {
    super(reason)
    this.name = 'SeedRefused'
    this.checks = checks
  }
}

const DEFAULT_LISTING_TIMEOUT_MS = 120_000
const LISTING_POLL_MS = 500

export async function runSeed(deps: SeedDeps): Promise<SeedResult> {
  const { db, env, log } = deps
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

  // --------------------------------- 2, 3. the Platform Wallet, ready and funded
  const platformWallet = await ensureWalletReady(engine, platform.accountId, 'Platform Wallet', log)
  await ensureTusd(engine, calls, env, platform.walletId, platformWallet.address, platform.walletId, log)

  // ------------------------------------------- 4. the Builder and its wallet
  const builderAccountId = await ensureBuilderAccount(db, log)
  const builderWallet = await ensureWalletReady(engine, builderAccountId, 'Builder Wallet', log)
  await ensureTusd(engine, calls, env, builderWallet.walletId, builderWallet.address, platform.walletId, log)

  // -------------------------------------------------------- 5. the Listing
  await ensureListing(db, platform.accountId, platformWallet.address, env, log)
  const listingStatus = await verifyListing(deps, SEED_BINANCE_TICKER.listingId, listingTimeoutMs)

  // ------------------------------------------------------- 6. the Workflow
  await ensureWorkflow(db, builderAccountId, log)

  // ------------------------------------------------- what the demo needs next
  const identity = await readChainTx(db, intentKeys.identity(SEED_BINANCE_TICKER.listingId))
  const list = await readChainTx(db, intentKeys.list(SEED_BINANCE_TICKER.listingId))
  const [listing] = await db
    .select({ endpoint: listings.endpoint })
    .from(listings)
    .where(eq(listings.id, SEED_BINANCE_TICKER.listingId))
    .limit(1)

  writeSeedEnvFile(platformWallet.address, log)

  return {
    platformAccountId: platform.accountId,
    platformWalletId: platform.walletId,
    platformWalletAddress: platformWallet.address,
    builderAccountId,
    builderWalletId: builderWallet.walletId,
    builderWalletAddress: builderWallet.address,
    listingId: SEED_BINANCE_TICKER.listingId,
    listingStatus,
    agentUrl: listing?.endpoint ?? env.SEED_BINANCE_TICKER_URL,
    agentUri: agentUriOfPayload(identity?.payload),
    workflowId: SEED_WORKFLOW.workflowId,
    identityTxHash: identity?.txHash ?? null,
    listTxHash: list?.txHash ?? null,
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

// -------------------------------------------------------------- the wallets

interface ReadyWallet {
  walletId: string
  address: string
}

/**
 * AD-5: `ready_at` comes from the `approve:<wallet_id>` receipt and from nothing
 * else, so "wait for `ready_at`" is just "run the job and read what it returns".
 * A second run resumes onto the confirmed `chain_tx` rows and sends nothing.
 */
async function ensureWalletReady(
  engine: Engine,
  accountId: string,
  label: string,
  log: (line: string) => void,
): Promise<ReadyWallet> {
  const result = await engine.runWalletCreate({ account_id: accountId })
  if (!result.ok) {
    throw new SeedRefused(
      `${label}: wallet.create failed at ${result.failedAt}: ${result.reason}`,
    )
  }
  log(
    `${label.padEnd(18)} ${result.walletId}  ${result.address}  ready ${result.readyAt.toISOString()}` +
      `  [gas ${result.steps.gas}, mint ${result.steps.mint}, approve ${result.steps.approve}]`,
  )
  return { walletId: result.walletId, address: result.address }
}

/**
 * FR-44 / AD-5: the Platform Wallet needs tUSD to post a Stake and the Builder
 * needs tUSD to pay for a Run, and in `production` mode `wallet.create` skips
 * its mint step, so the seed does it.
 *
 * The intent key is `mint:<wallet_id>` — the same key `wallet.create` uses in
 * demo mode, so exactly one mint per wallet exists whichever path ran first
 * (AD-8). The signer, though, is always the Platform Wallet: `tUSD.mint` is
 * permissionless and takes the recipient as an argument, and a wallet that was
 * just topped up to `WALLET_GAS_FLOOR` and then spent part of it on its own
 * `approve` no longer clears that floor.
 */
async function ensureTusd(
  engine: Engine,
  calls: ReturnType<typeof createContractCalls>,
  env: ScriptsEnv,
  walletId: string,
  address: string,
  platformWalletId: string,
  log: (line: string) => void,
): Promise<void> {
  const intentKey = intentKeys.mint(walletId)
  const amount = env.DEMO_MINT_AMOUNT
  const result = await engine.chain.chainWrite(intentKey, () => {
    const call = calls.tusdMint(address, amount)
    return {
      walletId: platformWalletId,
      to: call.to,
      data: call.data,
      gasFloorWei: bnbToWei(env.PLATFORM_WALLET_BNB_FLOOR),
      payload: {
        wallet_id: walletId,
        to: address,
        amount: amount.toString(),
        minted_by: platformWalletId,
      },
    }
  })
  if (result.refusal) throw new SeedRefused(`${intentKey}: ${result.refusal.message}`)
  if (result.record.status !== 'confirmed') {
    throw new SeedRefused(`${intentKey} is ${result.record.status}; tUSD was not minted`)
  }
  log(
    `tUSD               ${toDecimalUsdt(amount)} tUSD to ${address}  ` +
      `(${result.reused ? 'already minted' : 'minted'})`,
  )
}

// --------------------------------------------------------------- the Builder

async function ensureBuilderAccount(db: Database, log: (line: string) => void): Promise<string> {
  await db
    .insert(accounts)
    .values({
      id: SEED_BUILDER.accountId,
      email: SEED_BUILDER.email,
      passwordHash: SEED_BUILDER.passwordHash,
      isOperator: false,
    })
    .onConflictDoNothing({ target: accounts.id })

  // The email is unique too, so an account seeded under another id would make
  // the insert above a silent no-op and leave the Workflow ownerless.
  const [byEmail] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.email, SEED_BUILDER.email))
    .limit(1)
  if (!byEmail) throw new SeedRefused(`the Builder account ${SEED_BUILDER.email} was not inserted`)
  if (byEmail.id !== SEED_BUILDER.accountId) {
    throw new SeedRefused(
      `${SEED_BUILDER.email} already belongs to account ${byEmail.id}, not the seed's ` +
        `${SEED_BUILDER.accountId}. Run \`pnpm seed --reset\` or remove that account.`,
    )
  }
  log(`builder account    ${byEmail.id}`)
  await ensureCredentials(db, byEmail.id, SEED_BUILDER, false, 'builder sign-in   ', log)
  return byEmail.id
}

interface SeedCredentials {
  email: string
  password: string
  /** bcrypt, cost `BCRYPT_COST`. See `fixtures.ts` for why it is a constant. */
  passwordHash: string
}

/**
 * Story 2.1 signs in as both seeded accounts, so both need a usable
 * `password_hash`, and the Platform Account needs `is_operator = true`.
 *
 * The Builder's hash is already on its insert; this also repairs a database
 * seeded before the credentials existed. The Platform Account genuinely needs
 * it: `importPlatformWallet` inserts an unusable hash on purpose, because a
 * production bring-up imports the Platform Wallet and wants no login on that
 * account at all. A known password is a demo fixture, so it is set here, where
 * `--reset` restores it, rather than there.
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

// --------------------------------------------------------------- the Listing

/**
 * AD-2: the seed writes the form-owned columns and `skip_verification`, and
 * nothing else. `price`, `stake`, `agent_id` and the rest are filled by
 * `refreshListingFromChain` from the `list:` receipt, which is why this row
 * starts `verifying` with every chain-owned column null.
 */
async function ensureListing(
  db: Database,
  platformAccountId: string,
  payoutWallet: string,
  env: ScriptsEnv,
  log: (line: string) => void,
): Promise<void> {
  await db
    .insert(listings)
    .values({
      id: SEED_BINANCE_TICKER.listingId,
      creatorAccountId: platformAccountId,
      name: SEED_BINANCE_TICKER.name,
      description: SEED_BINANCE_TICKER.description,
      type: SEED_BINANCE_TICKER.type,
      endpoint: env.SEED_BINANCE_TICKER_URL,
      declaredPrice: SEED_BINANCE_TICKER_PRICE,
      declaredStake: SEED_BINANCE_TICKER_STAKE,
      payoutWallet,
      status: 'verifying',
      // Story 1.10 is the one caller allowed to set this; Story 3.4 replaces it
      // with a real paid verification Call for everyone else.
      skipVerification: true,
    })
    .onConflictDoNothing({ target: listings.id })

  const row = await readListing(db, SEED_BINANCE_TICKER.listingId)
  if (!row) throw new SeedRefused(`the Seed Listing ${SEED_BINANCE_TICKER.listingId} was not inserted`)

  if (row.status === 'failed') {
    // A previous attempt refused. Nothing is on chain that a retry would
    // duplicate — `chainWrite` owns that — so the row goes back to `verifying`.
    log(`listing            previous attempt failed: ${row.lastError ?? 'no reason recorded'}`)
    await db
      .update(listings)
      .set({ status: 'verifying', lastError: null, updatedAt: new Date() })
      .where(eq(listings.id, SEED_BINANCE_TICKER.listingId))
  }
  if (row.endpoint !== env.SEED_BINANCE_TICKER_URL) {
    // AD-2: `endpoint` is chain-owned from the first receipt, so the seed does
    // not rewrite it. Say so rather than silently pay a different host.
    log(
      `listing            NOTE the row's endpoint is ${row.endpoint}, not SEED_BINANCE_TICKER_URL ` +
        `(${env.SEED_BINANCE_TICKER_URL}); the chain owns it now.`,
    )
  }
}

async function verifyListing(
  deps: SeedDeps,
  listingId: string,
  timeoutMs: number,
): Promise<string> {
  const { db, log } = deps
  const row = await readListing(db, listingId)
  if (row?.status === 'active' || row?.status === 'paused') {
    log(`listing            ${listingId}  already on chain (${row.status})`)
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
  log(`listing            ${listingId}  listing.verify published, waiting for status = active`)

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const current = await readListing(db, listingId)
    if (current?.status === 'active' || current?.status === 'paused') return current.status
    if (current?.status === 'failed') {
      throw new SeedRefused(
        `listing.verify refused ${listingId}: ${current.lastError ?? 'no reason recorded'}`,
      )
    }
    if (Date.now() > deadline) {
      throw new SeedRefused(
        `listing ${listingId} is still ${current?.status ?? 'missing'} after ${timeoutMs / 1000} s. ` +
          'Is the worker running? `pnpm doctor` says.',
      )
    }
    await sleep(LISTING_POLL_MS)
  }
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
 * Story 2.3 reads `AGENT_PAYTO` for `agent-sloppy-research-2` out of this file,
 * and every other agent service reads it too, because nothing else in `.env`
 * knows the Platform Wallet's address until the seed has imported the key.
 */
export function seedEnvPath(): string {
  return join(import.meta.dirname, '..', '..', '..', '.env.seed')
}

function writeSeedEnvFile(payTo: string, log: (line: string) => void): void {
  const path = seedEnvPath()
  const contents =
    '# Written by `pnpm seed`; read by the agent compose services (env_file).\n' +
    `AGENT_PAYTO=${payTo}\n`
  if (existsSync(path) && readFileSync(path, 'utf8') === contents) return
  writeFileSync(path, contents)
  log(`.env.seed          AGENT_PAYTO=${payTo}`)
}

export function formatSeedSummary(result: SeedResult, explorerUrl: string): string {
  const lines = [
    '',
    'Seeded.',
    '',
    `  Workflow            ${result.workflowId}`,
    `  Builder sign-in     ${SEED_BUILDER.email} / ${SEED_BUILDER.password}`,
    `  Operator sign-in    ${SEED_OPERATOR.email} / ${SEED_OPERATOR.password}`,
    `  Listing             ${result.listingId}  ${SEED_BINANCE_TICKER.name} ` +
      `(${SEED_BINANCE_TICKER.priceUsdt} tUSD, stake ${SEED_BINANCE_TICKER.stakeUsdt} tUSD, ${result.listingStatus})`,
    `  Agent URL           ${result.agentUrl}`,
    `  agentURI            ${result.agentUri ?? '(not decided yet)'}`,
    `  Platform Wallet     ${explorerLink('address', result.platformWalletAddress, explorerUrl)}`,
    `  Builder Wallet      ${explorerLink('address', result.builderWalletAddress, explorerUrl)}`,
    `  identity tx         ${
      result.identityTxHash ? explorerLink('tx', result.identityTxHash, explorerUrl) : '(none)'
    }`,
    `  list tx             ${
      result.listTxHash ? explorerLink('tx', result.listTxHash, explorerUrl) : '(none)'
    }`,
    '',
    '  Start a Run:',
    `    curl -sS -X POST http://localhost:3000/api/runs -H 'content-type: application/json' \\`,
    `      -d '{"workflow_id":"${result.workflowId}"}'`,
    '',
  ]
  return lines.join('\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
