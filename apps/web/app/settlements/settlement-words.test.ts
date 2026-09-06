import { describe, expect, it } from 'vitest'
import { planSettlement, type SettlementCandidate } from '@agent-desk/core/settlement'
import { NOT_SCORED_REASONS, type NotScoredReason } from '@agent-desk/schemas'
import {
  NOT_SCORED_WORDS,
  SLASH_PENDING_LABEL,
  hasPendingSlash,
  isSlashPending,
  notScoredWords,
} from './settlement-words.ts'

/**
 * Story 5.3: "`not_scored` rows show the reason in words" and "a `failed` row
 * whose slash is still `pending` shows 'slash pending'".
 *
 * The wording is checked against the reasons `packages/core/settlement`
 * actually writes rather than against three strings this file made up: each
 * case below runs `planSettlement` over a candidate that produces that reason
 * and asks for the words of whatever it decided. If a reason is ever renamed,
 * these fail here instead of rendering a blank cell on the projector.
 */

const AT = new Date('2026-09-05T03:00:00Z')
const NOW = new Date('2026-09-05T04:00:00Z')

function candidate(overrides: Partial<SettlementCandidate>): SettlementCandidate {
  return {
    callId: 'call_01K4RWZC4T8N1D5F9J3M7QBXV2',
    listingId: 'lst_01K4RWY4T1B6N9C3F8H2J5MDRX',
    runId: 'run_01K4RWZ8QY7M3B0P5X2A9TGCVD',
    kind: 'run',
    nodeType: 'research',
    status: 'succeeded',
    endedAt: AT,
    referencePrice: '612.40',
    symbol: 'BNBUSDT',
    response: { signal: 'LONG', confidence: 0.8, rationale: 'up' },
    runEndedAt: AT,
    fill: null,
    ...overrides,
  }
}

/** The reason of the row core decided to write, or a failure if it wrote none. */
function reasonFrom(input: Partial<SettlementCandidate>): NotScoredReason {
  const step = planSettlement(candidate(input), { mode: 'production', now: NOW })
  if (step.kind !== 'write') throw new Error(`core deferred instead of writing: ${step.kind}`)
  if (step.row.result !== 'not_scored' || step.row.notScoredReason === null) {
    throw new Error(`core scored the Call ${step.row.result} instead of leaving it unscored`)
  }
  return step.row.notScoredReason
}

describe('the words a not_scored row shows', () => {
  it('says "REJECT decision" for the reason a REJECT risk Call produces', () => {
    const reason = reasonFrom({ nodeType: 'risk', response: { decision: 'REJECT', reason: 'no' } })
    expect(reason).toBe('reject_decision')
    expect(notScoredWords(reason)).toBe('REJECT decision')
  })

  it('says "no fill" for the reason a Run that never filled produces', () => {
    const reason = reasonFrom({
      nodeType: 'risk',
      response: { decision: 'APPROVE', size_usdt: '20' },
      fill: null,
    })
    expect(reason).toBe('no_fill')
    expect(notScoredWords(reason)).toBe('no fill')
  })

  it('says "no reference price" for the reason a failed reference read produces', () => {
    const reason = reasonFrom({ referencePrice: null })
    expect(reason).toBe('no_reference_price')
    expect(notScoredWords(reason)).toBe('no reference price')
  })

  it('has words for every reason AD-9 allows, and for no others', () => {
    expect(Object.keys(NOT_SCORED_WORDS).sort()).toEqual([...NOT_SCORED_REASONS].sort())
    for (const reason of NOT_SCORED_REASONS) {
      expect(NOT_SCORED_WORDS[reason].length).toBeGreaterThan(0)
    }
  })

  it('says nothing at all for a scored row, which carries no reason', () => {
    expect(notScoredWords(null)).toBeNull()
  })
})

describe('the slash pending condition', () => {
  const failedPending = { result: 'failed' as const, slash_tx_hash: null }
  const failedSlashed = { result: 'failed' as const, slash_tx_hash: `0x${'5c'.repeat(32)}` }

  it('is exactly a failed row without a slash tx hash', () => {
    expect(isSlashPending(failedPending)).toBe(true)
    expect(isSlashPending(failedSlashed)).toBe(false)
  })

  it('never applies to a row that owes no Slash', () => {
    expect(isSlashPending({ result: 'passed', slash_tx_hash: null })).toBe(false)
    expect(isSlashPending({ result: 'not_scored', slash_tx_hash: null })).toBe(false)
  })

  it('reads the page as pending while any one row still is', () => {
    expect(hasPendingSlash([failedSlashed, failedPending])).toBe(true)
    expect(hasPendingSlash([failedSlashed, { result: 'passed', slash_tx_hash: null }])).toBe(false)
    expect(hasPendingSlash([])).toBe(false)
  })

  it('shows the wording Story 5.3 fixes', () => {
    expect(SLASH_PENDING_LABEL).toBe('slash pending')
  })
})
