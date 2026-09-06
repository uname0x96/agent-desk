import { describe, expect, it } from 'vitest'
import { agentHistoryResponse, type AgentHistoryResponse } from '@agent-desk/schemas'
import type { ChainTxView } from './listing-progress.ts'
import {
  PLATFORM_LISTED_NOTE,
  REPUTATION_CHART,
  agentRecordAccess,
  describeVerification,
  hasPendingHistory,
  orderHistory,
  pauseHistory,
  priceHistory,
  reputationChart,
  reputationSeries,
  reputationY,
  stakeHistory,
  toAgentHistory,
  toHistoryRow,
} from './listing-history.ts'

/**
 * Story 5.4. What `GET /api/listings/<id>/history` and `/agents/<listing_id>`
 * decide, decided without a database, a chain, or a browser.
 *
 * The fixtures are the payloads the writers really produce: `runList` in
 * `packages/core/listing/verify.ts` for `list:`, `requestListingWrite` for
 * `price:`, `stake:` and `pause:`, and `createSettlementChain` for `slash:` and
 * `reputation:`. If one of those changes shape, a test here is what says so.
 */

const LISTING = 'lst_00000000000000000000AGENT1'
const CALL = 'call_00000000000000000000SLASH1'
const hash = (byte: string) => `0x${byte.repeat(64)}`

function row(overrides: Partial<ChainTxView> & Pick<ChainTxView, 'intent_key'>): ChainTxView {
  return {
    status: 'confirmed',
    tx_hash: hash('a'),
    payload: {},
    created_at: '2026-09-05T09:00:00.000Z',
    confirmed_at: '2026-09-05T09:00:03.000Z',
    ...overrides,
  }
}

/** AD-8: `{ listing_id, before: { price, stake, paused }, after: { ... } }`. */
function listed(price: string, stake: string): ChainTxView {
  return row({
    intent_key: `list:${LISTING}`,
    payload: {
      listing_id: LISTING,
      before: { price: '0', stake: '0', paused: false },
      after: { price, stake, paused: false },
      agent_id: '11',
    },
    created_at: '2026-09-05T09:00:00.000Z',
    confirmed_at: '2026-09-05T09:00:04.000Z',
  })
}

function priced(n: number, before: string, after: string, at: string): ChainTxView {
  return row({
    intent_key: `price:${LISTING}:${n}`,
    payload: {
      listing_id: LISTING,
      before: { price: before, stake: '300000', paused: false },
      after: { price: after },
    },
    created_at: at,
    confirmed_at: at,
  })
}

function staked(n: number, before: string, after: string, at: string): ChainTxView {
  return row({
    intent_key: `stake:${LISTING}:${n}`,
    payload: {
      listing_id: LISTING,
      before: { price: '30000', stake: before, paused: false },
      after: { stake: after },
    },
    created_at: at,
    confirmed_at: at,
  })
}

function paused(n: number, value: boolean, at: string): ChainTxView {
  return row({
    intent_key: `pause:${LISTING}:${n}`,
    payload: {
      listing_id: LISTING,
      before: { price: '30000', stake: '300000', paused: !value },
      after: { paused: value },
    },
    created_at: at,
    confirmed_at: at,
  })
}

/** Story 4.3: `{ listing_id, call_id, settlement_id, amount, to }`. */
function slashed(callId: string, amount: string, at: string): ChainTxView {
  return row({
    intent_key: `slash:${callId}`,
    payload: {
      listing_id: LISTING,
      call_id: callId,
      settlement_id: 'stl_00000000000000000000000001',
      amount,
      to: '0x7609275f0f166d078f59d69d69511d0612e756cb',
    },
    created_at: at,
    confirmed_at: at,
  })
}

/** Story 4.4: `before` and `after` are bare basis points, not a terms object. */
function reputed(
  settlementId: string,
  before: number | null,
  after: number,
  at: string,
  status: ChainTxView['status'] = 'confirmed',
): ChainTxView {
  return row({
    intent_key: `reputation:${LISTING}:${settlementId}`,
    payload: { listing_id: LISTING, settlement_id: settlementId, before, after },
    status,
    created_at: at,
    confirmed_at: status === 'confirmed' ? at : null,
  })
}

function history(chainTx: readonly ChainTxView[], type: AgentHistoryResponse['type'] = 'research') {
  return toAgentHistory({ listingId: LISTING, type, chainTx, verification: null })
}

// -------------------------------------------------------------- the ordering

