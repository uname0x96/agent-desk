import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { createWalletClient, http, parseEther, toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  addressesFor,
  assertDeployed,
  chainFor,
  createChainReader,
  createPublicChainClient,
  tusdAbi,
  type ContractAddresses,
} from '@agent-desk/adapters/chain'
import {
  accounts,
  calls,
  chainTx,
  createDb,
  listings,
  platformSettings,
  settlements,
  stakeReservationForListing,
  verificationSpendLast24h,
  type Database,
} from '@agent-desk/db'
import { createEngine, type Engine } from '@agent-desk/scripts/wiring'
import { importPlatformWallet } from '@agent-desk/scripts/platform-wallet'
import { intentKeys, newId, toDecimalUsdt } from '@agent-desk/schemas'
import { buildListingVerify } from './wiring.ts'
import { VERIFICATION_CAP_REACHED } from './verification.ts'

/**
 * Story 3.4 / FR-11 end to end: a real paid verification Call, against a real
 * Agent, a real facilitator, a real chain and a real database.
 *
 * `verification.test.ts` proves the decisions — the comparison, the wording, the
 * retry rule, the cap, redelivery — with the socket faked. What no fake can
 * answer is whether the Platform Wallet's signature is one the facilitator will
 * settle, whether the tUSD actually moves from the platform to the Creator's
 * payout wallet, and whether the whole beat from a `verifying` row to `active`
 * fits in the 30 seconds Story 3.7 promises on a projector. That is this file.
 *
 * It needs more than the other integration tests: a development node, the
 * facilitator, and a live Agent to call. Point `TEST_AGENT_URL` at one — its
 * `GET /schema` supplies the Type, the price and the payout wallet, so the
 * Listing under test is built from the very values the Agent's 402 will state:
 *
 *   env RPC_URLS=http://127.0.0.1:8545 AGENT_PORT=4103 AGENT_PRICE=0.03 \
 *     AGENT_PAYTO=0x... pnpm --filter @agent-desk/agent-sloppy-research start
 *   TEST_AGENT_URL=http://127.0.0.1:4103 pnpm vitest run verification.integration
 *
 * Without any of that the suite skips with the reason in its name, because CI
 * has neither a chain nor an Agent.
 */

const RPC_URL = process.env.TEST_RPC_URL ?? 'http://127.0.0.1:8545'
const CHAIN_ID = Number(process.env.TEST_CHAIN_ID ?? '97')
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/agentdesk_story16'
const FACILITATOR_URL = process.env.TEST_FACILITATOR_URL ?? 'http://127.0.0.1:4020'
const AGENT_URL = process.env.TEST_AGENT_URL ?? 'http://127.0.0.1:4103'

/** The same advisory lock every integration test in this repository takes. */
const LOCK_KEY = 1_620_000_016

/** 100 tUSD, the `DEMO_MINT_AMOUNT` default, minted to the Creator by `wallet.create`. */
const DEMO_MINT = 100_000_000n
/** `TUSD.MINT_CAP`: the most one `mint` call may create. */
const PLATFORM_MINT = 1_000_000_000n

const MASTER_KEY = randomBytes(32).toString('hex')

const SKIP_REASON = await unavailableReason()
const db: Database = createDb({ url: TEST_DATABASE_URL, max: 4 })
const holder: Database = createDb({ url: TEST_DATABASE_URL, max: 1 })

/** The Agent's own `GET /schema`, which is what the Listing is built from. */
interface AgentSchema {
  type: 'data' | 'research' | 'risk' | 'execution' | 'notify'
  payment: { amount: string; payTo: string; asset: string; network: string }
}

