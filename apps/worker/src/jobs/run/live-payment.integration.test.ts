import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
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
import { newId, type PriceLock } from '@agent-desk/schemas'
import { safeAddressEquals } from './addresses.ts'
import { createAgentClient } from './agent-client.ts'
import { createRunEngine } from './engine.ts'
import { unconfiguredExchangeBalance } from './exchange-balance.ts'
import { createRunStore } from './store.ts'

/**
 * One paid Call, end to end, against a real chain.
 *
 * Everything else in this directory runs against doubles on purpose: the
 * failure paths AD-6 names — a 402 that does not match the Price Lock, a
 * timeout, a lost compare-and-set — are cheap to produce in memory and awkward
 * to produce on a chain. This file covers the one thing a double cannot prove,
 * which is that the handshake works at all: a real EIP-3009 authorization,
 * signed by the real signing service, relayed by the real facilitator, against
 * the real tUSD contract, for a real transaction hash.
 *
 * It starts the facilitator from `apps/facilitator` and the Binance Ticker
 * agent from `apps/agents/binance-ticker` as child processes rather than
 * importing them, because AD-1 forbids importing from an `apps/*` directory and
 * because that is how they run in `docker-compose.yml`.
 *
 * Nothing here touches a shared account. The relayer, the minter and the paying
 * wallet are all freshly generated keys funded through `anvil_setBalance`, and
 * both services listen on ports the test asks the kernel for, so another story
 * can be using the same chain at the same time.
 *
 * The suite skips cleanly when the RPC or Postgres is not reachable, which is
 * the CI case.
 *
 *   RPC_URLS=http://127.0.0.1:8545 CHAIN_ID=97
 */

const RPC_URL = process.env.TEST_RPC_URL ?? 'http://127.0.0.1:8545'
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/agentdesk_story16'

/** Must equal `LOCK_KEY` in `scripts/src/test-db.ts`; every truncating file shares it. */
const LOCK_KEY = 1_620_000_016

const CHAIN_ID = 97
const PRICE = '10000' // 0.01 tUSD at 6 decimals, the seed agent's AGENT_PRICE.
const MINT = 1_000_000n // 1 tUSD, well inside the contract's per-call cap.
const SYMBOL = 'BNBUSDT'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const TSX = resolve(REPO_ROOT, 'node_modules/.bin/tsx')
const FACILITATOR_ENTRY = resolve(REPO_ROOT, 'apps/facilitator/src/index.ts')
const AGENT_ENTRY = resolve(REPO_ROOT, 'apps/agents/binance-ticker/src/index.ts')

const publicClient = createPublicClient({ transport: http(RPC_URL) })

/** Everything this file needs from the outside world, or the reason it is skipped. */
async function preflight(): Promise<string | null> {
  try {
    const chainId = await publicClient.getChainId()
    if (chainId !== CHAIN_ID) return `the chain at ${RPC_URL} is ${chainId}, not ${CHAIN_ID}`
  } catch {
    return `no chain at ${RPC_URL}`
  }
  try {
    const addresses = assertDeployed(addressesFor(CHAIN_ID))
    const code = await publicClient.getCode({ address: addresses.tusd as Hex })
    if (!code || code === '0x') return `tUSD is not deployed at ${addresses.tusd}`
  } catch (error) {
    return `deployments/${CHAIN_ID}.json is not usable: ${(error as Error).message}`
  }
  try {
    await createDb({ url: TEST_DATABASE_URL, max: 1 }).execute(sql`select 1`)
  } catch {
    return `no database at ${TEST_DATABASE_URL}`
  }
  return null
}

const SKIP = await preflight()

const db: Database = createDb({ url: TEST_DATABASE_URL, max: 4 })
const holder: Database = createDb({ url: TEST_DATABASE_URL, max: 1 })

// -- child processes ---------------------------------------------------------

