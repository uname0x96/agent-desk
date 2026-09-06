import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accounts,
  calls,
  chainTx,
  createDb,
  listings,
  runs,
  wallets,
  workflows,
  type Database,
} from '@agent-desk/db'
import { intentKeys, newId, type PriceLock } from '@agent-desk/schemas'

/**
 * `GET /api/listings/<id>/history` against real Postgres (Story 5.4, AD-2, AD-8).
 *
 * The decisions this endpoint makes are unit-tested next door in
 * `listing-history.test.ts` with no database in sight. What can only be wrong in
 * SQL is here, and it is the whole point of the read: that six intent keys with
 * three different shapes — one exact `list:`, one exact `slash:<call_id>` that is
 * keyed by a Call and not by the Listing, and four keys that end in an epoch
 * millisecond or a settlement id and so are matched by prefix — all come back for
 * one Listing, that `identity:` and another Listing's rows do not, and that an
 * unknown id reads as nothing at all.
 *
 * The database is the one every other integration test truncates, so this file
 * takes the same session advisory lock; the key has to stay equal to `LOCK_KEY`
 * in `listings.integration.test.ts`, `manage.integration.test.ts` and
 * `scripts/src/test-db.ts`.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/agentdesk_story16'

// `readListingHistory` reads through the process-wide `db()`, which is built
// from `DATABASE_URL` on first use.
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

const { readListingHistory } = await import('./read.ts')
const { agentRecordAccess, priceHistory, reputationSeries, stakeHistory, toAgentHistory } =
  await import('../../listing-history.ts')

const hash = (byte: string) => `0x${byte.repeat(64)}`

/**
 * Random, not sequential: `wallets.address` is unique and this file shares its
 * database with every other integration file, which mints its own addresses from
 * its own counter. Two counters that both start at one collide.
 */
function nextAddress(): string {
  const bytes = new Uint8Array(20)
  globalThis.crypto.getRandomValues(bytes)
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

async function insertAccount(): Promise<{ accountId: string; walletId: string }> {
  const accountId = newId('account')
  await db.insert(accounts).values({
    id: accountId,
    email: `${accountId}@test.local`,
    passwordHash: '!',
    // AD-3 measures the Daily Fee Budget from the later of UTC midnight and
    // this column, which defaults to `now()`; a fixed fixture clock would
    // otherwise fall outside the window.
    budgetWindowStart: new Date(0),
  })
  const walletId = newId('wallet')
  await db.insert(wallets).values({
    id: walletId,
    accountId,
    address: nextAddress(),
    encryptedKey: 'x',
    readyAt: new Date(),
  })
  return { accountId, walletId }
}

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
    endpoint: 'http://host.docker.internal:4104',
    declaredPrice: '30000',
    declaredStake: '300000',
    payoutWallet: nextAddress(),
    status: 'active',
    price: '50000',
    stake: '370000',
    reputationBps: 6667,
    agentId: '11',
    registryListingId: '10',
    ...overrides,
  })
  return id
}

/** AD-3: a verification Call has no `run_id`, and is never scored. */
async function insertVerificationCall(listingId: string): Promise<string> {
  const id = newId('call')
  await db.insert(calls).values({
    id,
    runId: null,
    kind: 'verification',
    listingId,
    nodeIndex: 0,
    nodeType: 'research',
    status: 'succeeded',
    lockedPrice: '30000',
    lockedPayTo: nextAddress(),
    lockedAsset: nextAddress(),
    lockedNetwork: 'eip155:97',
    request: { symbol: 'BNBUSDT' },
    response: { signal: 'BUY', confidence: 0.62 },
    paymentTxHash: hash('7'),
    attempt: 1,
    startedAt: new Date('2026-09-05T08:59:58Z'),
    endedAt: new Date('2026-09-05T09:00:00Z'),
  })
  return id
}

/** A paid `kind = 'run'` Call, which is the only kind a Slash can name (AD-9). */
async function insertRunCall(
  listingId: string,
  owner: { accountId: string; walletId: string },
): Promise<string> {
  const workflowId = newId('workflow')
  await db
    .insert(workflows)
    .values({ id: workflowId, accountId: owner.accountId, name: 'desk', symbol: 'BNBUSDT' })

  const priceLock: PriceLock = {
    nodes: [
      {
        node_index: 0,
        node_type: 'research',
        listing_id: listingId,
        provider: 'Sloppy Research',
        price: '30000',
        asset: nextAddress(),
        network: 'eip155:97',
        pay_to: nextAddress(),
      },
    ],
    total: '30000',
    locked_at: '2026-09-05T10:00:00.000Z',
  }

  const runId = newId('run')
  await db.insert(runs).values({
    id: runId,
    workflowId,
    accountId: owner.accountId,
    walletId: owner.walletId,
    status: 'completed, no order',
    priceLock,
  })

  const callId = newId('call')
  await db.insert(calls).values({
    id: callId,
    runId,
    kind: 'run',
    listingId,
    nodeIndex: 0,
    nodeType: 'research',
    status: 'succeeded',
    lockedPrice: '30000',
    lockedPayTo: nextAddress(),
    lockedAsset: nextAddress(),
    lockedNetwork: 'eip155:97',
    attempt: 1,
  })
  return callId
}

async function insertChainTx(
  intentKey: string,
  payload: Record<string, unknown>,
  createdAt: string,
): Promise<void> {
  await db.insert(chainTx).values({
    intentKey,
    payload,
    status: 'confirmed',
    txHash: hash('a'),
    confirmedAt: new Date(createdAt),
    createdAt: new Date(createdAt),
  })
}