const title = 'the paid verification Call against a live Agent'
describe.skipIf(SKIP_REASON !== null)(
  SKIP_REASON === null ? `${title} at ${AGENT_URL}` : `${title} — skipped: ${SKIP_REASON}`,
  () => {
    let addresses: ContractAddresses
    let reader: ReturnType<typeof createChainReader>
    let engine: Engine
    let runListingVerify: ReturnType<typeof buildListingVerify>
    let agent: AgentSchema
    let creatorAccountId: string
    let platformAddress: string

    beforeAll(async () => {
      addresses = assertDeployed(addressesFor(CHAIN_ID))
      const publicClient = createPublicChainClient({ chainId: CHAIN_ID, rpcUrls: [RPC_URL] })
      reader = createChainReader({ publicClient, addresses })
      agent = (await fetchJson(`${AGENT_URL}/schema`)) as AgentSchema

      await holder.execute(sql`select pg_advisory_lock(${LOCK_KEY})`)
      // `demo` is what makes `wallet.create` mint the tUSD the Stake needs.
      await resetDatabase({ mode: 'demo' })

      // A Platform Wallet of this test's own, funded on the node and given tUSD
      // to pay verification Calls with. Spending the one in `.env` would make
      // the test depend on a balance somebody else maintains.
      const platformKey = generatePrivateKey()
      platformAddress = privateKeyToAccount(platformKey).address.toLowerCase()
      await rpc('anvil_setBalance', [platformAddress, toHex(parseEther('1000'))])
      await mintTusd(platformAddress, PLATFORM_MINT)
      const platform = await importPlatformWallet({
        db,
        platformWalletKey: platformKey,
        masterKey: MASTER_KEY,
      })

      engine = createEngine({
        db,
        chainId: CHAIN_ID,
        rpcUrls: [RPC_URL],
        masterKey: MASTER_KEY,
        platformWalletId: platform.walletId,
        walletGasFloor: '0.05',
        platformWalletBnbFloor: '0.1',
        creatorWalletBnbFloor: '0.01',
        demoMintAmount: DEMO_MINT,
      })

      runListingVerify = buildListingVerify({
        db,
        engine,
        chainId: CHAIN_ID,
        rpcUrls: [RPC_URL],
        facilitatorUrl: FACILITATOR_URL,
        publicBaseUrl: 'https://desk.example',
      })

      creatorAccountId = await insertAccount()
      let wallet = await engine.runWalletCreate({ account_id: creatorAccountId })
      if (!wallet.ok && wallet.failedAt === 'approve') {
        // The same `wallet.create` defect Story 1.7's integration test documents:
        // in demo mode the mint spends the gas the top-up just granted, and the
        // approve is held to the same floor. Fund and resume, which is also the
        // redelivery path `wallet.create` promises.
        await rpc('anvil_setBalance', [wallet.address, toHex(parseEther('1'))])
        await db.delete(chainTx).where(eq(chainTx.intentKey, intentKeys.approve(wallet.walletId)))
        wallet = await engine.runWalletCreate({ account_id: creatorAccountId })
      }
      expect(wallet, `wallet.create failed: ${JSON.stringify(wallet)}`).toMatchObject({ ok: true })
    }, 180_000)

    afterAll(async () => {
      await resetDatabase({ mode: 'production' })
      await holder.execute(sql`select pg_advisory_unlock(${LOCK_KEY})`)
    })

    describe('a Listing with no skip_verification, from verifying to active', () => {
      let listingId: string
      let elapsedMs: number
      let result: Awaited<ReturnType<typeof runListingVerify>>
      let platformBefore: bigint
      let payoutBefore: bigint

      beforeAll(async () => {
        listingId = await insertListing()
        platformBefore = await reader.tokenBalance(platformAddress)
        payoutBefore = await reader.tokenBalance(agent.payment.payTo)

        const startedAt = Date.now()
        result = await runListingVerify({ listing_id: listingId })
        elapsedMs = Date.now() - startedAt
        // The number Story 3.4 and Story 3.7 are measured against, on the record.
        console.log(
          `[story 3.4] verify -> identity -> list -> active in ${elapsedMs} ms ` +
            `for a ${agent.type} Listing at ${toDecimalUsdt(agent.payment.amount)} tUSD`,
        )
      }, 180_000)

      it('reaches active through all three steps, the first one really paid', () => {
        expect(result).toMatchObject({
          ok: true,
          outcome: 'listed',
          status: 'active',
          // `sent`, not `skipped`: this Listing paid for its verification.
          steps: { verification: 'sent', identity: 'sent', list: 'sent' },
        })
      })

      it('completes the whole beat well inside the 30 s the demo promises', () => {
        expect(elapsedMs).toBeLessThan(30_000)
      })

      it('wrote one verification Call with the declared terms and a settled payment', async () => {
        const row = await verificationCall(listingId)

        expect(row).toMatchObject({
          kind: 'verification',
          // AD-3: a verification Call belongs to a Listing, not to a Run.
          runId: null,
          listingId,
          nodeType: agent.type,
          status: 'succeeded',
          lockedPrice: agent.payment.amount,
          lockedPayTo: agent.payment.payTo.toLowerCase(),
          lockedAsset: addresses.tusd.toLowerCase(),
          lockedNetwork: `eip155:${CHAIN_ID}`,
          attempt: 1,
          failureReason: null,
        })
        expect(row.paymentTxHash).toMatch(/^0x[0-9a-f]{64}$/)
        expect(row.startedAt).not.toBeNull()
        expect(row.endedAt).not.toBeNull()
        // The 402 the Agent answered with is on the row, whether it matched or not.
        expect(row.paymentRequired).toMatchObject({ accepts: expect.any(Array) })
      })

      it('settled that payment on chain, from the Platform Wallet to the payout wallet', async () => {
        const row = await verificationCall(listingId)
        const publicClient = createPublicChainClient({ chainId: CHAIN_ID, rpcUrls: [RPC_URL] })
        const receipt = await publicClient.getTransactionReceipt({
          hash: row.paymentTxHash as Hex,
        })
        expect(receipt.status).toBe('success')

        const price = BigInt(agent.payment.amount)
        expect((await reader.tokenBalance(agent.payment.payTo)) - payoutBefore).toBe(price)
        expect(platformBefore - (await reader.tokenBalance(platformAddress))).toBe(price)
      })

      it('never scores that Call and never reserves Stake for it', async () => {
        const row = await verificationCall(listingId)

        // AD-9 settles `kind = 'run'` `research` and `risk` Calls; a verification
        // Call is neither, so no settlement row exists for it and none ever will.
        const scored = await db.select().from(settlements).where(eq(settlements.callId, row.id))
        expect(scored).toEqual([])

        // FR-25 / AD-3: the Stake reservation query counts `kind = 'run'` Calls
        // only. This is the assertion that stops a brand-new Listing being
        // slashed for its own verification — the Call is `succeeded` and paid,
        // and the reservation is still nothing.
        expect(await stakeReservationForListing(db, listingId)).toBe(0n)
      })

      it('counts the Call against the Platform Wallet 24 h verification cap', async () => {
        // AD-3: the cap is a query over `kind = 'verification'` Calls, and the
        // Call this job just paid is exactly what it counts.
        expect(await verificationSpendLast24h(db)).toBe(BigInt(agent.payment.amount))
      })

      it('minted the identity and the Registry entry only after that Call', async () => {
        const rows = await db.select().from(chainTx)
        const forListing = rows.filter((row) => row.intentKey.endsWith(listingId))
        expect(forListing.map((row) => row.intentKey).sort()).toEqual([
          intentKeys.identity(listingId),
          intentKeys.list(listingId),
        ])
        for (const row of forListing) expect(row.status).toBe('confirmed')

        const [listing] = await db.select().from(listings).where(eq(listings.id, listingId))
        expect(listing?.status).toBe('active')
        expect(listing?.lastError).toBeNull()
        expect(listing?.agentId).toMatch(/^\d+$/)

        // AD-2: the cache is the Registry, value for value.
        const onChain = await reader.getListing(BigInt(listing!.registryListingId!))
        expect(listing?.price).toBe(onChain.price.toString())
        expect(listing?.stake).toBe(onChain.stake.toString())
        expect(listing?.payoutWallet).toBe(onChain.payTo.toLowerCase())
      })

      it('pays nothing the second time the job is delivered', async () => {
        const before = await verificationCall(listingId)
        const again = await runListingVerify({ listing_id: listingId })

        expect(again).toMatchObject({ ok: true, outcome: 'already_listed', status: 'active' })
        const after = await db
          .select()
          .from(calls)
          .where(and(eq(calls.listingId, listingId), eq(calls.kind, 'verification')))
        expect(after).toHaveLength(1)
        expect(after[0]?.paymentTxHash).toBe(before.paymentTxHash)
      }, 60_000)
    })

    describe('an endpoint whose 402 does not match what the Creator declared', () => {
      it('refuses with both amounts and mints nothing', async () => {
        // Ten times the Agent's real price. The 402 will state the Agent's, so
        // the comparison fails on `amount` and nothing is ever signed.
        const declared = (BigInt(agent.payment.amount) * 10n).toString()
        const listingId = await insertListing({ price: declared })

        const outcome = await runListingVerify({ listing_id: listingId })

        expect(outcome).toMatchObject({
          ok: false,
          outcome: 'failed',
          failedAt: 'verification',
          reason:
            `402 amount ${toDecimalUsdt(agent.payment.amount)} tUSD differs from declared ` +
            `${toDecimalUsdt(declared)} tUSD`,
        })

        const [listing] = await db.select().from(listings).where(eq(listings.id, listingId))
        expect(listing?.status).toBe('failed')
        expect(listing?.lastError).toContain('402 amount')

        const row = await verificationCall(listingId)
        expect(row.status).toBe('price_mismatch')
        expect(row.paymentTxHash).toBeNull()

        // The point of FR-11: no identity, no Registry entry, no Stake moved.
        const rows = await db.select().from(chainTx)
        expect(rows.filter((row) => row.intentKey.endsWith(listingId))).toEqual([])
        expect(listing?.agentId).toBeNull()
      }, 60_000)
    })

    describe('the Platform Wallet 24 h verification cap', () => {
      it('refuses before the endpoint is touched at all', async () => {
        await db.update(platformSettings).set({ verificationCapDaily: '0' })
        const listingId = await insertListing()

        try {
          const outcome = await runListingVerify({ listing_id: listingId })

          expect(outcome).toMatchObject({
            ok: false,
            outcome: 'failed',
            failedAt: 'verification',
            reason: VERIFICATION_CAP_REACHED,
          })
          const [listing] = await db.select().from(listings).where(eq(listings.id, listingId))
          expect(listing?.lastError).toBe(VERIFICATION_CAP_REACHED)

          // No Call row at all: an exhausted cap costs the platform nothing,
          // not even a request to the endpoint.
          const rows = await db
            .select()
            .from(calls)
            .where(and(eq(calls.listingId, listingId), eq(calls.kind, 'verification')))
          expect(rows).toEqual([])
        } finally {
          await db.update(platformSettings).set({ verificationCapDaily: '5000000' })
        }
      }, 60_000)
    })

    // ------------------------------------------------------------- fixtures

    async function insertAccount(): Promise<string> {
      const id = newId('account')
      await db.insert(accounts).values({ id, email: `${id}@test.local`, passwordHash: '!' })
      return id
    }

    /**
     * A Listing of the Agent under test, built from its own `GET /schema`, so the
     * declared terms and the 402 agree by construction and the test is not
     * pinned to one Agent's price.
     */
    async function insertListing(options: { price?: string } = {}): Promise<string> {
      const id = newId('listing')
      const price = options.price ?? agent.payment.amount
      await db.insert(listings).values({
        id,
        creatorAccountId,
        name: 'Live verification subject',
        description: 'Listed through a real paid verification Call.',
        type: agent.type,
        endpoint: AGENT_URL,
        declaredPrice: price,
        declaredStake: (BigInt(price) * 10n).toString(),
        payoutWallet: agent.payment.payTo.toLowerCase(),
        status: 'verifying',
        // The whole point of this file: no skip.
        skipVerification: false,
      })
      return id
    }

    async function verificationCall(listingId: string) {
      const [row] = await db
        .select()
        .from(calls)
        .where(and(eq(calls.listingId, listingId), eq(calls.kind, 'verification')))
        .limit(1)
      if (!row) throw new Error(`no verification Call for ${listingId}`)
      return row
    }

    async function mintTusd(to: string, amount: bigint): Promise<void> {
      const funder = generatePrivateKey()
      const account = privateKeyToAccount(funder)
      await rpc('anvil_setBalance', [account.address, toHex(parseEther('10'))])
      const wallet = createWalletClient({
        account,
        chain: chainFor(CHAIN_ID),
        transport: http(RPC_URL),
      })
      const hash = await wallet.writeContract({
        address: assertDeployed(addressesFor(CHAIN_ID)).tusd as Hex,
        abi: tusdAbi,
        functionName: 'mint',
        args: [to as Hex, amount],
      })
      const publicClient = createPublicChainClient({ chainId: CHAIN_ID, rpcUrls: [RPC_URL] })
      await publicClient.waitForTransactionReceipt({ hash })
    }
  },
)

