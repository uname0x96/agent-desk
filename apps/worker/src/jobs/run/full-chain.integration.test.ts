import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  addressesFor,
  assertDeployed,
  createChainReader,
  createContractCalls,
  createPublicChainClient,
} from '@agent-desk/adapters/chain'
import { createMarketData } from '@agent-desk/adapters/market-data'
import { createEngine, type Engine } from '@agent-desk/scripts/wiring'
import {
  accounts,
  calls,
  createDb,
  listings,
  runs,
  wallets,
  workflowNodes,
  workflows,
  type Database,
} from '@agent-desk/db'
import { X402_HEADERS, newId, type AgentType, type PriceLock } from '@agent-desk/schemas'
import { safeAddressEquals } from './addresses.ts'
import { createAgentClient } from './agent-client.ts'
import { createRunEngine } from './engine.ts'
import { createExchangeBalance } from './exchange-balance.ts'
import { createRunStore } from './store.ts'

/**
 * The whole chain, paid for real: several Agents in sequence, each at its own
 * price and to its own payout address, against a real chain.
 *
 * `live-payment.integration.test.ts` proves one handshake works. This file
 * proves the things only a chain of Nodes can show:
 *
 *   - the PRD addendum §1 mapping over *real* Agent outputs — the `data`
 *     Node's answer becomes the `research` Node's `market`, its `signal` and
 *     `confidence` become the `risk` Node's, and the `risk` Node's `size_usdt`
 *     becomes the order;
 *   - the AD-11 balance read, over a real `GET /internal/balance` request;
 *   - FR-24: a `REJECT` from a real risk Agent skips `execution`, and the
 *     skipped Node's Listing is never requested and never paid;
 *   - AD-4: the terminal `notify` filter is paid last, from the whole Run, with
 *     a cost table whose hashes are the hashes the chain actually produced.
 *
 * Two Runs, because no single one can show both endings:
 *
 *   - **the chain that ends in a refusal** pays the real Sloppy Research and
 *     the real Guardrail Risk in sequence. Sloppy Research fades the 24 h move
 *     at confidence 0.9 and Guardrail Risk refuses a confident counter-trend
 *     signal, so the REJECT is the two Agents talking to each other rather
 *     than a fixture — the demo's "before" half, and a real skip;
 *   - **the chain that reaches an order** answers the research Node from a stub
 *     at a lower confidence, so the same real Guardrail Risk APPROVEs, the two
 *     order guards pass, and an `execution` Node is paid.
 *
 * The `data` Node is a stub in both, serving a fixed 24 h window: the decision
 * under test would otherwise depend on what BNBUSDT did today, and a real paid
 * Call to the real Binance Ticker is already proved next door.
 *
 * The `execution` and `notify` stubs are not mocks of the payment: they decode
 * the `PAYMENT-SIGNATURE` header and settle it against the real facilitator, so
 * every Call in both Runs moves real tUSD. They stand in only for the two seed
 * Agents whose own work needs credentials this environment does not have — the
 * Binance Spot Testnet key and the Telegram bot token are both empty in `.env`.
 *
 * **This file is opt-in.** It runs only with `LIVE_FULL_CHAIN=1`:
 *
 *   LIVE_FULL_CHAIN=1 corepack pnpm --filter @agent-desk/worker exec \
 *     vitest run src/jobs/run/full-chain.integration.test.ts
 *
 * The reason is measured. It starts three Node processes and spends seconds on
 * chain, while the rest of the repository's integration files share one
 * database behind a session advisory lock and wait for it in hooks that time
 * out after 10 s. Load that stretches the lock holder past ten seconds makes
 * the waiters give up, and a suite that gives up truncates on its way out,
 * failing whichever file was mid-flight. Measured back to back on the demo
 * laptop: nine full-suite runs with this file in the default set, five red in
 * files this story does not own; nine without it, none. So it is run on
 * purpose, against the live environment, where its output is the proof.
 *
 * (That shared-lock cascade is not this file's to fix and shows up without it
 * too when the machine is busy, which is why the measurement was taken in one
 * window rather than read off a single run.)
 *
 * It also owns its database rather than sharing theirs, so nothing it does can
 * truncate a table another suite is using.
 *
 * With the flag set, it still skips cleanly when the RPC or Postgres is not
 * reachable.
 *
 *   RPC_URLS=http://127.0.0.1:8545 CHAIN_ID=97
 */