interface Service {
  port: number
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

async function startService(
  entry: string,
  env: Record<string, string>,
  port: number,
  healthPath = '/health',
): Promise<Service> {
  const child = spawn(TSX, [entry], {
    cwd: REPO_ROOT,
    // A curated environment: the shell's own RPC_URLS or CHAIN_ID must not
    // reach a service this test is pointing at a local chain.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })

  const url = `http://127.0.0.1:${port}`
  try {
    await waitForHealth(`${url}${healthPath}`, child, () => output)
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }

  return {
    port,
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

// -- fixtures ----------------------------------------------------------------

let engine: Engine
let facilitator: Service
let agent: Service
let payerWalletId: string
let payerAddress: string
/** One account and one wallet for the whole file: `wallets_address_key` is
 *  unique on the address, and every Run here is paid by the same funded key. */
let sharedAccountId: string
const stubs: Server[] = []

const addresses = SKIP ? null : assertDeployed(addressesFor(CHAIN_ID))

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

beforeAll(async () => {
  if (SKIP) return
  await holder.execute(sql`select pg_advisory_lock(${LOCK_KEY})`)
  await reset()

  const relayer = await fundedKey()
  const minter = await fundedKey()

  const facilitatorPort = await freePort()
  facilitator = await startService(FACILITATOR_ENTRY, {
    CHAIN_ID: String(CHAIN_ID),
    RPC_URLS: RPC_URL,
    FACILITATOR_RELAYER_KEY: relayer.key,
    FACILITATOR_PORT: String(facilitatorPort),
    FACILITATOR_URL: `http://127.0.0.1:${facilitatorPort}`,
    LOG_LEVEL: 'warn',
  }, facilitatorPort)

  const agentPort = await freePort()
  agent = await startService(AGENT_ENTRY, {
    AGENT_PORT: String(agentPort),
    AGENT_PRICE: '0.01',
    AGENT_PAYTO: PAY_TO,
    FACILITATOR_URL: facilitator.url,
    INTERNAL_TOKEN: 'live-payment-test',
    CHAIN_ID: String(CHAIN_ID),
    LOG_LEVEL: 'warn',
  }, agentPort)

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
  })
  await db.insert(wallets).values({
    id: payerWalletId,
    accountId: sharedAccountId,
    address: payerAddress,
    encryptedKey: generated.encryptedKey,
    readyAt: new Date(),
  })

  // tUSD for the payer. `mint` is open on the local deployment; the paying
  // wallet itself needs no BNB, because AD-6 has the facilitator relay.
  const wallet = createWalletClient({
    account: privateKeyToAccount(minter.key),
    chain: { id: CHAIN_ID, name: 'local', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } },
    transport: http(RPC_URL),
  })
  const mint = createContractCalls(addresses!).tusdMint(payerAddress, MINT)
  const mintHash = await wallet.sendTransaction({ to: mint.to as Hex, data: mint.data })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: mintHash })
  if (receipt.status !== 'success') throw new Error('minting tUSD to the paying wallet reverted')
}, 90_000)

afterAll(async () => {
  for (const stub of stubs) stub.close()
  await agent?.stop()
  await facilitator?.stop()
  if (SKIP) return
  await reset()
  await holder.execute(sql`select pg_advisory_unlock(${LOCK_KEY})`)
})

/** The address every 402 in this file pays to; asserted against on chain. */
const PAY_TO = '0x00000000000000000000000000000000000000aa'

interface Seeded {
  runId: string
  callId: string
  accountId: string
}

/** One Listing, one Node, and one running Run for the shared account and wallet. */
async function seedRun(endpoint: string): Promise<Seeded> {
  const accountId = sharedAccountId
  const workflowId = newId('workflow')
  const listingId = newId('listing')
  const runId = newId('run')
  const callId = newId('call')

  await db.insert(listings).values({
    id: listingId,
    creatorAccountId: accountId,
    name: 'Binance Ticker',
    type: 'data',
    endpoint,
    declaredPrice: PRICE,
    declaredStake: '100000',
    payoutWallet: PAY_TO,
    status: 'active',
    price: PRICE,
    stake: '300000',
  })
  await db.insert(workflows).values({ id: workflowId, accountId, name: 'Live', symbol: SYMBOL })
  await db.insert(workflowNodes).values({ workflowId, nodeIndex: 0, nodeType: 'data', listingId })

  const priceLock: PriceLock = {
    nodes: [
      {
        node_index: 0,
        node_type: 'data',
        listing_id: listingId,
        provider: 'Binance Ticker',
        price: PRICE,
        asset: addresses!.tusd.toLowerCase(),
        network: 'eip155:97',
        pay_to: PAY_TO,
      },
    ],
    total: PRICE,
    locked_at: new Date().toISOString(),
  }

  await db.insert(runs).values({
    id: runId,
    workflowId,
    accountId,
    walletId: payerWalletId,
    status: 'running',
    priceLock,
  })
  await db.insert(calls).values({
    id: callId,
    runId,
    kind: 'run',
    listingId,
    nodeIndex: 0,
    nodeType: 'data',
    status: 'pending',
    lockedPrice: PRICE,
    lockedPayTo: PAY_TO,
    lockedAsset: addresses!.tusd.toLowerCase(),
    lockedNetwork: 'eip155:97',
  })

  return { runId, callId, accountId }
}