describe('the history the route answers', () => {
  const body = history([
    reputed('stl_2', 10000, 6667, '2026-09-05T11:00:00.000Z'),
    priced(1_757_150_000_000, '30000', '50000', '2026-09-05T10:00:00.000Z'),
    listed('30000', '300000'),
    slashed(CALL, '30000', '2026-09-05T10:30:00.000Z'),
    staked(1_757_160_000_000, '300000', '400000', '2026-09-05T10:15:00.000Z'),
    paused(1_757_170_000_000, true, '2026-09-05T10:45:00.000Z'),
  ])

  it('answers a body its own schema accepts (AD-14)', () => {
    expect(agentHistoryResponse.safeParse(body).success).toBe(true)
  })

  it('carries all six intents, oldest first, with the list: row leading', () => {
    expect(body.rows.map((entry) => entry.intent)).toEqual([
      'list',
      'price',
      'stake',
      'slash',
      'pause',
      'reputation',
    ])
  })

  it('carries each row’s tx hash and confirmed_at', () => {
    for (const entry of body.rows) {
      expect(entry.tx_hash).toBe(hash('a'))
      expect(entry.confirmed_at).not.toBeNull()
    }
  })

  it('leaves out the identity: row, which is the pipeline and not a change of terms', () => {
    const withIdentity = history([row({ intent_key: `identity:${LISTING}` }), listed('30000', '300000')])
    expect(withIdentity.rows.map((entry) => entry.intent)).toEqual(['list'])
  })

  it('pins the list: row first even when a later row shares its timestamp', () => {
    const same = '2026-09-05T09:00:00.000Z'
    const ordered = orderHistory([
      toHistoryRow(priced(1, '30000', '50000', same))!,
      toHistoryRow(listed('30000', '300000'))!,
    ])
    expect(ordered.map((entry) => entry.intent)).toEqual(['list', 'price'])
  })

  it('separates rows that tie on time by their intent key, which is unique', () => {
    const same = '2026-09-05T10:00:00.000Z'
    const ordered = orderHistory([
      toHistoryRow(priced(2, '50000', '20000', same))!,
      toHistoryRow(priced(1, '30000', '50000', same))!,
    ])
    expect(ordered.map((entry) => entry.intent_key)).toEqual([
      `price:${LISTING}:1`,
      `price:${LISTING}:2`,
    ])
  })

  it('keeps a transaction whose payload is not the shape the writer produces', () => {
    const odd = history([row({ intent_key: `price:${LISTING}:1`, payload: { note: 'legacy' } })])
    expect(odd.rows).toHaveLength(1)
    expect(odd.rows[0]!.before).toEqual({})
    expect(odd.rows[0]!.after).toEqual({})
  })

  it('normalises the three payload dialects into one before/after shape', () => {
    const rows = history([
      listed('30000', '300000'),
      reputed('stl_1', null, 10000, '2026-09-05T11:00:00.000Z'),
      slashed(CALL, '30000', '2026-09-05T10:30:00.000Z'),
    ]).rows
    const byIntent = new Map(rows.map((entry) => [entry.intent, entry]))

    expect(byIntent.get('list')!.after).toEqual({ price: '30000', stake: '300000', paused: false })
    // A first Reputation write has no `before`, and bps stay integers (AD-13).
    expect(byIntent.get('reputation')!.before).toEqual({})
    expect(byIntent.get('reputation')!.after).toEqual({ reputation_bps: 10000 })
    expect(byIntent.get('slash')!.slash).toEqual({
      call_id: CALL,
      settlement_id: 'stl_00000000000000000000000001',
      amount: '30000',
      to: '0x7609275f0f166d078f59d69d69511d0612e756cb',
    })
  })

  it('recovers the Call of a slash: row from its intent key (AD-8)', () => {
    const keyOnly = row({
      intent_key: `slash:${CALL}`,
      payload: { listing_id: LISTING, amount: '30000' },
    })
    expect(toHistoryRow(keyOnly)!.slash).toEqual({
      call_id: CALL,
      settlement_id: null,
      amount: '30000',
      to: null,
    })
  })

  it('polls while a transaction can still move, and stops when none can (AD-12)', () => {
    expect(hasPendingHistory(body)).toBe(false)
    const pending = history([
      row({ intent_key: `price:${LISTING}:1`, status: 'pending', confirmed_at: null }),
    ])
    expect(hasPendingHistory(pending)).toBe(true)
  })
})

// ------------------------------------------------------------ price history