const RPC_URL = process.env.TEST_RPC_URL ?? 'http://127.0.0.1:8545'

/**
 * A database of this file's own, created and migrated on demand.
 *
 * Every other integration file in the repo truncates one shared database and
 * takes a session advisory lock so they take turns. A live chain of five Nodes
 * holds that lock for seconds at a time, which is long enough to push the other
 * suites past their own 10 s hook timeout — and a suite that gives up waiting
 * truncates the tables this one is in the middle of using. Owning a database
 * costs one `create database` on first run and removes the contention entirely.
 */
const DATABASE_NAME = process.env.TEST_DATABASE_NAME ?? 'agentdesk_story28'
const ADMIN_DATABASE_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/postgres'
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? `postgres://agentdesk:agentdesk@localhost:5432/${DATABASE_NAME}`
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/db/drizzle')

const CHAIN_ID = 97
const SYMBOL = 'BNBUSDT'
const INTERNAL_TOKEN = 'full-chain-test'
/** 2 tUSD, comfortably more than the two Runs below spend. */
const MINT = 2_000_000n
/** What the stubbed `GET /internal/balance` answers, in decimal USDT. */
const BALANCE = '950.00'
/** FR-4, decimal USDT. Both Runs use the same Order Cap. */
const ORDER_CAP = '20'

/** The addendum §2 seed prices, in base units (AD-13). */
const PRICES = {
  data: '10000',
  research: '30000',
  risk: '20000',
  execution: '10000',
  notify: '5000',
} as const

/** One payout address per Node, so "who was paid" is a balance, not a log line. */
const PAY_TO = {
  data: '0x00000000000000000000000000000000000000d1',
  research: '0x00000000000000000000000000000000000000d2',
  risk: '0x00000000000000000000000000000000000000d3',
  execution: '0x00000000000000000000000000000000000000d4',
  notify: '0x00000000000000000000000000000000000000d5',
} as const

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const TSX = resolve(REPO_ROOT, 'node_modules/.bin/tsx')
const FACILITATOR_ENTRY = resolve(REPO_ROOT, 'apps/facilitator/src/index.ts')
const AGENT_ENTRIES = {
  research: resolve(REPO_ROOT, 'apps/agents/sloppy-research/src/index.ts'),
  risk: resolve(REPO_ROOT, 'apps/agents/guardrail-risk/src/index.ts'),
} as const

const publicClient = createPublicClient({ transport: http(RPC_URL) })

/** Opt-in: see the note above. */
const LIVE = process.env.LIVE_FULL_CHAIN === '1'

async function preflight(): Promise<string | null> {
  if (!LIVE) return 'LIVE_FULL_CHAIN is not set'
  try {
    const chainId = await publicClient.getChainId()
    if (chainId !== CHAIN_ID) return `the chain at ${RPC_URL} is ${chainId}, not ${CHAIN_ID}`
  } catch {
    return `no chain at ${RPC_URL}`
  }
  try {
    const addressesHere = assertDeployed(addressesFor(CHAIN_ID))
    const code = await publicClient.getCode({ address: addressesHere.tusd as Hex })
    if (!code || code === '0x') return `tUSD is not deployed at ${addressesHere.tusd}`
  } catch (error) {
    return `deployments/${CHAIN_ID}.json is not usable: ${(error as Error).message}`
  }
  try {
    await ensureDatabase()
  } catch (error) {
    return `no usable database at ${TEST_DATABASE_URL}: ${(error as Error).message}`
  }
  return null
}

/**
 * Create the database if it is not there yet, then bring it up to the head
 * migration. Both connections are closed again: this whole repository's tests
 * share one Postgres, and a connection held for the length of a file is a
 * connection ninety other files cannot have.
 */
