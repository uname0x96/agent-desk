import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accounts,
  chainTx,
  createDb,
  listings,
  wallets,
  type Database,
} from '@agent-desk/db'
import { intentKeys, newId, type ListingWriteJob } from '@agent-desk/schemas'
import { requestListingWrite } from './manage-listing.ts'

/**
 * `POST /api/listings/<id>/price`, `/stake` and `/pause` against real Postgres
 * (Story 3.6, FR-7, FR-8, FR-9).
 *
 * The rules are unit-tested next door with no database in sight. What can only
 * be wrong in SQL is here: that a Listing another account owns is a 404 and not
 * a 403, that a Listing with no Registry entry is refused before a job is
 * published, that `before` is read from the row rather than from the request,
 * and that the AD-8 intent key the 202 hands back is the key of the job that
 * was actually enqueued.
 *
 * Nothing here signs or sends anything: AD-1 keeps the key in the worker, and
 * `listing.write` is proven against the chain writer in
 * `apps/worker/src/jobs/listing/write.test.ts`.
 *
 * The database is the one every other integration test truncates, so this file
 * takes the same session advisory lock; the key has to stay equal to `LOCK_KEY`
 * in `listings.integration.test.ts` and `scripts/src/test-db.ts`.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/agentdesk_story16'

// `readListingDetail` and `reconcileListingStatus` read through the
// process-wide `db()`, which is built from `DATABASE_URL` on first use.
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
const { reconcileListingStatus } = await import('./refresh-context.ts')

const NOW = 1_757_150_000_000
const HASH = (byte: string) => `0x${byte.repeat(32)}`

/** Every job handed to pg-boss, so "published exactly once" is checkable. */
let published: ListingWriteJob[] = []