describe('the price history', () => {
  const rows = history([
    listed('30000', '300000'),
    priced(1, '30000', '50000', '2026-09-05T10:00:00.000Z'),
    priced(2, '50000', '20000', '2026-09-05T11:00:00.000Z'),
  ]).rows

  it('pairs each row with the old price its payload captured at enqueue', () => {
    expect(priceHistory(rows).map((point) => [point.old_price, point.new_price])).toEqual([
      [null, '30000'],
      ['30000', '50000'],
      ['50000', '20000'],
    ])
  })

  it('reports no old price for the list: row, because there was none', () => {
    expect(priceHistory(rows)[0]!.old_price).toBeNull()
  })

  it('timestamps a point at its confirmation and carries its tx hash', () => {
    const first = priceHistory(rows)[0]!
    expect(first.at).toBe('2026-09-05T09:00:04.000Z')
    expect(first.tx_hash).toBe(hash('a'))
  })

  it('falls back to the previous new price when a row carries no before', () => {
    const partial = history([
      listed('30000', '300000'),
      row({
        intent_key: `price:${LISTING}:1`,
        payload: { listing_id: LISTING, after: { price: '50000' } },
        created_at: '2026-09-05T10:00:00.000Z',
        confirmed_at: '2026-09-05T10:00:00.000Z',
      }),
    ]).rows
    expect(priceHistory(partial).map((point) => point.old_price)).toEqual([null, '30000'])
  })

  it('uses the enqueue time for a price change that has not confirmed', () => {
    const pending = history([
      row({
        intent_key: `price:${LISTING}:1`,
        status: 'pending',
        tx_hash: null,
        confirmed_at: null,
        payload: { listing_id: LISTING, before: { price: '30000' }, after: { price: '50000' } },
        created_at: '2026-09-05T12:00:00.000Z',
      }),
    ]).rows
    const point = priceHistory(pending)[0]!
    expect(point.at).toBe('2026-09-05T12:00:00.000Z')
    expect(point.status).toBe('pending')
    expect(point.tx_hash).toBeNull()
  })

  it('is empty for a Listing that never reached the Registry', () => {
    expect(priceHistory(history([]).rows)).toEqual([])
  })
})

// -------------------------------------------------------- reputation series

describe('the Reputation series', () => {
  const rows = history([
    reputed('stl_1', null, 10000, '2026-09-05T10:00:00.000Z'),
    reputed('stl_2', 10000, 6667, '2026-09-05T10:30:00.000Z'),
    reputed('stl_3', 6667, 7500, '2026-09-05T11:00:00.000Z'),
  ]).rows

  it('is one point per reputation: row, valued at what that write moved it to', () => {
    expect(reputationSeries(rows).map((point) => point.bps)).toEqual([10000, 6667, 7500])
  })

  it('carries each point’s timestamp and tx hash, so a judge can check one', () => {
    const [first] = reputationSeries(rows)
    expect(first!.at).toBe('2026-09-05T10:00:00.000Z')
    expect(first!.tx_hash).toBe(hash('a'))
  })

  it('leaves out a reverted write, which never became the Registry’s answer (AD-8)', () => {
    const withReverted = history([
      reputed('stl_1', null, 10000, '2026-09-05T10:00:00.000Z'),
      reputed('stl_2', 10000, 5000, '2026-09-05T10:30:00.000Z', 'reverted'),
    ]).rows
    expect(reputationSeries(withReverted).map((point) => point.bps)).toEqual([10000])
  })

  it('is empty for an Agent with no settled Call', () => {
    expect(reputationSeries(history([listed('30000', '300000')]).rows)).toEqual([])
  })
})

describe('the Reputation line', () => {
  const series = reputationSeries(
    history([
      reputed('stl_1', null, 10000, '2026-09-05T10:00:00.000Z'),
      reputed('stl_2', 10000, 5000, '2026-09-05T10:30:00.000Z'),
      reputed('stl_3', 5000, 0, '2026-09-05T11:00:00.000Z'),
    ]).rows,
  )

  it('draws one point per row, evenly spaced across the box', () => {
    const chart = reputationChart(series)!
    expect(chart.dots).toHaveLength(3)
    expect(chart.dots.map((dot) => dot.x)).toEqual([12, 320, 628])
    expect(chart.polyline).toBe('12,12 320,80 628,148')
  })

  it('fixes the axis at 0..100 %, so two Agents are comparable', () => {
    // 100 % sits at the top padding, 0 % at the bottom, whatever the data does.
    expect(reputationY(10000)).toBe(REPUTATION_CHART.padding)
    expect(reputationY(0)).toBe(REPUTATION_CHART.height - REPUTATION_CHART.padding)
    expect(reputationY(5000)).toBe(REPUTATION_CHART.height / 2)
  })

  it('centres a single point rather than pinning it to the left edge', () => {
    const one = reputationChart(series.slice(0, 1))!
    expect(one.dots).toHaveLength(1)
    expect(one.dots[0]!.x).toBe(REPUTATION_CHART.width / 2)
  })

  it('has no geometry at all when nothing has been written', () => {
    expect(reputationChart([])).toBeNull()
  })
})

// ------------------------------------------------------------ stake history