async function ensureDatabase(): Promise<void> {
  const admin = createDb({ url: ADMIN_DATABASE_URL, max: 1 })
  try {
    const existing = await admin.execute(
      sql`select 1 from pg_database where datname = ${DATABASE_NAME}`,
    )
    // `create database` cannot run inside a transaction or take a parameter, and
    // the name is this file's own constant rather than anything from a request.
    if (existing.length === 0) await admin.execute(sql.raw(`create database "${DATABASE_NAME}"`))
  } finally {
    await admin.$client.end()
  }
  const migrator = createDb({ url: TEST_DATABASE_URL, max: 1 })
  try {
    await migrate(migrator, { migrationsFolder: MIGRATIONS })
  } finally {
    await migrator.$client.end()
  }
}

const SKIP = await preflight()

const db: Database = createDb({ url: TEST_DATABASE_URL, max: 2 })
const addresses = SKIP ? null : assertDeployed(addressesFor(CHAIN_ID))

// -- child processes ---------------------------------------------------------

interface Service {
  url: string
  stop(): Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => ok(port))
    })
  })
}

async function waitForHealth(url: string, child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${url} exited ${child.exitCode}:\n${log()}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((ok) => setTimeout(ok, 250))
  }
  throw new Error(`${url} never became healthy:\n${log()}`)
}

async function startService(entry: string, env: Record<string, string>, port: number): Promise<Service> {
  const child = spawn(TSX, [entry], {
    cwd: REPO_ROOT,
    // A curated environment: the shell's own RPC_URLS or CHAIN_ID must not
    // reach a service this test is pointing at a local chain.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const collect = (chunk: Buffer) => {
    output += chunk.toString()
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  const url = `http://127.0.0.1:${port}`
  try {
    await waitForHealth(`${url}/health`, child, () => output)
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }

  return {
    url,
    stop: () =>
      new Promise<void>((ok) => {
        if (child.exitCode !== null) return ok()
        const force = setTimeout(() => child.kill('SIGKILL'), 3_000)
        child.once('exit', () => {
          clearTimeout(force)
          ok()
        })
        child.kill('SIGTERM')
      }),
  }
}

// -- a stand-in Agent that really is paid -------------------------------------

interface StubOptions {
  /** Base units, matching the Price Lock entry this Node will carry. */
  price: string
  payTo: string
  /** The Type output to answer with, given the input the engine sent. */
  answer: (input: unknown) => unknown
  /** When set, the stub also serves `GET /internal/balance` (AD-11). */
  balanceUsdt?: string
}

interface Stub {
  url: string
  /** Every body the engine posted, paid or not. */
  requests: unknown[]
  /** How many `GET /internal/balance` reads it served. */
  balanceReads: number
}

/**
 * An x402 resource server in thirty lines: 402 with the terms, then settle the
 * header the engine signed against the real facilitator and answer with the
 * `PAYMENT-RESPONSE` the settlement produced. The money is real; only the
 * Agent's own work is a fixture.
 */
async function startStub(options: StubOptions): Promise<Stub> {
  const port = await freePort()
  const stub: Stub = { url: `http://127.0.0.1:${port}/`, requests: [], balanceReads: 0 }
  const paymentRequired = {
    x402Version: 2,
    error: 'Payment required',
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:97',
        asset: addresses!.tusd.toLowerCase(),
        amount: options.price,
        payTo: options.payTo,
        maxTimeoutSeconds: 15,
        extra: { name: 'tUSD', version: '1' },
      },
    ],
  }

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/internal/balance') {
      if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`) return json(res, 401, { error: 'unauthorized' })
      if (options.balanceUsdt === undefined) return json(res, 404, { error: 'not found' })
      stub.balanceReads += 1
      return json(res, 200, { balance_usdt: options.balanceUsdt })
    }

    const signature = req.headers[X402_HEADERS.signature.toLowerCase()]
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const input: unknown = raw === '' ? null : JSON.parse(raw)
      stub.requests.push(input)

      if (typeof signature !== 'string') {
        return json(res, 402, paymentRequired, {
          [X402_HEADERS.required]: Buffer.from(JSON.stringify(paymentRequired)).toString('base64'),
        })
      }

      // The facilitator checks `accepted` against the requirements it is handed,
      // and the engine echoes the entry it matched into the payload (AD-6), so
      // forwarding it back is exactly what the real middleware does.
      const payload = JSON.parse(Buffer.from(signature, 'base64').toString('utf8')) as {
        accepted: unknown
      }
      fetch(`${facilitator.url}/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: payload,
          paymentRequirements: payload.accepted,
        }),
      })
        .then(async (response) => {
          const receipt = (await response.json()) as { success?: boolean; transaction?: string }
          if (!receipt.success || !receipt.transaction) {
            return json(res, 502, { error: 'settlement failed', receipt })
          }
          return json(res, 200, options.answer(input), {
            [X402_HEADERS.response]: Buffer.from(JSON.stringify(receipt)).toString('base64'),
          })
        })
        .catch((error: unknown) => json(res, 502, { error: (error as Error).message }))
    })
  })

  await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok))
  stubs.push(server)
  return stub
}

