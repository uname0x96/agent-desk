import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
import { newId, runsResponse, toBaseUnits, type PriceLock } from '@agent-desk/schemas'
import { selectRunsForAccount, toRunFeedPage } from './list-runs.ts'

/**
 * `GET /api/runs` against real Postgres.
 *
 * The view model itself is unit-tested in `list-runs.test.ts`. What is here is
 * what can only be wrong in SQL: that the feed answers the signed-in account's
 * Runs and nobody else's, that "newest first" survives the keyset order, and
 * that paging with the returned cursor walks the account's Runs exactly once
 * with no gap and no repeat.
 *
 * The database is the one the other integration suites truncate, so this file
 * takes the same session advisory lock they do — the key below has to stay
 * equal to `LOCK_KEY` in `scripts/src/test-db.ts` and in
 * `app/api/runs/runs.integration.test.ts`, or two suites will run at once and
 * truncate each other's fixtures.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/agentdesk_story16'

const LOCK_KEY = 1_620_000_016

const ASSET = '0xd0e0851ca8a176d211e2a410f5bcf1fa440fada7'
const PRICE = toBaseUnits('0.01').toString()
/** Distinct milliseconds, so the ULID time prefix orders the fixtures strictly. */
const BASE_CLOCK = Date.parse('2026-09-05T02:00:00.000Z')

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

async function reset(): Promise<void> {
  await db.execute(`
    truncate chain_tx, settlements, calls, runs, workflow_nodes, workflows, listings, wallets, accounts
    restart identity cascade
  `)
}

let addressCounter = 0
function nextAddress(): string {
  addressCounter += 1
  return `0x${addressCounter.toString(16).padStart(40, '0')}`
}

function priceLock(total: string): PriceLock {
  return {
    locked_at: new Date(BASE_CLOCK).toISOString(),
    total,
    nodes: [
      {
        node_index: 0,
        node_type: 'data',
        listing_id: 'lst_placeholder',
        provider: 'Fixture Agent',
        price: total,
        asset: ASSET,
        network: 'eip155:97',
        pay_to: nextAddress(),
      },
    ],
  }
}

interface Owner {
  accountId: string
  walletId: string
  workflowId: string
  listingId: string
}

/** One Account with a ready wallet, one Workflow and one `active` Listing. */
async function owner(name: string): Promise<Owner> {
  const accountId = newId('account')
  const walletId = newId('wallet')
  const workflowId = newId('workflow')
  const listingId = newId('listing')

  await db.insert(accounts).values({
    id: accountId,
    email: `${accountId}@test.local`,
    passwordHash: '!',
    // The fixture clock is fixed while `budget_window_start` defaults to the
    // real `now()`; pinning it to the epoch keeps the AD-3 window at UTC
    // midnight rather than a function of when the suite runs.
    budgetWindowStart: new Date(0),
  })
  await db.insert(wallets).values({
    id: walletId,
    accountId,
    address: nextAddress(),
    encryptedKey: 'gcm1.a.b.c',
    readyAt: new Date(BASE_CLOCK),
  })
  await db.insert(listings).values({
    id: listingId,
    creatorAccountId: accountId,
    name: `${name} Provider`,
    type: 'data',
    endpoint: 'https://agent.example/run',
    declaredPrice: PRICE,
    declaredStake: toBaseUnits('0.10').toString(),
    payoutWallet: nextAddress(),
    status: 'active',
    price: PRICE,
    stake: toBaseUnits('0.30').toString(),
  })
  await db.insert(workflows).values({ id: workflowId, accountId, name, symbol: 'BNBUSDT' })
  await db.insert(workflowNodes).values({ workflowId, nodeIndex: 0, nodeType: 'data', listingId })

  return { accountId, walletId, workflowId, listingId }
}

interface RunSpec {
  status: string
  /** One entry per Node, in chain order. */
  callStatuses: readonly ('pending' | 'succeeded' | 'skipped' | 'failed_after_payment')[]
  tick: number
}

