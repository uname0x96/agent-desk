import { describe, expect, it } from 'vitest'
import { PRICE_SOURCE, settlementsResponse } from '@agent-desk/schemas'
import { RISK_RULE_LABEL } from '@agent-desk/core/settlement'
import { MODE_CONSTANTS } from '@agent-desk/core/mode'
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parseFilterValue,
  parsePageSize,
  toSettlementRow,
  toSettlementsPage,
  type SettlementRecord,
} from './settlements-page.ts'

/**
 * Story 5.3: `GET /api/settlements` answers `{ items, next }` with every column
 * of the scored Call. What is decided here rather than in SQL is the cursor,
 * the on-the-wire formats of AD-13, and the promise of AD-14 that the body
 * satisfies its own schema — so those are what this file checks.
 */

const SCORED_AT = new Date('2026-09-05T02:00:41.123Z')

function record(overrides: Partial<SettlementRecord> = {}): SettlementRecord {
  return {
    id: 'stl_01K4RX40000000000000000009',
    callId: 'call_01K4RWZC4T8N1D5F9J3M7QBXV2',
    listingId: 'lst_01K4RWY4T1B6N9C3F8H2J5MDRX',
    result: 'passed',
    notScoredReason: null,
    mode: 'demo',
    ruleLabel: MODE_CONSTANTS.demo.researchRuleLabel,
    priceSource: PRICE_SOURCE,
    startPrice: '612.40',
    endPrice: null,
    change24hPct: 1.732,
    pFill: null,
    windowMin: null,
    windowMax: null,
    scoredAt: SCORED_AT,
    slashAmount: null,
    slashTxHash: null,
    refundTo: null,
    reputationTxHash: null,
    runId: 'run_01K4RWZ8QY7M3B0P5X2A9TGCVD',
    nodeType: 'research',
    provider: 'Claude Analyst',
    ...overrides,
  }
}

/** The same row after a Slash: this is what a Builder is on the page to see. */
const slashed = record({
  id: 'stl_01K4RX40000000000000000008',
  result: 'failed',
  mode: 'production',
  ruleLabel: RISK_RULE_LABEL,
  startPrice: null,
  change24hPct: null,
  pFill: '612.55',
  windowMin: '598.10',
  slashAmount: '25000',
  slashTxHash: `0x${'5C'.repeat(32)}`,
  refundTo: '0xA71C3D90E5B28F4607C93D1A2B85E04F7D16C982',
  reputationTxHash: `0x${'7E'.repeat(32)}`,
  nodeType: 'risk',
  provider: 'Volatility Guard',
})

describe('one row on the wire', () => {
  it('carries every field Story 5.3 names', () => {
    expect(toSettlementRow(slashed)).toEqual({
      id: 'stl_01K4RX40000000000000000008',
      call_id: 'call_01K4RWZC4T8N1D5F9J3M7QBXV2',
      listing_id: 'lst_01K4RWY4T1B6N9C3F8H2J5MDRX',
      run_id: 'run_01K4RWZ8QY7M3B0P5X2A9TGCVD',
      node_type: 'risk',
      provider: 'Volatility Guard',
      result: 'failed',
      not_scored_reason: null,
      mode: 'production',
      rule_label: RISK_RULE_LABEL,
      price_source: PRICE_SOURCE,
      start_price: null,
      end_price: null,
      change_24h_pct: null,
      p_fill: '612.55',
      window_min: '598.10',
      window_max: null,
      scored_at: '2026-09-05T02:00:41.123Z',
      slash_amount: '25000',
      slash_tx_hash: `0x${'5c'.repeat(32)}`,
      refund_to: '0xa71c3d90e5b28f4607c93d1a2b85e04f7d16c982',
      reputation_tx_hash: `0x${'7e'.repeat(32)}`,
    })
  })

  it('prints the rule label verbatim, never a rewritten one', () => {
    expect(toSettlementRow(record()).rule_label).toBe('demo settlement rule: 24h trend')
  })

  it('leaves the Slash fields null while the slash is still in flight (AD-9)', () => {
    const row = toSettlementRow(record({ result: 'failed', slashTxHash: null }))
    expect(row.slash_tx_hash).toBeNull()
    expect(row.slash_amount).toBeNull()
    expect(row.refund_to).toBeNull()
  })
})

describe('the page and its cursor', () => {
  const rows = [
    record({ id: 'stl_5' }),
    record({ id: 'stl_4' }),
    record({ id: 'stl_3' }),
    record({ id: 'stl_2' }),
  ]

  it('returns `limit` rows and the last id when a further page exists', () => {
    const page = toSettlementsPage(rows, 3)
    expect(page.items.map((row) => row.id)).toEqual(['stl_5', 'stl_4', 'stl_3'])
    expect(page.next).toBe('stl_3')
  })

  it('returns no cursor when the extra row was not there', () => {
    expect(toSettlementsPage(rows, 4).next).toBeNull()
    expect(toSettlementsPage(rows.slice(0, 2), 4).items).toHaveLength(2)
  })

  it('answers an empty page rather than a cursor that leads nowhere', () => {
    expect(toSettlementsPage([], 50)).toEqual({ items: [], next: null })
  })

  it('produces a body that satisfies its own schema (AD-14)', () => {
    expect(() => settlementsResponse.parse(toSettlementsPage([record(), slashed], 50))).not.toThrow()
  })
})

describe('the query string', () => {
  it('defaults and clamps the page size', () => {
    expect(parsePageSize(null)).toBe(DEFAULT_PAGE_SIZE)
    expect(parsePageSize('nonsense')).toBe(DEFAULT_PAGE_SIZE)
    expect(parsePageSize('0')).toBe(DEFAULT_PAGE_SIZE)
    expect(parsePageSize('-3')).toBe(DEFAULT_PAGE_SIZE)
    expect(parsePageSize('10')).toBe(10)
    expect(parsePageSize('5000')).toBe(MAX_PAGE_SIZE)
  })

  it('reads an empty filter as no filter, not as a filter on nothing', () => {
    expect(parseFilterValue(null)).toBeNull()
    expect(parseFilterValue('')).toBeNull()
    expect(parseFilterValue('   ')).toBeNull()
    expect(parseFilterValue(' run_1 ')).toBe('run_1')
  })
})
