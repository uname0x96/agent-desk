import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accounts,
  calls,
  chainTx,
  createDb,
  listings,
  platformSettings,
  wallets,
  type Database,
} from '@agent-desk/db'
import { intentKeys, newId, type CreateListingRequest } from '@agent-desk/schemas'
import { createListing } from './create-listing.ts'
import { listingDetailResponse } from './listing-progress.ts'

/**
 * `POST /api/listings` and `GET /api/listings/<id>` against real Postgres
 * (Story 3.3, FR-10, FR-14).
 *
 * The field rules are unit-tested next door with no database in sight; what can
 * only be wrong in SQL is here — that a refused submission writes no row at all,
 * that the row the pipeline picks up carries base units and lower-case
 * addresses, that `skip_verification` is set for exactly one Type, and that the
 * progress body a listing page polls is really assembled from the rows the
 * pipeline writes.
 *
 * The database is the one every other integration test truncates, so this file
 * takes the same session advisory lock; the key has to stay equal to `LOCK_KEY`
 * in `app/api/runs/runs.integration.test.ts` and `scripts/src/test-db.ts`.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/agentdesk_story16'

// `readListingDetail` reads through the process-wide `db()`, which is built from
// `DATABASE_URL` on first use — so it is pointed at the test database here,
// before anything imports it.
process.env.DATABASE_URL = TEST_DATABASE_URL

const LOCK_KEY = 1_620_000_016

async function reachable(): Promise<boolean> {
  try {
    const probe = createDb({ url: TEST_DATABASE_URL, max: 1 })
    await probe.execute('select 1')
    return true
  } catch {
    return false
  }
}

const HAVE_POSTGRES = await reachable()
const db: Database = createDb({ url: TEST_DATABASE_URL, max: 6 })
const holder: Database = createDb({ url: TEST_DATABASE_URL, max: 1 })

const { readListingDetail } = await import('./listing-detail.ts')

const PAYOUT = '0xf6e3a69beb0f05ced82c99c4dc4989bef8fa82c4'
const HASH_IDENTITY = `0x${'a1'.repeat(32)}`
const HASH_LIST = `0x${'b2'.repeat(32)}`
const HASH_PAYMENT = `0x${'c3'.repeat(32)}`

const SUBMISSION: CreateListingRequest = {
  name: 'Sloppy Research',
  type: 'research',
  endpoint: 'http://host.docker.internal:4103',
  price: '0.03',
  stake: '0.3',
  description: 'Fast, cheap, and wrong about a fifth of the time.',
}

/** Every `listing_id` handed to pg-boss, so "published exactly once" is checkable. */
let published: string[] = []

function deps() {
  return {
    db,
    publish: async (listingId: string) => {
      published.push(listingId)
    },
  }
}

let addressCounter = 0
function nextAddress(): string {
  addressCounter += 1
  return `0x${addressCounter.toString(16).padStart(40, '0')}`
}

async function insertAccount(): Promise<string> {
  const id = newId('account')
  await db.insert(accounts).values({ id, email: `${id}@test.local`, passwordHash: '!' })
  return id
}

async function insertWallet(accountId: string, options: { ready: boolean }): Promise<string> {
  const address = nextAddress()
  await db.insert(wallets).values({
    id: newId('wallet'),
    accountId,
    address,
    encryptedKey: 'x',
    readyAt: options.ready ? new Date() : null,
  })
  return address
}

