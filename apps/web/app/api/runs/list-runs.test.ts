import { describe, expect, it } from 'vitest'
import { RUN_FEED_DEFAULT_LIMIT, RUN_FEED_MAX_LIMIT, runSummary } from '@agent-desk/schemas'
import {
  parseRunFeedQuery,
  toRunFeedPage,
  toRunNodes,
  toRunSummary,
  totalCost,
  type RunFeedCallRow,
  type RunFeedRow,
} from './list-runs.ts'

/**
 * Story 5.1: every decision `GET /api/runs` makes before it touches HTTP.
 *
 * The three that can silently be wrong are the AD-3 cost sum (which statuses
 * count, and that a `verification` Call never does), the Node order, and the
 * keyset cursor — a `next` that is not the last item's id pages past rows.
 */

const WALLET = '0xa71c3d90e5b28f4607c93d1a2b85e04f7d16c982'

function call(overrides: Partial<RunFeedCallRow> = {}): RunFeedCallRow {
  return {
    kind: 'run',
    nodeIndex: 0,
    nodeType: 'data',
    status: 'succeeded',
    lockedPrice: '10000',
    ...overrides,
  }
}

function row(overrides: Partial<RunFeedRow> = {}): RunFeedRow {
  return {
    id: 'run_01K4RWZ8QY7M3B0P5X2A9TGCVD',
    workflowId: 'wf_01K4RWZ0N3F8H2S6C1E7YQAB4M',
    workflowName: 'BNB momentum desk',
    symbol: 'BNBUSDT',
    status: 'running',
    failureReason: null,
    walletAddress: WALLET,
    createdAt: new Date('2026-09-05T02:00:00.000Z'),
    startedAt: new Date('2026-09-05T02:00:01.000Z'),
    endedAt: null,
    calls: [call()],
    ...overrides,
  }
}

describe('total_cost (AD-3)', () => {
  it('sums locked_price over the three paid statuses only', () => {
    const cost = totalCost([
      call({ nodeIndex: 0, status: 'paid_awaiting_result', lockedPrice: '10000' }),
      call({ nodeIndex: 1, status: 'succeeded', lockedPrice: '25000' }),
      call({ nodeIndex: 2, status: 'failed_after_payment', lockedPrice: '5000' }),
    ])
    expect(cost).toBe('40000')
  })

  it('counts nothing for a Call that was never paid for', () => {
    const cost = totalCost([
      call({ nodeIndex: 0, status: 'pending', lockedPrice: '10000' }),
      call({ nodeIndex: 1, status: 'price_mismatch', lockedPrice: '10000' }),
      call({ nodeIndex: 2, status: 'payment_failed', lockedPrice: '10000' }),
      call({ nodeIndex: 3, status: 'skipped', lockedPrice: '10000' }),
    ])
    expect(cost).toBe('0')
  })

  it('never counts a verification Call, whatever its status', () => {
    const cost = totalCost([
      call({ nodeIndex: 0, status: 'succeeded', lockedPrice: '10000' }),
      call({ kind: 'verification', nodeIndex: 0, status: 'succeeded', lockedPrice: '999000' }),
    ])
    expect(cost).toBe('10000')
  })

  it('is a base-unit integer string, never a float', () => {
    // 0.1 + 0.2 in base units, which is exactly where a float would show.
    expect(totalCost([call({ lockedPrice: '100000' }), call({ nodeIndex: 1, lockedPrice: '200000' })]))
      .toBe('300000')
  })
})

describe('the Node list', () => {
  it('is the Run Calls in node order, each with its own status', () => {
    const nodes = toRunNodes([
      call({ nodeIndex: 2, nodeType: 'risk', status: 'pending' }),
      call({ nodeIndex: 0, nodeType: 'data', status: 'succeeded' }),
      call({ nodeIndex: 1, nodeType: 'research', status: 'paid_awaiting_result' }),
    ])
    expect(nodes).toEqual([
      { node_type: 'data', status: 'succeeded' },
      { node_type: 'research', status: 'paid_awaiting_result' },
      { node_type: 'risk', status: 'pending' },
    ])
  })

  it('leaves verification Calls out of the chain', () => {
    const nodes = toRunNodes([
      call({ nodeIndex: 0, nodeType: 'data' }),
      call({ kind: 'verification', nodeIndex: 0, nodeType: 'notify' }),
    ])
    expect(nodes).toEqual([{ node_type: 'data', status: 'succeeded' }])
  })
})