function deps() {
  return {
    db,
    publish: async (job: ListingWriteJob) => {
      published.push(job)
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
  await db
    .insert(wallets)
    .values({ id: newId('wallet'), accountId: id, address: nextAddress(), encryptedKey: 'x', readyAt: new Date() })
  return id
}

/** A Listing the pipeline already put on the Registry: 0.03 tUSD, 0.3 of Stake. */
async function insertListing(
  creatorAccountId: string,
  overrides: Partial<typeof listings.$inferInsert> = {},
): Promise<string> {
  const id = newId('listing')
  await db.insert(listings).values({
    id,
    creatorAccountId,
    name: 'Sloppy Research',
    type: 'research',
    endpoint: 'http://host.docker.internal:4103',
    declaredPrice: '30000',
    declaredStake: '300000',
    payoutWallet: nextAddress(),
    status: 'active',
    price: '30000',
    stake: '300000',
    reputationBps: null,
    agentId: '7',
    registryListingId: '78',
    ...overrides,
  })
  return id
}

describe.skipIf(!HAVE_POSTGRES)('the manage routes against Postgres', () => {
  let creatorId: string
  let strangerId: string

  // Every integration file in the repo queues on this one lock, so the wait is
  // as long as the files ahead of it — well past Vitest's 10 s hook default on
  // a cold pool.
  beforeAll(async () => {
    await holder.execute(`select pg_advisory_lock(${LOCK_KEY})`)
  }, 120_000)

  afterAll(async () => {
    await holder.execute(`select pg_advisory_unlock(${LOCK_KEY})`)
  })

  // Deliberately no `truncate`: every row this file makes is reached by an id it
  // just minted, so there is nothing to clear between tests — and a truncate
  // here would delete the rows of the integration files that do not take the
  // lock while they are still using them.
  beforeEach(async () => {
    published = []
    creatorId = await insertAccount()
    strangerId = await insertAccount()
  })

  // ------------------------------------------------------------------ price

  describe('a price change', () => {
    it('publishes one listing.write job keyed on the AD-8 intent key', async () => {
      const listingId = await insertListing(creatorId)

      const result = await requestListingWrite(
        deps(),
        creatorId,
        listingId,
        { intent: 'price', price: '0.02' },
        NOW,
      )

      expect(result).toMatchObject({ ok: true, intentKey: intentKeys.price(listingId, NOW) })
      expect(published).toHaveLength(1)
      expect(published[0]).toEqual({
        listing_id: listingId,
        intent_key: intentKeys.price(listingId, NOW),
        payload: {
          listing_id: listingId,
          // `before` is the row, not the request: it is what the job re-checks.
          before: { price: '30000', stake: '300000', paused: false },
          after: { price: '20000' },
        },
      })
    })

    it('refuses a price the Stake cannot carry and publishes nothing', async () => {
      const listingId = await insertListing(creatorId)

      const result = await requestListingWrite(
        deps(),
        creatorId,
        listingId,
        { intent: 'price', price: '0.05' },
        NOW,
      )

      expect(result).toMatchObject({ ok: false })
      if (result.ok) throw new Error('expected a refusal')
      expect(result.refusal.code).toBe('refused_stake')
      expect(published).toEqual([])
    })
  })

  // ------------------------------------------------------------------ stake

  describe('a top-up', () => {
    it('states the Stake it will produce, so the job can take the difference', async () => {
      const listingId = await insertListing(creatorId, { stake: '120000' })

      const result = await requestListingWrite(
        deps(),
        creatorId,
        listingId,
        { intent: 'stake', amount: '0.18' },
        NOW,
      )

      expect(result).toMatchObject({ ok: true, intentKey: intentKeys.stake(listingId, NOW) })
      expect(published[0]?.payload).toMatchObject({
        before: { price: '30000', stake: '120000' },
        after: { stake: '300000' },
      })
    })
  })

  // ------------------------------------------------------------------ pause

  describe('the pause switch', () => {
    it('pauses a live Listing', async () => {
      const listingId = await insertListing(creatorId)

      const result = await requestListingWrite(
        deps(),
        creatorId,
        listingId,
        { intent: 'pause', paused: true },
        NOW,
      )

      expect(result).toMatchObject({ ok: true, intentKey: intentKeys.pause(listingId, NOW) })
      expect(published[0]?.payload).toMatchObject({
        before: { paused: false },
        after: { paused: true },
      })
    })

    it('refuses a Resume on a Listing only the Stake paused', async () => {
      const listingId = await insertListing(creatorId, { status: 'paused', pausedByStake: true })

      const result = await requestListingWrite(
        deps(),
        creatorId,
        listingId,
        { intent: 'pause', paused: false },
        NOW,
      )

      expect(result).toMatchObject({ ok: false })
      if (result.ok) throw new Error('expected a refusal')
      expect(result.refusal.message).toContain('a top-up is what resumes it')
      expect(published).toEqual([])
    })
  })

  // ---------------------------------------------------------- who and when

  describe('who may change a Listing, and when', () => {
    it('answers a Listing another account owns as 404, never 403', async () => {
      const listingId = await insertListing(creatorId)

      const result = await requestListingWrite(
        deps(),
        strangerId,
        listingId,
        { intent: 'pause', paused: true },
        NOW,
      )

      expect(result).toMatchObject({ ok: false })
      if (result.ok) throw new Error('expected a refusal')
      expect(result.refusal.code).toBe('not_found')
      expect(published).toEqual([])
    })

    it('answers a Listing that does not exist the same way', async () => {
      const result = await requestListingWrite(
        deps(),
        creatorId,
        'lst_NOTHING',
        { intent: 'pause', paused: true },
        NOW,
      )
      expect(result).toMatchObject({ ok: false, refusal: { code: 'not_found' } })
    })

    it('refuses a Listing that is still going on chain', async () => {
      const listingId = await insertListing(creatorId, {
        status: 'verifying',
        price: null,
        stake: null,
        agentId: null,
        registryListingId: null,
      })

      const result = await requestListingWrite(
        deps(),
        creatorId,
        listingId,
        { intent: 'pause', paused: true },
        NOW,
      )

      expect(result).toMatchObject({ ok: false })
      if (result.ok) throw new Error('expected a refusal')
      expect(result.refusal.code).toBe('conflict')
      expect(published).toEqual([])
    })

    it('refuses a Listing that failed and never reached the Registry', async () => {
      const listingId = await insertListing(creatorId, {
        status: 'failed',
        price: null,
        stake: null,
        registryListingId: null,
      })

      const result = await requestListingWrite(
        deps(),
        creatorId,
        listingId,
        { intent: 'price', price: '0.02' },
        NOW,
      )
      expect(result).toMatchObject({ ok: false, refusal: { code: 'conflict' } })
    })
  })

  // -------------------------------------------------------------- the page

  describe('what the manage page reads back', () => {
    it('lists the pipeline rows in step order and the manage rows after them', async () => {
      const listingId = await insertListing(creatorId)
      await db.insert(chainTx).values([
        {
          intentKey: intentKeys.price(listingId, NOW),
          payload: { listing_id: listingId, before: { price: '30000' }, after: { price: '20000' } },
          status: 'pending',
          txHash: null,
        },
        {
          intentKey: intentKeys.list(listingId),
          payload: { listing_id: listingId },
          status: 'confirmed',
          txHash: HASH('b2'),
        },
        {
          intentKey: intentKeys.identity(listingId),
          payload: { listing_id: listingId },
          status: 'confirmed',
          txHash: HASH('a1'),
        },
        // Another Listing's transaction, which must not appear here.
        {
          intentKey: intentKeys.price(newId('listing'), NOW),
          payload: {},
          status: 'confirmed',
          txHash: HASH('c3'),
        },
      ])

      const detail = await readListingDetail(listingId, creatorId)

      expect(detail).not.toBeNull()
      expect(detail?.body.chain_tx.map((row) => row.intent_key)).toEqual([
        intentKeys.identity(listingId),
        intentKeys.list(listingId),
        intentKeys.price(listingId, NOW),
      ])
      // AD-12: the page keeps polling while that price row is pending.
      expect(detail?.body.chain_tx.at(-1)?.status).toBe('pending')
    })
  })

  // ------------------------------------------------------- the refresh route

  describe('reconciling the status after a refresh (AD-2)', () => {
    it('pauses a Listing whose flags came back set', async () => {
      const listingId = await insertListing(creatorId)
      await db.execute(`update listings set paused_by_creator = true where id = '${listingId}'`)

      await reconcileListingStatus(listingId)

      expect(await statusOf(listingId)).toBe('paused')
    })

    it('resumes a Listing whose flags came back clear', async () => {
      const listingId = await insertListing(creatorId, { status: 'paused', pausedByStake: true })
      await db.execute(`update listings set paused_by_stake = false where id = '${listingId}'`)

      await reconcileListingStatus(listingId)

      expect(await statusOf(listingId)).toBe('active')
    })

    it('never moves a Listing the pipeline still owns', async () => {
      const listingId = await insertListing(creatorId, {
        status: 'verifying',
        price: null,
        stake: null,
        registryListingId: null,
      })

      await reconcileListingStatus(listingId)

      expect(await statusOf(listingId)).toBe('verifying')
    })
  })

  async function statusOf(listingId: string): Promise<string | undefined> {
    const row = await db.query.listings.findFirst({
      where: (listing, { eq }) => eq(listing.id, listingId),
      columns: { status: true },
    })
    return row?.status
  }
})
