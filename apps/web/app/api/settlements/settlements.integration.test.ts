import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accounts,
  calls,
  createDb,
  listings,
  runs,
  settlements,
  wallets,
  workflows,
  type Database,
} from '@agent-desk/db'
import { PRICE_SOURCE, newId, toBaseUnits } from '@agent-desk/schemas'
import { RISK_RULE_LABEL } from '@agent-desk/core/settlement'
import { MODE_CONSTANTS } from '@agent-desk/core/mode'
import { selectSettlements } from './query.ts'
import { toSettlementsPage } from './settlements-page.ts'

/**
 * `GET /api/settlements` against real Postgres (Story 5.3, FR-41).
 *
 * The wording, the cursor arithmetic and the poll are unit-tested next door
 * with no database in sight. What can only be wrong in SQL is here, and it is
 * the part that matters most: the list is scoped to the signed-in account's
 * Runs, and no query string widens it. A Builder must never see another
 * Builder's Settlements, and `?run_id=` must not become an oracle for whether
 * someone else's Run exists.
 *
 * The AD-9 exclusion of `verification` Calls is checked here too. It holds by
 * construction — a `verification` Call has no `run_id` (`calls_run_id_matches_kind`)
 * and so cannot belong to any account's Run — and that is exactly the kind of
 * claim that is worth pinning to the real schema rather than to a comment.
 *
 * The database is the one every other integration test truncates, so this file
 * takes the same session advisory lock; the key has to stay equal to `LOCK_KEY`
 * in `app/api/runs/runs.integration.test.ts` and `scripts/src/test-db.ts`.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/agentdesk_story16'

const LOCK_KEY = 1_620_000_016

const ASSET = '0xd0e0851ca8a176d211e2a410f5bcf1fa440fada7'
const NOW = new Date('2026-09-06T12:00:00.000Z')
const PRICE = toBaseUnits('0.01').toString()

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

/** A distinct lower-case address per fixture, so `wallets_address_key` holds. */
let addressCounter = 0
function nextAddress(): string {
  addressCounter += 1
  return `0x${addressCounter.toString(16).padStart(40, '0')}`
}

/** An id whose ULID part sorts where the test wants it, so the cursor is checkable. */
function settlementId(order: number): string {
  return `stl_${order.toString().padStart(26, '0')}`
}

interface Builder {
  accountId: string
  walletAddress: string
  runId: string
}

async function builder(): Promise<Builder> {
  const accountId = newId('account')
  const walletId = newId('wallet')
  const workflowId = newId('workflow')
  const runId = newId('run')
  const walletAddress = nextAddress()

  await db.insert(accounts).values({
    id: accountId,
    email: `${accountId}@test.local`,
    passwordHash: '!',
    // The fixture clock is fixed, but `budget_window_start` defaults to the
    // real `now()`, and AD-3 takes the later of it and UTC midnight. Pin it to
    // the epoch so the window is UTC midnight and nothing here is a function of
    // what time of day the suite runs.
    budgetWindowStart: new Date(0),
  })
  await db.insert(wallets).values({
    id: walletId,
    accountId,
    address: walletAddress,
    encryptedKey: 'gcm1.a.b.c',
    readyAt: NOW,
  })
  await db.insert(workflows).values({ id: workflowId, accountId, name: 'Fixture', symbol: 'BNBUSDT' })
  await db.insert(runs).values({
    id: runId,
    workflowId,
    accountId,
    walletId,
    status: 'completed',
    priceLock: { nodes: [], total: '0', locked_at: NOW.toISOString() },
    createdAt: NOW,
    startedAt: NOW,
    endedAt: NOW,
  })
  return { accountId, walletAddress, runId }
}

async function listing(name: string, type: 'research' | 'risk' | 'data'): Promise<string> {
  const creatorAccountId = newId('account')
  const listingId = newId('listing')
  await db.insert(accounts).values({
    id: creatorAccountId,
    email: `${creatorAccountId}@test.local`,
    passwordHash: '!',
    budgetWindowStart: new Date(0),
  })
  await db.insert(listings).values({
    id: listingId,
    creatorAccountId,
    name,
    type,
    endpoint: 'http://host.docker.internal:4103',
    declaredPrice: PRICE,
    declaredStake: toBaseUnits('0.1').toString(),
    payoutWallet: nextAddress(),
    status: 'active',
    price: PRICE,
    stake: toBaseUnits('0.1').toString(),
  })
  return listingId
}