// -- fixtures ----------------------------------------------------------------

let engine: Engine
let facilitator: Service
let payerWalletId: string
let payerAddress: string
let sharedAccountId: string
let executionStub: Stub
let notifyStub: Stub
/** The two real seed Agents whose answers feed each other, started once. */
let sloppy: Service
let guardrail: Service
const stubs: Server[] = []
const services: Service[] = []

async function reset(): Promise<void> {
  await db.execute(sql`
    truncate chain_tx, settlements, calls, runs, workflow_nodes, workflows, listings, wallets, accounts
    restart identity cascade
  `)
  await db.execute(sql`
    insert into platform_settings (id, mode, emergency_stop, order_ceiling_usdt, default_daily_fee_budget, verification_cap_daily)
    values (1, 'production', false, '1000', '1000000', '5000000')
    on conflict (id) do update set default_daily_fee_budget = '1000000', platform_account_id = null
  `)
}

/** A funded throwaway account, so no shared anvil key and no shared nonce. */
async function fundedKey(bnb = 10n): Promise<{ key: Hex; address: Hex }> {
  const key = generatePrivateKey()
  const address = privateKeyToAccount(key).address
  await publicClient.request({
    method: 'anvil_setBalance' as never,
    params: [address, `0x${(bnb * 10n ** 18n).toString(16)}`] as never,
  })
  return { key, address }
}

async function startAgent(type: keyof typeof AGENT_ENTRIES, price: string): Promise<Service> {
  const port = await freePort()
  const service = await startService(
    AGENT_ENTRIES[type],
    {
      AGENT_PORT: String(port),
      AGENT_PRICE: price,
      AGENT_PAYTO: PAY_TO[type],
      FACILITATOR_URL: facilitator.url,
      INTERNAL_TOKEN,
      CHAIN_ID: String(CHAIN_ID),
      LOG_LEVEL: 'warn',
    },
    port,
  )
  services.push(service)
  return service
}