describe('the Stake history', () => {
  const rows = history([
    listed('30000', '300000'),
    staked(1, '300000', '400000', '2026-09-05T10:00:00.000Z'),
    slashed(CALL, '30000', '2026-09-05T10:30:00.000Z'),
  ]).rows

  it('is the stake: and slash: rows, in the order they landed', () => {
    expect(stakeHistory(rows).map((event) => event.kind)).toEqual(['stake', 'slash'])
  })

  it('states what a top-up added and the total it moved the Stake to', () => {
    const [topUp] = stakeHistory(rows)
    expect(topUp!.amount).toBe('100000')
    expect(topUp!.total).toBe('400000')
  })

  it('states a Slash as an amount with no total, because the contract clamps it (AD-9)', () => {
    const slash = stakeHistory(rows)[1]!
    expect(slash.amount).toBe('30000')
    expect(slash.total).toBeNull()
    expect(slash.call_id).toBe(CALL)
    expect(slash.to).toBe('0x7609275f0f166d078f59d69d69511d0612e756cb')
  })

  it('never reports a negative top-up', () => {
    const shrunk = history([staked(1, '400000', '300000', '2026-09-05T10:00:00.000Z')]).rows
    expect(stakeHistory(shrunk)[0]!.amount).toBe('0')
  })

  it('is empty for an Agent whose Stake has not moved since it was listed', () => {
    expect(stakeHistory(history([listed('30000', '300000')]).rows)).toEqual([])
  })
})

describe('the pause history', () => {
  it('is the pause: rows, each stating which way it went', () => {
    const rows = history([
      paused(1, true, '2026-09-05T10:00:00.000Z'),
      paused(2, false, '2026-09-05T11:00:00.000Z'),
    ]).rows
    expect(pauseHistory(rows).map((event) => event.paused)).toEqual([true, false])
  })
})

// ------------------------------------------------------ the verification Call

describe('the verification record', () => {
  const call = {
    id: 'call_00000000000000000000VERIF1',
    status: 'succeeded' as const,
    node_type: 'research' as const,
    locked_price: '30000',
    locked_pay_to: '0x7609275f0f166d078f59d69d69511d0612e756cb',
    attempt: 1,
    failure_reason: null,
    request: { symbol: 'BNBUSDT' },
    response: { signal: 'BUY' },
    payment_tx_hash: hash('b'),
    started_at: '2026-09-05T09:00:00.000Z',
    ended_at: '2026-09-05T09:00:02.000Z',
  }

  it('is the paid Call, for an Agent that was verified', () => {
    const record = describeVerification({
      listing_id: LISTING,
      type: 'research',
      rows: [],
      verification: call,
    })
    expect(record.kind).toBe('call')
    expect(record.call).toEqual(call)
  })

  it('says an execution Agent was listed by the platform without one (FR-11)', () => {
    const record = describeVerification({
      listing_id: LISTING,
      type: 'execution',
      rows: [],
      verification: null,
    })
    expect(record.kind).toBe('platform_listed')
    expect(record.note).toBe('listed by the platform without a verification Call')
    expect(PLATFORM_LISTED_NOTE).toBe('listed by the platform without a verification Call')
    expect(record.call).toBeNull()
  })

  it('says so plainly when a non-execution Agent has no Call recorded', () => {
    const record = describeVerification({
      listing_id: LISTING,
      type: 'notify',
      rows: [],
      verification: null,
    })
    expect(record.kind).toBe('missing')
    expect(record.note).not.toBe(PLATFORM_LISTED_NOTE)
  })
})

// --------------------------------------------------------------- the refusal

describe('who may read an Agent’s record', () => {
  const SESSION = 'acc_00000000000000000000READER'
  const CREATOR = 'acc_00000000000000000000OWNER1'

  it('answers not_found for an id nobody listed', () => {
    expect(agentRecordAccess(null, SESSION)).toBe('not_found')
  })

  it('answers an active or paused Listing to anyone signed in', () => {
    expect(agentRecordAccess({ status: 'active', creatorAccountId: CREATOR }, SESSION)).toBe('ok')
    expect(agentRecordAccess({ status: 'paused', creatorAccountId: CREATOR }, SESSION)).toBe('ok')
  })

  it('answers not_found, never forbidden, for a Listing the marketplace does not show', () => {
    expect(agentRecordAccess({ status: 'verifying', creatorAccountId: CREATOR }, SESSION)).toBe(
      'not_found',
    )
    expect(agentRecordAccess({ status: 'failed', creatorAccountId: CREATOR }, SESSION)).toBe(
      'not_found',
    )
  })

  it('still answers the Creator their own Listing while it is verifying', () => {
    expect(agentRecordAccess({ status: 'verifying', creatorAccountId: SESSION }, SESSION)).toBe('ok')
  })
})