/** One scored Call: the `calls` row and the `settlements` row AD-9 puts behind it. */
async function scoredCall(options: {
  runId: string | null
  listingId: string
  kind: 'run' | 'verification'
  nodeType: 'research' | 'risk' | 'data'
  order: number
  result: 'passed' | 'failed' | 'not_scored'
  slashTxHash?: string | null
  refundTo?: string | null
}): Promise<string> {
  const callId = newId('call')
  await db.insert(calls).values({
    id: callId,
    runId: options.runId,
    kind: options.kind,
    listingId: options.listingId,
    nodeIndex: 1,
    nodeType: options.nodeType,
    status: 'succeeded',
    lockedPrice: PRICE,
    lockedPayTo: nextAddress(),
    lockedAsset: ASSET,
    lockedNetwork: 'eip155:97',
    startedAt: NOW,
    endedAt: NOW,
  })
  const id = settlementId(options.order)
  await db.insert(settlements).values({
    id,
    callId,
    listingId: options.listingId,
    result: options.result,
    notScoredReason: options.result === 'not_scored' ? 'no_fill' : null,
    mode: 'demo',
    ruleLabel:
      options.nodeType === 'risk' ? RISK_RULE_LABEL : MODE_CONSTANTS.demo.researchRuleLabel,
    priceSource: PRICE_SOURCE,
    startPrice: '612.40',
    change24hPct: 1.732,
    scoredAt: NOW,
    slashAmount: options.slashTxHash ? PRICE : null,
    slashTxHash: options.slashTxHash ?? null,
    refundTo: options.refundTo ?? null,
  })
  return id
}

beforeAll(async () => {
  if (!HAVE_POSTGRES) return
  await holder.execute(`select pg_advisory_lock(${LOCK_KEY})`)
  await reset()
}, 60_000)

afterAll(async () => {
  if (!HAVE_POSTGRES) return
  await reset()
  await holder.execute(`select pg_advisory_unlock(${LOCK_KEY})`)
})