beforeAll(async () => {
  if (SKIP) return
  await reset()

  const relayer = await fundedKey()
  const minter = await fundedKey()

  const facilitatorPort = await freePort()
  facilitator = await startService(
    FACILITATOR_ENTRY,
    {
      CHAIN_ID: String(CHAIN_ID),
      RPC_URLS: RPC_URL,
      FACILITATOR_RELAYER_KEY: relayer.key,
      FACILITATOR_PORT: String(facilitatorPort),
      FACILITATOR_URL: `http://127.0.0.1:${facilitatorPort}`,
      LOG_LEVEL: 'warn',
    },
    facilitatorPort,
  )
  services.push(facilitator)

  // AD-5: the paying wallet's key is generated and sealed by the signing
  // service itself, so this test never handles a private key for it.
  engine = createEngine({
    db,
    chainId: CHAIN_ID,
    rpcUrls: [RPC_URL],
    masterKey: randomBytes(32).toString('hex'),
    platformWalletId: newId('wallet'),
    walletGasFloor: '0',
    platformWalletBnbFloor: '0',
    creatorWalletBnbFloor: '0',
    demoMintAmount: MINT,
  })

  const generated = await engine.signing.generateKey()
  payerAddress = generated.address.toLowerCase()
  payerWalletId = newId('wallet')
  sharedAccountId = newId('account')
  await db.insert(accounts).values({
    id: sharedAccountId,
    email: `${sharedAccountId}@test.local`,
    passwordHash: '!',
    // FR-32: without this the terminal filter refuses before payment.
    telegramChatId: '123456789',
  })
  await db.insert(wallets).values({
    id: payerWalletId,
    accountId: sharedAccountId,
    address: payerAddress,
    encryptedKey: generated.encryptedKey,
    readyAt: new Date(),
  })

  const wallet = createWalletClient({
    account: privateKeyToAccount(minter.key),
    chain: {
      id: CHAIN_ID,
      name: 'local',
      nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
    },
    transport: http(RPC_URL),
  })
  const mint = createContractCalls(addresses!).tusdMint(payerAddress, MINT)
  const mintHash = await wallet.sendTransaction({ to: mint.to as Hex, data: mint.data })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: mintHash })
  if (receipt.status !== 'success') throw new Error('minting tUSD to the paying wallet reverted')

  executionStub = await startStub({
    price: PRICES.execution,
    payTo: PAY_TO.execution,
    balanceUsdt: BALANCE,
    answer: (input) => ({
      status: 'FILLED',
      order_id: '77123456',
      filled_price: '612.55',
      filled_qty: sizeOf(input),
      ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    }),
  })
  notifyStub = await startStub({
    price: PRICES.notify,
    payTo: PAY_TO.notify,
    answer: () => ({ delivered: true, channel: 'telegram', message_ref: '4521' }),
  })

  sloppy = await startAgent('research', '0.03')
  guardrail = await startAgent('risk', '0.02')
}, 180_000)

afterAll(async () => {
  for (const stub of stubs) stub.close()
  for (const service of services) await service.stop()
  if (SKIP) return
  await reset()
})

/**
 * A `data` output with a 24 h window this file chooses. Volatility stays under
 * Guardrail Risk's 3 % reduce rung, so the only thing that decides the outcome
 * is the sign of the change and the confidence the research Node answers with.
 */
function fixedMarket(change24hPct: number) {
  return {
    symbol: SYMBOL,
    price: '612.40',
    change_24h_pct: change24hPct,
    volatility_24h_pct: 1.2,
    ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  }
}

/** The quantity the executor pretends to have filled, from the size it was sent. */
function sizeOf(input: unknown): string {
  const size = (input as { size_usdt?: unknown } | null)?.size_usdt
  return typeof size === 'string' ? size : '0'
}

// -- seeding -----------------------------------------------------------------

interface NodeSpec {
  nodeType: AgentType
  provider: string
  price: string
  endpoint: string
  payTo: string
}

interface Seeded {
  runId: string
  callIds: Partial<Record<AgentType, string>>
}