function runEngine(paidTimeoutMs = 15_000) {
  return createRunEngine({
    store: createRunStore(db),
    signing: engine.signing,
    chain: createChainReader({
      publicClient: createPublicChainClient({ chainId: CHAIN_ID, rpcUrls: [RPC_URL] }),
      addresses: addresses!,
    }),
    marketData: createMarketData(),
    agent: createAgentClient({ paidTimeoutMs, unpaidTimeoutMs: 10_000 }),
    // No `risk` Node in this file, so the port is never called. The multi-node
    // chain in `full-chain.integration.test.ts` reads a real one.
    exchangeBalance: unconfiguredExchangeBalance('no execution Agent in this test'),
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

describe.skipIf(SKIP !== null)(`one paid Call against ${RPC_URL}`, () => {
  it('pays the Agent, records a real transaction hash, and completes the Run', async () => {
    const before = await tokenBalance(PAY_TO)
    const beforePayer = await tokenBalance(payerAddress)
    const seeded = await seedRun(`${agent.url}/`)

    const outcome = await runEngine().execute({ run_id: seeded.runId })
    expect(outcome).toMatchObject({ outcome: 'ended', status: 'completed' })

    const call = await readCall(seeded.callId)
    expect(call.status).toBe('succeeded')
    expect(call.attempt).toBe(1)

    // The 402 the agent actually served, stored verbatim.
    expect(call.paymentRequired).toMatchObject({
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:97',
          amount: PRICE,
          payTo: PAY_TO,
          maxTimeoutSeconds: 15,
          extra: { name: 'tUSD', version: '1' },
        },
      ],
    })

    // AD-6: the hash comes from `PAYMENT-RESPONSE`, and it is a hash that exists.
    expect(call.paymentTxHash).toMatch(/^0x[0-9a-f]{64}$/)
    const receipt = await publicClient.getTransactionReceipt({ hash: call.paymentTxHash as Hex })
    expect(receipt.status).toBe('success')
    expect(receipt.to?.toLowerCase()).toBe(addresses!.tusd.toLowerCase())

    // The tUSD actually moved, in the amount the Price Lock fixed.
    expect(await tokenBalance(PAY_TO)).toBe(before + BigInt(PRICE))
    expect(await tokenBalance(payerAddress)).toBe(beforePayer - BigInt(PRICE))

    // AD-6: the EIP-3009 nonce this Call signed is now spent on chain.
    const payload = call.paymentPayload as { from: string; nonce: string }
    expect(
      await createChainReader({
        publicClient: createPublicChainClient({ chainId: CHAIN_ID, rpcUrls: [RPC_URL] }),
        addresses: addresses!,
      }).authorizationUsed(payload.from as Hex, payload.nonce as Hex),
    ).toBe(true)
    expect(payload.from).toBe(payerAddress)

    // The Agent's answer, validated against the `data` output schema before it
    // was stored, and the Run's own end.
    expect(call.response).toMatchObject({ symbol: SYMBOL })
    const run = await readRunRow(seeded.runId)
    expect(run.status).toBe('completed')
    expect(run.startedAt).not.toBeNull()
    expect(run.endedAt).not.toBeNull()
    expect(run.failureReason).toBeNull()

    // AD-9: Binance production market data is a live dependency, so null is a
    // correct outcome; what must hold is that a price is a decimal with a time.
    if (call.referencePrice !== null) {
      expect(call.referencePrice).toMatch(/^\d+(\.\d+)?$/)
      expect(call.referenceAt).not.toBeNull()
    }
  }, 60_000)

  it('records payment_failed when the authorization was never relayed', async () => {
    // A 402 that matches the Price Lock exactly, so the engine signs a real
    // EIP-3009 authorization, and then a paid request that never answers. The
    // facilitator never sees it, so the nonce stays unspent — and that is what
    // the engine has to read off the chain rather than assume.
    const stub = await startStub({ answerPaid: 'hang' })
    const before = await tokenBalance(PAY_TO)
    const seeded = await seedRun(stub.url)

    const outcome = await runEngine(1_500).execute({ run_id: seeded.runId })
    expect(outcome).toMatchObject({ outcome: 'ended', status: 'failed at data' })

    const call = await readCall(seeded.callId)
    expect(call.status).toBe('payment_failed')
    expect(call.attempt).toBe(2) // AD-6: a timeout is retried exactly once.
    expect(call.paymentTxHash).toBeNull()
    expect(call.failureReason).toContain('the tUSD authorization is unused')

    const payload = call.paymentPayload as { from: string; nonce: string }
    expect(
      await createChainReader({
        publicClient: createPublicChainClient({ chainId: CHAIN_ID, rpcUrls: [RPC_URL] }),
        addresses: addresses!,
      }).authorizationUsed(payload.from as Hex, payload.nonce as Hex),
    ).toBe(false)
    expect(await tokenBalance(PAY_TO)).toBe(before)
  }, 60_000)

  it('records failed_after_payment when the settled response is lost', async () => {
    // The real agent and the real facilitator, behind a proxy that drops the
    // response after it has been produced. The transfer lands; the engine never
    // learns the hash. AD-6 says that is `failed_after_payment` with a null
    // hash, and the only way to tell it apart from the case above is the chain.
    const proxy = await startStub({ answerPaid: 'drop', forwardTo: agent.url })
    const before = await tokenBalance(PAY_TO)
    const seeded = await seedRun(proxy.url)

    const outcome = await runEngine(20_000).execute({ run_id: seeded.runId })
    expect(outcome).toMatchObject({ outcome: 'ended', status: 'failed at data' })

    const call = await readCall(seeded.callId)
    expect(call.status).toBe('failed_after_payment')
    expect(call.paymentTxHash).toBeNull()
    expect(call.failureReason).toContain('the tUSD authorization is used')

    // The money moved even though the Call failed, which is the whole point.
    expect(await tokenBalance(PAY_TO)).toBe(before + BigInt(PRICE))
    const payload = call.paymentPayload as { from: string; nonce: string }
    expect(
      await createChainReader({
        publicClient: createPublicChainClient({ chainId: CHAIN_ID, rpcUrls: [RPC_URL] }),
        addresses: addresses!,
      }).authorizationUsed(payload.from as Hex, payload.nonce as Hex),
    ).toBe(true)
  }, 90_000)
})

// -- the two stand-ins for a misbehaving Agent --------------------------------

interface StubOptions {
  /** `hang`: never answer a paid request. `drop`: answer it, then cut the socket. */
  answerPaid: 'hang' | 'drop'
  /** When set, the paid request is forwarded here first, so a real payment settles. */
  forwardTo?: string
}

/**
 * Serves the same 402 the Binance Ticker agent serves, so the Price Lock
 * comparison passes and a real authorization is signed, then misbehaves on the
 * paid request in one of the two ways AD-6 distinguishes.
 */
async function startStub(options: StubOptions): Promise<{ url: string }> {
  const port = await freePort()
  const paymentRequired = {
    x402Version: 2,
    error: 'Payment required',
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:97',
        amount: PRICE,
        asset: addresses!.tusd.toLowerCase(),
        payTo: PAY_TO,
        maxTimeoutSeconds: 15,
        extra: { name: 'tUSD', version: '1' },
      },
    ],
  }

  const server = createHttpServer((req, res) => {
    const signature = req.headers['payment-signature']
    if (!signature) {
      res.writeHead(402, {
        'content-type': 'application/json',
        'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(paymentRequired)).toString('base64'),
      })
      res.end('{}')
      return
    }
    if (options.answerPaid === 'hang') return // Never answers; the client times out.

    // Let the real agent and the real facilitator settle, then drop the answer.
    const body: Buffer[] = []
    req.on('data', (chunk: Buffer) => body.push(chunk))
    req.on('end', () => {
      const target = new URL(options.forwardTo as string)
      const upstream = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: '/',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'payment-signature': signature as string,
          },
        },
        (upstreamRes) => {
          upstreamRes.resume()
          upstreamRes.on('end', () => res.socket?.destroy())
        },
      )
      upstream.on('error', () => res.socket?.destroy())
      upstream.end(Buffer.concat(body))
    })
  })

  await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok))
  stubs.push(server)
  return { url: `http://127.0.0.1:${port}/` }
}