async function insertRun(where: Owner, spec: RunSpec): Promise<string> {
  const runId = newId('run', BASE_CLOCK + spec.tick * 1000)
  await db.insert(runs).values({
    id: runId,
    workflowId: where.workflowId,
    accountId: where.accountId,
    walletId: where.walletId,
    status: spec.status as 'running',
    priceLock: priceLock(PRICE),
    createdAt: new Date(BASE_CLOCK + spec.tick * 1000),
    startedAt: new Date(BASE_CLOCK + spec.tick * 1000 + 500),
  })
  await db.insert(calls).values(
    spec.callStatuses.map((status, index) => ({
      id: newId('call', BASE_CLOCK + spec.tick * 1000 + index),
      runId,
      kind: 'run' as const,
      listingId: where.listingId,
      nodeIndex: index,
      nodeType: 'data' as const,
      status,
      lockedPrice: PRICE,
      lockedPayTo: nextAddress(),
      lockedAsset: ASSET,
      lockedNetwork: 'eip155:97',
    })),
  )
  return runId
}

beforeAll(async () => {
  if (HAVE_POSTGRES) await holder.execute(`select pg_advisory_lock(${LOCK_KEY})`)
})

afterAll(async () => {
  if (!HAVE_POSTGRES) return
  await reset()
  await holder.execute(`select pg_advisory_unlock(${LOCK_KEY})`)
})

describe.skipIf(!HAVE_POSTGRES)(`GET /api/runs against ${TEST_DATABASE_URL}`, () => {
  beforeEach(async () => {
    await reset()
  })

  it('answers only the account it was asked about', async () => {
    const mine = await owner('My desk')
    const theirs = await owner('Their desk')
    const oldest = await insertRun(mine, { status: 'completed', callStatuses: ['succeeded'], tick: 1 })
    const newest = await insertRun(mine, { status: 'running', callStatuses: ['pending'], tick: 3 })
    await insertRun(theirs, { status: 'running', callStatuses: ['pending'], tick: 2 })

    const rows = await selectRunsForAccount(db, mine.accountId, 20, null)
    const page = toRunFeedPage(rows, 20)

    expect(page.items.map((item) => item.id)).toEqual([newest, oldest])
    expect(page.next).toBeNull()
  })

  it('answers a body that parses as runsResponse (AD-14)', async () => {
    const mine = await owner('My desk')
    await insertRun(mine, {
      status: 'failed at data',
      callStatuses: ['failed_after_payment', 'skipped'],
      tick: 1,
    })

    const page = toRunFeedPage(await selectRunsForAccount(db, mine.accountId, 20, null), 20)
    const parsed = runsResponse.parse(page)

    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]).toMatchObject({
      workflow_name: 'My desk',
      symbol: 'BNBUSDT',
      status: 'failed at data',
      // AD-3: the paid Call counts, the skipped one does not.
      total_cost: PRICE,
      nodes: [
        { node_type: 'data', status: 'failed_after_payment' },
        { node_type: 'data', status: 'skipped' },
      ],
    })
    expect(parsed.items[0]?.wallet_address).toMatch(/^0x[0-9a-f]{40}$/)
  })

  it('pages with the cursor it returns, once per Run and with no gap', async () => {
    const mine = await owner('My desk')
    const ids: string[] = []
    for (let tick = 1; tick <= 5; tick += 1) {
      ids.push(await insertRun(mine, { status: 'completed', callStatuses: ['succeeded'], tick }))
    }
    const newestFirst = [...ids].reverse()

    const seen: string[] = []
    let cursor: string | null = null
    for (let request = 0; request < 5; request += 1) {
      const page = toRunFeedPage(await selectRunsForAccount(db, mine.accountId, 2, cursor), 2)
      seen.push(...page.items.map((item) => item.id))
      cursor = page.next
      if (cursor === null) break
    }

    expect(seen).toEqual(newestFirst)
    expect(cursor).toBeNull()
  })

  it('answers an empty feed for an account that has never run anything', async () => {
    const mine = await owner('My desk')
    expect(toRunFeedPage(await selectRunsForAccount(db, mine.accountId, 20, null), 20)).toEqual({
      items: [],
      next: null,
    })
  })
})