async function seedRun(nodes: NodeSpec[]): Promise<Seeded> {
  const workflowId = newId('workflow')
  const runId = newId('run')
  const callIds: Partial<Record<AgentType, string>> = {}

  await db.insert(workflows).values({
    id: workflowId,
    accountId: sharedAccountId,
    name: 'Full chain',
    symbol: SYMBOL,
    orderCapUsdt: ORDER_CAP,
  })

  const lockNodes: PriceLock['nodes'] = []
  for (const [index, node] of nodes.entries()) {
    const listingId = newId('listing')
    const callId = newId('call')
    callIds[node.nodeType] = callId

    await db.insert(listings).values({
      id: listingId,
      creatorAccountId: sharedAccountId,
      name: node.provider,
      type: node.nodeType,
      endpoint: node.endpoint,
      declaredPrice: node.price,
      declaredStake: '100000',
      payoutWallet: node.payTo,
      status: 'active',
      price: node.price,
      stake: '300000',
    })
    await db.insert(workflowNodes).values({
      workflowId,
      nodeIndex: index,
      nodeType: node.nodeType,
      listingId,
    })
    lockNodes.push({
      node_index: index,
      node_type: node.nodeType,
      listing_id: listingId,
      provider: node.provider,
      price: node.price,
      asset: addresses!.tusd.toLowerCase(),
      network: 'eip155:97',
      pay_to: node.payTo,
    })

    // The Calls are inserted after the Run below; keep the ids for then.
  }

  const priceLock: PriceLock = {
    nodes: lockNodes,
    total: nodes.reduce((total, node) => total + BigInt(node.price), 0n).toString(),
    locked_at: new Date().toISOString(),
  }

  await db.insert(runs).values({
    id: runId,
    workflowId,
    accountId: sharedAccountId,
    walletId: payerWalletId,
    status: 'running',
    priceLock,
  })
  await db.insert(calls).values(
    nodes.map((node, index) => ({
      id: callIds[node.nodeType] as string,
      runId,
      kind: 'run' as const,
      listingId: lockNodes[index]!.listing_id,
      nodeIndex: index,
      nodeType: node.nodeType,
      status: 'pending' as const,
      lockedPrice: node.price,
      lockedPayTo: node.payTo,
      lockedAsset: addresses!.tusd.toLowerCase(),
      lockedNetwork: 'eip155:97',
    })),
  )

  return { runId, callIds }
}

function runEngine() {
  return createRunEngine({
    store: createRunStore(db),
    signing: engine.signing,
    chain: createChainReader({
      publicClient: createPublicChainClient({ chainId: CHAIN_ID, rpcUrls: [RPC_URL] }),
      addresses: addresses!,
    }),
    marketData: createMarketData(),
    agent: createAgentClient({ paidTimeoutMs: 15_000, unpaidTimeoutMs: 10_000 }),
    // AD-11: a real HTTP read of the execution Agent's `GET /internal/balance`.
    exchangeBalance: createExchangeBalance({ baseUrl: executionStub.url, internalToken: INTERNAL_TOKEN }),
    sameAddress: safeAddressEquals,
  })
}

async function readCall(callId: string) {
  const row = await db.query.calls.findFirst({ where: (t, { eq }) => eq(t.id, callId) })
  if (!row) throw new Error(`call ${callId} vanished`)
  return row
}

async function readRunRow(runId: string) {
  const row = await db.query.runs.findFirst({ where: (t, { eq }) => eq(t.id, runId) })
  if (!row) throw new Error(`run ${runId} vanished`)
  return row
}

function tokenBalance(address: string): Promise<bigint> {
  return createChainReader({
    publicClient: createPublicChainClient({ chainId: CHAIN_ID, rpcUrls: [RPC_URL] }),
    addresses: addresses!,
  }).tokenBalance(address as Hex)
}

async function balances(): Promise<Record<AgentType, bigint>> {
  const entries = await Promise.all(
    (Object.keys(PAY_TO) as AgentType[]).map(async (type) => [type, await tokenBalance(PAY_TO[type])] as const),
  )
  return Object.fromEntries(entries) as Record<AgentType, bigint>
}

// -- the two Runs -------------------------------------------------------------