describe.skipIf(!HAVE_POSTGRES)('GET /api/settlements', () => {
  beforeEach(reset)

  it('answers only the Settlements of the session account’s own Runs', async () => {
    const mine = await builder()
    const theirs = await builder()
    const research = await listing('Claude Analyst', 'research')

    const own = await scoredCall({
      runId: mine.runId,
      listingId: research,
      kind: 'run',
      nodeType: 'research',
      order: 2,
      result: 'passed',
    })
    await scoredCall({
      runId: theirs.runId,
      listingId: research,
      kind: 'run',
      nodeType: 'research',
      order: 1,
      result: 'failed',
    })

    const rows = await selectSettlements(
      db,
      { accountId: mine.accountId, runId: null, listingId: null, cursor: null },
      50,
    )
    expect(rows.map((row) => row.id)).toEqual([own])
    expect(rows[0]?.runId).toBe(mine.runId)
    expect(rows[0]?.provider).toBe('Claude Analyst')
    expect(rows[0]?.nodeType).toBe('research')
  })

  it('answers nothing for a ?run_id= the session does not own, and never says why', async () => {
    const mine = await builder()
    const theirs = await builder()
    const research = await listing('Claude Analyst', 'research')
    await scoredCall({
      runId: theirs.runId,
      listingId: research,
      kind: 'run',
      nodeType: 'research',
      order: 1,
      result: 'failed',
    })

    const rows = await selectSettlements(
      db,
      { accountId: mine.accountId, runId: theirs.runId, listingId: null, cursor: null },
      50,
    )
    // Indistinguishable from a Run id that does not exist at all, which is the
    // point: the page can be asked about someone else's Run and learns nothing.
    expect(toSettlementsPage(rows, 50)).toEqual({ items: [], next: null })
  })

  it('never shows a verification Call, which AD-9 does not score', async () => {
    const mine = await builder()
    const research = await listing('Claude Analyst', 'research')
    const scored = await scoredCall({
      runId: mine.runId,
      listingId: research,
      kind: 'run',
      nodeType: 'research',
      order: 2,
      result: 'passed',
    })
    // A `verification` Call belongs to a Listing, not a Run, so it has no
    // `run_id` to reach an account through — even with a settlements row
    // written against it, which the pipeline never does.
    await scoredCall({
      runId: null,
      listingId: research,
      kind: 'verification',
      nodeType: 'research',
      order: 1,
      result: 'failed',
    })

    const rows = await selectSettlements(
      db,
      { accountId: mine.accountId, runId: null, listingId: null, cursor: null },
      50,
    )
    expect(rows.map((row) => row.id)).toEqual([scored])
  })

  it('filters by ?listing_id=, so an Agent’s record can be read on its own', async () => {
    const mine = await builder()
    const research = await listing('Claude Analyst', 'research')
    const risk = await listing('Volatility Guard', 'risk')
    await scoredCall({
      runId: mine.runId,
      listingId: research,
      kind: 'run',
      nodeType: 'research',
      order: 2,
      result: 'passed',
    })
    const riskRow = await scoredCall({
      runId: mine.runId,
      listingId: risk,
      kind: 'run',
      nodeType: 'risk',
      order: 1,
      result: 'failed',
      slashTxHash: `0x${'5c'.repeat(32)}`,
      refundTo: mine.walletAddress,
    })

    const rows = await selectSettlements(
      db,
      { accountId: mine.accountId, runId: null, listingId: risk, cursor: null },
      50,
    )
    expect(rows.map((row) => row.id)).toEqual([riskRow])
    expect(rows[0]?.provider).toBe('Volatility Guard')
    expect(rows[0]?.refundTo).toBe(mine.walletAddress)
  })

  it('pages newest first, and the cursor picks up exactly where the page stopped', async () => {
    const mine = await builder()
    const research = await listing('Claude Analyst', 'research')
    const ids: string[] = []
    for (const order of [1, 2, 3, 4, 5]) {
      ids.push(
        await scoredCall({
          runId: mine.runId,
          listingId: research,
          kind: 'run',
          nodeType: 'research',
          order,
          result: 'passed',
        }),
      )
    }
    const newestFirst = [...ids].reverse()

    const first = toSettlementsPage(
      await selectSettlements(
        db,
        { accountId: mine.accountId, runId: null, listingId: null, cursor: null },
        2,
      ),
      2,
    )
    expect(first.items.map((row) => row.id)).toEqual(newestFirst.slice(0, 2))
    expect(first.next).toBe(newestFirst[1])

    const second = toSettlementsPage(
      await selectSettlements(
        db,
        { accountId: mine.accountId, runId: null, listingId: null, cursor: first.next },
        2,
      ),
      2,
    )
    expect(second.items.map((row) => row.id)).toEqual(newestFirst.slice(2, 4))

    const last = toSettlementsPage(
      await selectSettlements(
        db,
        { accountId: mine.accountId, runId: null, listingId: null, cursor: second.next },
        2,
      ),
      2,
    )
    expect(last.items.map((row) => row.id)).toEqual(newestFirst.slice(4))
    expect(last.next).toBeNull()
  })

  it('carries a landed Slash to the wire as base units and a lower-case hash', async () => {
    const mine = await builder()
    const risk = await listing('Volatility Guard', 'risk')
    await scoredCall({
      runId: mine.runId,
      listingId: risk,
      kind: 'run',
      nodeType: 'risk',
      order: 1,
      result: 'failed',
      slashTxHash: `0x${'5c'.repeat(32)}`,
      refundTo: mine.walletAddress,
    })

    const page = toSettlementsPage(
      await selectSettlements(
        db,
        { accountId: mine.accountId, runId: null, listingId: null, cursor: null },
        50,
      ),
      50,
    )
    const row = page.items[0]
    expect(row?.result).toBe('failed')
    expect(row?.slash_amount).toBe(PRICE)
    expect(row?.slash_tx_hash).toBe(`0x${'5c'.repeat(32)}`)
    expect(row?.refund_to).toBe(mine.walletAddress)
    expect(row?.rule_label).toBe(RISK_RULE_LABEL)
  })
})