describe('the row view model', () => {
  it('carries every field the feed renders, and parses as runSummary (AD-14)', () => {
    const summary = toRunSummary(
      row({
        status: 'failed at research',
        failureReason: 'price mismatch: locked 10000, 402 asked 12000',
        endedAt: new Date('2026-09-05T02:00:09.000Z'),
        calls: [
          call({ nodeIndex: 0, nodeType: 'data', status: 'succeeded', lockedPrice: '10000' }),
          call({ nodeIndex: 1, nodeType: 'research', status: 'price_mismatch', lockedPrice: '25000' }),
        ],
      }),
    )

    expect(summary).toMatchObject({
      id: 'run_01K4RWZ8QY7M3B0P5X2A9TGCVD',
      workflow_name: 'BNB momentum desk',
      status: 'failed at research',
      failure_reason: 'price mismatch: locked 10000, 402 asked 12000',
      total_cost: '10000',
      created_at: '2026-09-05T02:00:00.000Z',
      started_at: '2026-09-05T02:00:01.000Z',
      ended_at: '2026-09-05T02:00:09.000Z',
      nodes: [
        { node_type: 'data', status: 'succeeded' },
        { node_type: 'research', status: 'price_mismatch' },
      ],
    })
    expect(runSummary.parse(summary)).toEqual(summary)
  })

  it('leaves a Run that has not started or ended with null timestamps', () => {
    const summary = toRunSummary(row({ startedAt: null, endedAt: null, calls: [] }))
    expect(summary.started_at).toBeNull()
    expect(summary.ended_at).toBeNull()
    expect(summary.total_cost).toBe('0')
    expect(summary.nodes).toEqual([])
    expect(() => runSummary.parse(summary)).not.toThrow()
  })

  it('names a missing join rather than shipping a blank cell', () => {
    const summary = toRunSummary(row({ workflowName: null, symbol: null, walletAddress: null }))
    expect(summary.workflow_name).toBe('unknown Workflow')
    expect(summary.wallet_address).toBeNull()
    expect(() => runSummary.parse(summary)).not.toThrow()
  })
})

describe('the keyset cursor', () => {
  const rows = [
    row({ id: 'run_03' }),
    row({ id: 'run_02' }),
    row({ id: 'run_01' }),
  ]

  it('answers the last id of the page when a further row was fetched', () => {
    // The caller asks for limit + 1; the third row is what says "there is more".
    const page = toRunFeedPage(rows, 2)
    expect(page.items.map((item) => item.id)).toEqual(['run_03', 'run_02'])
    expect(page.next).toBe('run_02')
  })

  it('answers null when the page is the last one', () => {
    const page = toRunFeedPage(rows, 3)
    expect(page.items).toHaveLength(3)
    expect(page.next).toBeNull()
  })

  it('answers null for an empty feed', () => {
    expect(toRunFeedPage([], 20)).toEqual({ items: [], next: null })
  })

  it('keeps the newest-first order it was given', () => {
    expect(toRunFeedPage(rows, 10).items.map((item) => item.id)).toEqual([
      'run_03',
      'run_02',
      'run_01',
    ])
  })
})

describe('?limit= and ?cursor=', () => {
  const query = (search: string) => parseRunFeedQuery(new URLSearchParams(search))

  it('defaults an absent limit and carries an absent cursor as null', () => {
    expect(query('')).toEqual({ limit: RUN_FEED_DEFAULT_LIMIT, cursor: null })
  })

  it('takes a limit inside the bounds', () => {
    expect(query('limit=5')).toEqual({ limit: 5, cursor: null })
  })

  it('falls back to the default rather than refusing a nonsense limit', () => {
    for (const search of ['limit=0', 'limit=-3', 'limit=abc', 'limit=2.5', 'limit=']) {
      expect(query(search).limit).toBe(RUN_FEED_DEFAULT_LIMIT)
    }
  })

  it('clamps to the ceiling rather than serving the whole table', () => {
    expect(query(`limit=${RUN_FEED_MAX_LIMIT}`).limit).toBe(RUN_FEED_MAX_LIMIT)
    expect(query(`limit=${RUN_FEED_MAX_LIMIT + 1}`).limit).toBe(RUN_FEED_MAX_LIMIT)
    expect(query('limit=100000').limit).toBe(RUN_FEED_MAX_LIMIT)
  })

  it('passes a cursor through untouched, and an empty one as no cursor', () => {
    expect(query('cursor=run_01K4RWZ8QY7M3B0P5X2A9TGCVD').cursor).toBe(
      'run_01K4RWZ8QY7M3B0P5X2A9TGCVD',
    )
    expect(query('cursor=').cursor).toBeNull()
  })

  it('keeps the cursor even when the limit beside it is nonsense', () => {
    expect(query('limit=abc&cursor=run_02')).toEqual({
      limit: RUN_FEED_DEFAULT_LIMIT,
      cursor: 'run_02',
    })
  })
})