describe.skipIf(SKIP !== null)(`the whole chain against ${RPC_URL}`, () => {
  it('pays two real Agents in sequence and skips the order the risk Agent refused', async () => {
    // A falling 24 h window, so Sloppy Research fades it into a LONG and
    // Guardrail Risk refuses a confident counter-trend signal. Both Agents are
    // real and both are paid; only the market they read is a fixture, because a
    // live 24 h window would make the decision under test depend on the day.
    const dataStub = await startStub({
      price: PRICES.data,
      payTo: PAY_TO.data,
      answer: () => fixedMarket(-2.5),
    })

    const before = await balances()
    const beforePayer = await tokenBalance(payerAddress)
    const seeded = await seedRun([
      { nodeType: 'data', provider: 'Binance Ticker', price: PRICES.data, endpoint: dataStub.url, payTo: PAY_TO.data },
      { nodeType: 'research', provider: 'Sloppy Research', price: PRICES.research, endpoint: `${sloppy.url}/`, payTo: PAY_TO.research },
      { nodeType: 'risk', provider: 'Guardrail Risk', price: PRICES.risk, endpoint: `${guardrail.url}/`, payTo: PAY_TO.risk },
      { nodeType: 'execution', provider: 'Binance Spot Executor', price: PRICES.execution, endpoint: executionStub.url, payTo: PAY_TO.execution },
      { nodeType: 'notify', provider: 'Telegram Notifier', price: PRICES.notify, endpoint: notifyStub.url, payTo: PAY_TO.notify },
    ])

    const outcome = await runEngine().execute({ run_id: seeded.runId })
    expect(outcome).toMatchObject({ outcome: 'ended', status: 'completed, no order' })

    const data = await readCall(seeded.callIds.data!)
    const research = await readCall(seeded.callIds.research!)
    const risk = await readCall(seeded.callIds.risk!)
    const execution = await readCall(seeded.callIds.execution!)
    const notify = await readCall(seeded.callIds.notify!)

    // Every paid Call has a hash that exists on the chain.
    expect(data.status).toBe('succeeded')
    expect(research.status).toBe('succeeded')
    for (const call of [data, research, risk, notify]) {
      expect(call.paymentTxHash).toMatch(/^0x[0-9a-f]{64}$/)
      const receipt = await publicClient.getTransactionReceipt({ hash: call.paymentTxHash as Hex })
      expect(receipt.status).toBe('success')
    }

    // PRD addendum §1: the research Node was sent the data Node's own output,
    // and the risk Node the research Node's signal and confidence.
    expect(research.request).toEqual({ symbol: SYMBOL, market: data.response })
    expect(research.response).toMatchObject({ signal: 'LONG', confidence: 0.9 })
    expect(risk.status).toBe('succeeded')
    expect(risk.request).toEqual({
      symbol: SYMBOL,
      signal: 'LONG',
      confidence: 0.9,
      proposed_size_usdt: ORDER_CAP,
      balance_usdt: BALANCE,
      market: data.response,
    })
    // FR-24: the real risk Agent refused, so the order is skipped.
    expect(risk.response).toMatchObject({ decision: 'REJECT', size_usdt: '0' })
    expect(execution.skipReason).toBe('reject')

    // FR-24: the skipped Node was never requested and never paid.
    expect(execution.status).toBe('skipped')
    expect(execution.request).toBeNull()
    expect(execution.paymentTxHash).toBeNull()
    expect(executionStub.requests).toHaveLength(0)

    // AD-4: the terminal filter still ran, and was paid, from the whole Run.
    expect(notify.status).toBe('succeeded')
    const message = notify.request as { summary: string; cost_table: { node: string; tx_hash?: string }[]; order?: unknown }
    expect(message.summary).toMatch(/, no order$/)
    expect(message.order).toBeUndefined()
    expect(message.cost_table.map((entry) => entry.node)).toEqual(['data', 'research', 'risk'])
    for (const entry of message.cost_table) expect(entry.tx_hash).toMatch(/^0x[0-9a-f]{64}$/)

    // The tUSD moved, to each payee, in exactly the amount its Price Lock fixed.
    const after = await balances()
    expect(after.data - before.data).toBe(BigInt(PRICES.data))
    expect(after.research - before.research).toBe(BigInt(PRICES.research))
    expect(after.risk - before.risk).toBe(BigInt(PRICES.risk))
    // The skipped Node's payout wallet saw nothing.
    expect(after.execution - before.execution).toBe(0n)
    expect(after.notify - before.notify).toBe(BigInt(PRICES.notify))
    const spent =
      BigInt(PRICES.data) + BigInt(PRICES.research) + BigInt(PRICES.risk) + BigInt(PRICES.notify)
    expect(beforePayer - (await tokenBalance(payerAddress))).toBe(spent)

    const run = await readRunRow(seeded.runId)
    expect(run.status).toBe('completed, no order')
    expect(run.failureReason).toBeNull()
  }, 180_000)

  it('carries a real risk decision into a real order and a real cost table', async () => {
    // A fixed market, so the real Guardrail Risk takes its "within risk limits"
    // rung rather than one of the two the live 24 h window might trigger.
    const market = fixedMarket(2.5)
    const dataStub = await startStub({ price: PRICES.data, payTo: PAY_TO.data, answer: () => market })
    const researchStub = await startStub({
      price: PRICES.research,
      payTo: PAY_TO.research,
      answer: () => ({ signal: 'LONG', confidence: 0.6, reason: 'Trend continuation above the 24 h midpoint.' }),
    })

    const before = await balances()
    const balanceReadsBefore = executionStub.balanceReads
    const seeded = await seedRun([
      { nodeType: 'data', provider: 'Binance Ticker', price: PRICES.data, endpoint: dataStub.url, payTo: PAY_TO.data },
      { nodeType: 'research', provider: 'Alpha Research', price: PRICES.research, endpoint: researchStub.url, payTo: PAY_TO.research },
      { nodeType: 'risk', provider: 'Guardrail Risk', price: PRICES.risk, endpoint: `${guardrail.url}/`, payTo: PAY_TO.risk },
      { nodeType: 'execution', provider: 'Binance Spot Executor', price: PRICES.execution, endpoint: executionStub.url, payTo: PAY_TO.execution },
      { nodeType: 'notify', provider: 'Telegram Notifier', price: PRICES.notify, endpoint: notifyStub.url, payTo: PAY_TO.notify },
    ])

    const outcome = await runEngine().execute({ run_id: seeded.runId })
    expect(outcome).toMatchObject({ outcome: 'ended', status: 'completed' })

    const risk = await readCall(seeded.callIds.risk!)
    const execution = await readCall(seeded.callIds.execution!)
    const notify = await readCall(seeded.callIds.notify!)

    // AD-11: the balance the risk Agent sized against came off the wire, once.
    expect(executionStub.balanceReads).toBe(balanceReadsBefore + 1)
    expect(risk.request).toMatchObject({ proposed_size_usdt: ORDER_CAP, balance_usdt: BALANCE, market })
    expect(risk.response).toMatchObject({ decision: 'APPROVE', size_usdt: ORDER_CAP })

    // PRD addendum §1: LONG becomes BUY, and the size is the risk Node's, not
    // the Order Cap it happens to equal here.
    expect(execution.request).toEqual({ symbol: SYMBOL, side: 'BUY', size_usdt: ORDER_CAP })
    expect(execution.status).toBe('succeeded')
    expect(execution.response).toMatchObject({ status: 'FILLED', filled_price: '612.55' })

    // FR-28 / FR-29: the message the Builder is sent lists what was paid, with
    // the hashes the chain produced, and the order that came back.
    const message = notify.request as {
      run_id: string
      recipient: { channel: string; address: string }
      summary: string
      cost_table: { node: string; provider: string; amount: string; tx_hash?: string }[]
      tx_hashes: string[]
      order?: unknown
    }
    expect(message.run_id).toBe(seeded.runId)
    expect(message.recipient).toEqual({ channel: 'telegram', address: '123456789' })
    expect(message.summary).toBe(`LONG ${SYMBOL}, approved at ${ORDER_CAP} USDT, filled at 612.55`)
    expect(message.order).toEqual(execution.response)
    expect(message.cost_table.map((entry) => [entry.node, entry.provider, entry.amount])).toEqual([
      ['data', 'Binance Ticker', '0.01'],
      ['research', 'Alpha Research', '0.03'],
      ['risk', 'Guardrail Risk', '0.02'],
      ['execution', 'Binance Spot Executor', '0.01'],
    ])
    expect(message.tx_hashes).toEqual([
      (await readCall(seeded.callIds.data!)).paymentTxHash,
      (await readCall(seeded.callIds.research!)).paymentTxHash,
      risk.paymentTxHash,
      execution.paymentTxHash,
    ])

    // Five Agents, five payouts, each at its own locked price.
    const after = await balances()
    for (const type of ['data', 'research', 'risk', 'execution', 'notify'] as const) {
      expect(after[type] - before[type]).toBe(BigInt(PRICES[type]))
    }
  }, 180_000)
})