describe.skipIf(!HAVE_POSTGRES)('the listing form against Postgres', () => {
  let creatorId: string
  let creatorAddress: string

  beforeAll(async () => {
    await holder.execute(`select pg_advisory_lock(${LOCK_KEY})`)
  })

  afterAll(async () => {
    await holder.execute(`select pg_advisory_unlock(${LOCK_KEY})`)
  })

  beforeEach(async () => {
    await db.execute(`
      truncate chain_tx, settlements, calls, runs, workflow_nodes, workflows, listings, wallets, accounts
      restart identity cascade
    `)
    // The truncate cascades to the AD-10 single row, so it is put back.
    await db
      .insert(platformSettings)
      .values({
        id: 1,
        mode: 'demo',
        emergencyStop: false,
        orderCeilingUsdt: '1000',
        defaultDailyFeeBudget: '1000000',
        verificationCapDaily: '5000000',
      })
      .onConflictDoUpdate({ target: platformSettings.id, set: { platformAccountId: null } })

    published = []
    creatorId = await insertAccount()
    creatorAddress = await insertWallet(creatorId, { ready: true })
  })

  describe('a valid submission', () => {
    it('writes the row the pipeline picks up and publishes exactly one job', async () => {
      const result = await createListing(deps(), creatorId, SUBMISSION)

      expect(result).toMatchObject({ ok: true })
      if (!result.ok) throw new Error('expected a listing')
      expect(published).toEqual([result.listingId])

      const [row] = await db.select().from(listings)
      expect(row).toMatchObject({
        id: result.listingId,
        creatorAccountId: creatorId,
        name: 'Sloppy Research',
        description: 'Fast, cheap, and wrong about a fifth of the time.',
        type: 'research',
        endpoint: 'http://host.docker.internal:4103',
        // AD-13: base units in the column, decimals only on screen.
        declaredPrice: '30000',
        declaredStake: '300000',
        // FR-10: absent on the form means the Creator's own System Wallet.
        payoutWallet: creatorAddress,
        status: 'verifying',
        // FR-11: every Type but `execution` takes a real paid Call.
        skipVerification: false,
      })

      // AD-2: every chain-owned column is the pipeline's to fill, not the form's.
      expect(row).toMatchObject({
        price: null,
        stake: null,
        reputationBps: null,
        agentId: null,
        registryListingId: null,
        pausedByCreator: false,
        pausedByStake: false,
        lastError: null,
      })
    })

    it('stores a supplied payout wallet lower-case', async () => {
      const result = await createListing(deps(), creatorId, {
        ...SUBMISSION,
        payout_wallet: '0xF6E3A69bEb0F05cEd82C99C4DC4989BeF8fa82C4',
      })

      expect(result).toMatchObject({ ok: true })
      const [row] = await db.select().from(listings)
      expect(row?.payoutWallet).toBe(PAYOUT)
    })

    it('gives each submission its own Listing, so a second one is a second row', async () => {
      await createListing(deps(), creatorId, SUBMISSION)
      await createListing(deps(), creatorId, { ...SUBMISSION, name: 'Sloppy Research 2' })

      expect(await db.select().from(listings)).toHaveLength(2)
      expect(new Set(published).size).toBe(2)
    })
  })

  describe('the refusals', () => {
    it('refuses an execution Agent from an ordinary Creator, and writes nothing', async () => {
      const result = await createListing(deps(), creatorId, { ...SUBMISSION, type: 'execution' })

      expect(result).toEqual({
        ok: false,
        refusal: {
          code: 'refused_execution_type',
          message: 'only the Platform Account may list an execution Agent',
        },
      })
      expect(await db.select().from(listings)).toEqual([])
      expect(published).toEqual([])
    })

    it('lists an execution Agent for the Platform Account, and only that one skips the Call', async () => {
      await db.update(platformSettings).set({ platformAccountId: creatorId })

      const result = await createListing(deps(), creatorId, { ...SUBMISSION, type: 'execution' })

      expect(result).toMatchObject({ ok: true })
      const [row] = await db.select().from(listings)
      // FR-11: a sample Call to an execution Agent would place a real order.
      expect(row).toMatchObject({ type: 'execution', skipVerification: true })
    })

    it('still requires a real verification Call from the Platform Account for every other Type', async () => {
      await db.update(platformSettings).set({ platformAccountId: creatorId })

      await createListing(deps(), creatorId, SUBMISSION)

      const [row] = await db.select().from(listings)
      expect(row).toMatchObject({ type: 'research', skipVerification: false })
    })

    it('refuses a Creator whose wallet has not finished its approval', async () => {
      const pendingId = await insertAccount()
      await insertWallet(pendingId, { ready: false })

      const result = await createListing(deps(), pendingId, SUBMISSION)

      expect(result).toMatchObject({
        ok: false,
        refusal: {
          code: 'wallet_not_ready',
          message: 'your System Wallet is not ready yet (its tUSD approval has not confirmed)',
        },
      })
      expect(await db.select().from(listings)).toEqual([])
    })

    it('refuses a Creator with no wallet row at all', async () => {
      const freshId = await insertAccount()

      const result = await createListing(deps(), freshId, SUBMISSION)

      expect(result).toMatchObject({
        ok: false,
        refusal: { code: 'wallet_not_ready' },
      })
      expect(await db.select().from(listings)).toEqual([])
    })

    it('answers field errors and writes nothing when the form is wrong', async () => {
      const result = await createListing(deps(), creatorId, {
        ...SUBMISSION,
        endpoint: 'http://agents.example/sloppy',
        stake: '0.01',
      })

      expect(result).toMatchObject({
        ok: false,
        refusal: { code: 'validation_failed', message: 'the listing form has errors' },
      })
      if (result.ok) throw new Error('expected a refusal')
      expect(result.refusal.details).toMatchObject({
        fields: { endpoint: expect.stringContaining('http:// is accepted only for'), stake: expect.any(String) },
      })
      expect(await db.select().from(listings)).toEqual([])
      expect(published).toEqual([])
    })
  })

  describe('the body the listing page polls', () => {
    it('narrates a Listing that has only just been submitted', async () => {
      const result = await createListing(deps(), creatorId, SUBMISSION)
      if (!result.ok) throw new Error('expected a listing')

      const detail = await readListingDetail(result.listingId, creatorId)
      expect(detail).not.toBeNull()
      // AD-14: the route parses before it answers, so the test does too.
      const body = listingDetailResponse.parse(detail!.body)

      expect(body).toMatchObject({
        id: result.listingId,
        status: 'verifying',
        declared_price: '30000',
        declared_stake: '300000',
        skip_verification: false,
        is_creator: true,
        verification: null,
        chain_tx: [],
      })
      expect(body.steps.map((step) => [step.step, step.state])).toEqual([
        ['verification', 'running'],
        ['identity', 'waiting'],
        ['list', 'waiting'],
      ])
    })

    it('narrates a Listing that went all the way to active', async () => {
      const result = await createListing(deps(), creatorId, SUBMISSION)
      if (!result.ok) throw new Error('expected a listing')
      const listingId = result.listingId

      // What the pipeline writes: one paid verification Call, then the two
      // intents, then `refreshListingFromChain` filling the chain-owned cache.
      await db.insert(calls).values({
        id: newId('call'),
        runId: null,
        kind: 'verification',
        listingId,
        nodeIndex: 0,
        nodeType: 'research',
        status: 'succeeded',
        lockedPrice: '30000',
        lockedPayTo: creatorAddress,
        lockedAsset: nextAddress(),
        lockedNetwork: 'eip155:97',
        paymentTxHash: HASH_PAYMENT,
        attempt: 1,
        startedAt: new Date(),
        endedAt: new Date(),
      })
      await db.insert(chainTx).values([
        {
          intentKey: intentKeys.identity(listingId),
          payload: { listing_id: listingId, agent_uri: 'https://desk.example/x' },
          status: 'confirmed',
          txHash: HASH_IDENTITY,
          confirmedAt: new Date(),
        },
        {
          intentKey: intentKeys.list(listingId),
          payload: { listing_id: listingId },
          status: 'confirmed',
          txHash: HASH_LIST,
          confirmedAt: new Date(),
        },
      ])
      await db.update(listings).set({
        status: 'active',
        price: '30000',
        stake: '300000',
        agentId: '7',
        registryListingId: '3',
      })

      const detail = await readListingDetail(listingId, creatorId)
      const body = listingDetailResponse.parse(detail!.body)

      expect(body.steps.map((step) => [step.step, step.state, step.tx_hash])).toEqual([
        ['verification', 'done', HASH_PAYMENT],
        ['identity', 'done', HASH_IDENTITY],
        ['list', 'done', HASH_LIST],
      ])
      expect(body.verification).toMatchObject({
        status: 'succeeded',
        node_type: 'research',
        locked_price: '30000',
        payment_tx_hash: HASH_PAYMENT,
      })
      // AD-8: the two explorer links the Creator gets, in step order.
      expect(body.chain_tx.map((row) => row.intent_key)).toEqual([
        intentKeys.identity(listingId),
        intentKeys.list(listingId),
      ])
      expect(body).toMatchObject({ status: 'active', price: '30000', agent_id: '7' })
    })

    it('shows a failed Listing the reason verbatim', async () => {
      const result = await createListing(deps(), creatorId, SUBMISSION)
      if (!result.ok) throw new Error('expected a listing')
      const reason = '402 amount 0.05 tUSD differs from declared 0.03 tUSD'

      await db.insert(calls).values({
        id: newId('call'),
        runId: null,
        kind: 'verification',
        listingId: result.listingId,
        nodeIndex: 0,
        nodeType: 'research',
        status: 'price_mismatch',
        lockedPrice: '30000',
        lockedPayTo: creatorAddress,
        lockedAsset: nextAddress(),
        lockedNetwork: 'eip155:97',
        failureReason: reason,
        attempt: 0,
        startedAt: new Date(),
        endedAt: new Date(),
      })
      await db.update(listings).set({ status: 'failed', lastError: reason })

      const detail = await readListingDetail(result.listingId, creatorId)
      const body = listingDetailResponse.parse(detail!.body)

      expect(body.last_error).toBe(reason)
      expect(body.steps[0]).toMatchObject({ state: 'failed', detail: reason })
      expect(body.chain_tx).toEqual([])
    })

    it('tells a second Account nothing about a Listing that is not on the marketplace', async () => {
      const result = await createListing(deps(), creatorId, SUBMISSION)
      if (!result.ok) throw new Error('expected a listing')
      const strangerId = await insertAccount()

      const detail = await readListingDetail(result.listingId, strangerId)

      // The route turns `is_creator: false` on a `verifying` Listing into a 404
      // rather than a 403, so it never confirms that the id exists.
      expect(detail?.body.is_creator).toBe(false)
      expect(detail?.status).toBe('verifying')
    })

    it('answers null for an id that does not exist', async () => {
      expect(await readListingDetail(newId('listing'), creatorId)).toBeNull()
    })
  })
})