// --------------------------------------------------------------- environment

async function resetDatabase(options: { mode: 'demo' | 'production' }): Promise<void> {
  await db.execute(sql`
    truncate chain_tx, settlements, calls, runs, workflow_nodes, workflows, listings, wallets, accounts
    restart identity cascade
  `)
  await db
    .insert(platformSettings)
    .values({
      id: 1,
      mode: options.mode,
      emergencyStop: false,
      orderCeilingUsdt: '1000',
      defaultDailyFeeBudget: '1000000',
      verificationCapDaily: '5000000',
    })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: {
        mode: options.mode,
        emergencyStop: false,
        platformAccountId: null,
        verificationCapDaily: '5000000',
      },
    })
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
  const body = (await response.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result as T
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

/**
 * Everything this suite needs, checked before it runs, so a missing piece reads
 * as one skipped suite naming what is missing rather than a wall of failures.
 */
async function unavailableReason(): Promise<string | null> {
  let addresses: ContractAddresses
  try {
    addresses = assertDeployed(addressesFor(CHAIN_ID))
  } catch (error) {
    return message(error)
  }

  try {
    const chainId = Number(await rpc<string>('eth_chainId', []))
    if (chainId !== CHAIN_ID) {
      return `the node at ${RPC_URL} is chain ${chainId}, not ${CHAIN_ID}`
    }
    for (const [name, address] of Object.entries(addresses)) {
      if ((await rpc<string>('eth_getCode', [address, 'latest'])) === '0x') {
        return `no contract code for ${name} at ${address} on ${RPC_URL}`
      }
    }
    // A real network would refuse this, and so it should: the fixture funds its
    // own wallets and mints its own tUSD, and must never run against one.
    await rpc('anvil_setBalance', [`0x${'0'.repeat(36)}dead`, '0x1'])
  } catch (error) {
    return `${RPC_URL} is not a usable development node: ${message(error)}`
  }

  try {
    const health = (await fetchJson(`${FACILITATOR_URL}/health`)) as { status?: string }
    if (health.status !== 'ok') return `the facilitator at ${FACILITATOR_URL} is not healthy`
  } catch (error) {
    return `no facilitator at ${FACILITATOR_URL}: ${message(error)}`
  }

  try {
    const schema = (await fetchJson(`${AGENT_URL}/schema`)) as Partial<AgentSchema>
    if (!schema.payment?.payTo) return `the Agent at ${AGENT_URL} published no payment terms`
  } catch (error) {
    return `no Agent at ${AGENT_URL}: ${message(error)}`
  }

  try {
    const probe = createDb({ url: TEST_DATABASE_URL, max: 1 })
    await probe.execute(sql`select 1`)
  } catch {
    return `no database at ${TEST_DATABASE_URL}`
  }

  return null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