describe.skipIf(!HAVE_POSTGRES)('the agent history read against Postgres', () => {
  let owner: { accountId: string; walletId: string }
  let stranger: { accountId: string; walletId: string }

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
    owner = await insertAccount()
    stranger = await insertAccount()
  })

  it('reads all six intents of one Listing, and nothing that belongs to another', async () => {
    const listingId = await insertListing(owner.accountId)
    const otherListingId = await insertListing(stranger.accountId)
    const callId = await insertRunCall(listingId, owner)
    await insertVerificationCall(listingId)

    await insertChainTx(
      intentKeys.list(listingId),
      {
        listing_id: listingId,
        before: { price: '0', stake: '0', paused: false },
        after: { price: '30000', stake: '300000', paused: false },
      },
      '2026-09-05T09:00:00Z',
    )
    await insertChainTx(
      intentKeys.price(listingId, 1_757_150_000_000),
      { listing_id: listingId, before: { price: '30000' }, after: { price: '50000' } },
      '2026-09-05T10:00:00Z',
    )
    await insertChainTx(
      intentKeys.stake(listingId, 1_757_151_000_000),
      { listing_id: listingId, before: { stake: '300000' }, after: { stake: '400000' } },
      '2026-09-05T10:10:00Z',
    )
    await insertChainTx(
      intentKeys.slash(callId),
      {
        listing_id: listingId,
        call_id: callId,
        settlement_id: 'stl_x',
        amount: '30000',
        to: nextAddress(),
      },
      '2026-09-05T10:20:00Z',
    )
    await insertChainTx(
      intentKeys.reputation(listingId, 'stl_x'),
      { listing_id: listingId, settlement_id: 'stl_x', before: 10000, after: 6667 },
      '2026-09-05T10:20:10Z',
    )
    await insertChainTx(
      intentKeys.pause(listingId, 1_757_152_000_000),
      { listing_id: listingId, before: { paused: false }, after: { paused: true } },
      '2026-09-05T10:30:00Z',
    )
    // Two rows that must not appear: the pipeline's identity mint, and another
    // Listing's price change, whose key differs only in the id in the middle.
    await insertChainTx(intentKeys.identity(listingId), { listing_id: listingId }, '2026-09-05T08:59:00Z')
    await insertChainTx(
      intentKeys.price(otherListingId, 1_757_150_000_000),
      { listing_id: otherListingId, after: { price: '90000' } },
      '2026-09-05T10:05:00Z',
    )

    const source = await readListingHistory(listingId)
    expect(source).not.toBeNull()
    const body = toAgentHistory(source!)

    expect(body.rows.map((row) => row.intent)).toEqual([
      'list',
      'price',
      'stake',
      'slash',
      'reputation',
      'pause',
    ])
    expect(body.rows.map((row) => row.intent_key)).not.toContain(intentKeys.identity(listingId))
    expect(body.rows.every((row) => !row.intent_key.includes(otherListingId))).toBe(true)

    // The three series the page draws, from the rows this read produced.
    expect(priceHistory(body.rows).map((point) => [point.old_price, point.new_price])).toEqual([
      [null, '30000'],
      ['30000', '50000'],
    ])
    expect(reputationSeries(body.rows).map((point) => point.bps)).toEqual([6667])
    expect(stakeHistory(body.rows).map((event) => [event.kind, event.amount])).toEqual([
      ['stake', '100000'],
      ['slash', '30000'],
    ])
  })

  it('carries the verification Call with its request and response JSON (FR-11)', async () => {
    const listingId = await insertListing(owner.accountId)
    const callId = await insertVerificationCall(listingId)

    const source = await readListingHistory(listingId)
    expect(source?.verification).toMatchObject({
      id: callId,
      status: 'succeeded',
      node_type: 'research',
      locked_price: '30000',
      request: { symbol: 'BNBUSDT' },
      response: { signal: 'BUY', confidence: 0.62 },
      payment_tx_hash: hash('7'),
      started_at: '2026-09-05T08:59:58.000Z',
    })
  })

  it('carries no verification Call for a Listing that has none', async () => {
    const listingId = await insertListing(owner.accountId)
    const source = await readListingHistory(listingId)
    expect(source?.verification).toBeNull()
  })

  it('finds no Listing for an unknown id, which the route answers 404 not_found', async () => {
    const source = await readListingHistory('lst_00000000000000000000MISSING')
    expect(source).toBeNull()
    expect(agentRecordAccess(source, owner.accountId)).toBe('not_found')
  })

  it('answers an active Listing to any signed-in account', async () => {
    const listingId = await insertListing(owner.accountId)
    const source = await readListingHistory(listingId)
    expect(agentRecordAccess(source, stranger.accountId)).toBe('ok')
  })

  it('hides a Listing the marketplace does not show from everyone but its Creator', async () => {
    // AD-2: a `verifying` Listing has no Registry entry to show, so it is the
    // Creator's to watch on `/listings/<id>` and nobody else's to read.
    const listingId = await insertListing(owner.accountId, {
      status: 'verifying',
      price: null,
      stake: null,
      reputationBps: null,
      agentId: null,
      registryListingId: null,
    })

    const source = await readListingHistory(listingId)
    expect(agentRecordAccess(source, stranger.accountId)).toBe('not_found')
    expect(agentRecordAccess(source, owner.accountId)).toBe('ok')
  })
})
