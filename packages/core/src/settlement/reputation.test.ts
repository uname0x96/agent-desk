import { describe, expect, it } from 'vitest'
import type { SettlementResult } from '@agent-desk/schemas'
import {
  MAX_REPUTATION_BPS,
  REPUTATION_WINDOW,
  isScoredResult,
  reputationBps,
  reputationPercent,
} from './reputation.ts'

/** AD-9 / FR-36: `passed / (passed + failed)` over the last 30 scored rows. */

const times = (count: number, result: SettlementResult): SettlementResult[] =>
  Array.from({ length: count }, () => result)

describe('reputationBps', () => {
  it('answers null with no scored rows, which the marketplace reads as "no score yet"', () => {
    expect(reputationBps([])).toBeNull()
    expect(reputationBps(['not_scored', 'not_scored'])).toBeNull()
  })

  it('is 10 000 bps for a clean sweep and 0 for none', () => {
    expect(reputationBps(times(3, 'passed'))).toBe(MAX_REPUTATION_BPS)
    expect(reputationBps(times(1, 'failed'))).toBe(0)
  })

  it('ignores not_scored rows entirely', () => {
    // FR-36 divides passed by passed + failed; a REJECT decision is neither.
    expect(reputationBps(['passed', 'not_scored', 'not_scored'])).toBe(MAX_REPUTATION_BPS)
    expect(reputationBps(['passed', 'failed', 'not_scored'])).toBe(5_000)
  })

  it('rounds to the nearest basis point', () => {
    expect(reputationBps(['passed', 'passed', 'failed'])).toBe(6_667)
    expect(reputationBps(['passed', 'failed', 'failed'])).toBe(3_333)
  })

  it('reads only the newest 30, and the caller may hand in more', () => {
    // Newest first: 30 failures then a history of passes must read 0 %.
    const rows: SettlementResult[] = [...times(REPUTATION_WINDOW, 'failed'), ...times(20, 'passed')]
    expect(reputationBps(rows)).toBe(0)

    // One pass at the head of 30 failures moves it by exactly one row.
    const shifted: SettlementResult[] = ['passed', ...times(REPUTATION_WINDOW - 1, 'failed'), 'passed']
    expect(reputationBps(shifted)).toBe(Math.round(10_000 / REPUTATION_WINDOW))
  })

  it('counts the window after not_scored rows are dropped, not before', () => {
    // 30 not_scored rows in front must not push the real results out of view.
    const rows: SettlementResult[] = [...times(REPUTATION_WINDOW, 'not_scored'), 'passed', 'failed']
    expect(reputationBps(rows)).toBe(5_000)
  })

  it('never exceeds the Registry ceiling', () => {
    expect(reputationBps(times(REPUTATION_WINDOW, 'passed'))).toBeLessThanOrEqual(MAX_REPUTATION_BPS)
  })
})

describe('isScoredResult / reputationPercent', () => {
  it('names the two results that count', () => {
    expect(isScoredResult('passed')).toBe(true)
    expect(isScoredResult('failed')).toBe(true)
    expect(isScoredResult('not_scored')).toBe(false)
  })

  it('prints "no score yet" as null and everything else as whole percent', () => {
    expect(reputationPercent(null)).toBeNull()
    expect(reputationPercent(10_000)).toBe('100%')
    expect(reputationPercent(0)).toBe('0%')
    expect(reputationPercent(6_667)).toBe('67%')
  })
})
