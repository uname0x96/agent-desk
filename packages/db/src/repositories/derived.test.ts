import { describe, expect, it } from 'vitest'
import { toBaseUnits } from '@agent-desk/schemas'
import {
  budgetWindowStart,
  countsTowardDailyFeeSpend,
  countsTowardStakeReservation,
  countsTowardVerificationSpend,
  dailyFeeSpend,
  stakeReservation,
  verificationSpend,
  type BudgetSpendRow,
  type StakeReservationRow,
  type VerificationSpendRow,
} from './derived.ts'

/**
 * Fixture rows for the three AD-3 derived amounts. Every case here is a clause
 * of the AD-3 rule text; a change to the rule must change a case.
 */

const at = (iso: string) => new Date(iso)
/** "0.01" -> "10000", so the fixtures read in tUSD. */
const price = (decimal: string) => toBaseUnits(decimal).toString()

const NOON = at('2026-09-06T12:00:00Z')
const MIDNIGHT = at('2026-09-06T00:00:00Z')

function budgetRow(overrides: Partial<BudgetSpendRow> = {}): BudgetSpendRow {
  return {
    kind: 'run',
    status: 'succeeded',
    locked_price: price('0.01'),
    at: at('2026-09-06T10:00:00Z'),
    run_status: 'completed',
    ...overrides,
  }
}

function reservationRow(overrides: Partial<StakeReservationRow> = {}): StakeReservationRow {
  return {
    kind: 'run',
    node_type: 'research',
    status: 'succeeded',
    locked_price: price('0.05'),
    settled: false,
    ...overrides,
  }
}

function verificationRow(overrides: Partial<VerificationSpendRow> = {}): VerificationSpendRow {
  return {
    kind: 'verification',
    status: 'succeeded',
    locked_price: price('0.01'),
    at: at('2026-09-06T06:00:00Z'),
    ...overrides,
  }
}

describe('budgetWindowStart', () => {
  it('is UTC midnight when the account was never reset', () => {
    expect(budgetWindowStart(null, NOON)).toEqual(MIDNIGHT)
  })

  it('is UTC midnight when the last reset was on an earlier day', () => {
    expect(budgetWindowStart(at('2026-09-05T22:00:00Z'), NOON)).toEqual(MIDNIGHT)
  })

  it('is the reset moment when an Operator reset the budget today', () => {
    const reset = at('2026-09-06T09:30:00Z')
    expect(budgetWindowStart(reset, NOON)).toEqual(reset)
  })
})

describe('Daily Fee Budget spend (AD-3)', () => {
  it('counts every paid status', () => {
    const rows = [
      budgetRow({ status: 'paid_awaiting_result' }),
      budgetRow({ status: 'succeeded' }),
      budgetRow({ status: 'failed_after_payment' }),
    ]
    expect(dailyFeeSpend(rows, MIDNIGHT)).toBe(toBaseUnits('0.03'))
  })

  it('counts a pending Call only while its Run is still running', () => {
    const running = budgetRow({ status: 'pending', run_status: 'running' })
    const ended = budgetRow({ status: 'pending', run_status: 'completed, no order' })
    expect(countsTowardDailyFeeSpend(running, MIDNIGHT)).toBe(true)
    expect(countsTowardDailyFeeSpend(ended, MIDNIGHT)).toBe(false)
    expect(dailyFeeSpend([running, ended], MIDNIGHT)).toBe(toBaseUnits('0.01'))
  })

  it('ignores the statuses that never paid', () => {
    const rows = [
      budgetRow({ status: 'price_mismatch' }),
      budgetRow({ status: 'payment_failed' }),
      budgetRow({ status: 'skipped' }),
    ]
    expect(dailyFeeSpend(rows, MIDNIGHT)).toBe(0n)
  })

  it('ignores Calls before the window start', () => {
    const yesterday = budgetRow({ at: at('2026-09-05T23:59:59Z') })
    const today = budgetRow({ at: at('2026-09-06T00:00:00Z') })
    expect(dailyFeeSpend([yesterday, today], MIDNIGHT)).toBe(toBaseUnits('0.01'))
  })

  it('ignores everything before an Operator reset made today', () => {
    const reset = at('2026-09-06T09:30:00Z')
    const before = budgetRow({ at: at('2026-09-06T09:00:00Z') })
    const after = budgetRow({ at: at('2026-09-06T09:31:00Z') })
    expect(dailyFeeSpend([before, after], budgetWindowStart(reset, NOON))).toBe(
      toBaseUnits('0.01'),
    )
  })

  it('never counts a verification Call against an account budget', () => {
    const row = budgetRow({ kind: 'verification', run_status: null })
    expect(countsTowardDailyFeeSpend(row, MIDNIGHT)).toBe(false)
  })

  it('sums a five-node Price Lock without touching a float', () => {
    const rows = ['0.01', '0.05', '0.02', '0.01', '0.005'].map((decimal) =>
      budgetRow({ locked_price: price(decimal) }),
    )
    expect(dailyFeeSpend(rows, MIDNIGHT)).toBe(toBaseUnits('0.095'))
  })

  it('is zero with no rows', () => {
    expect(dailyFeeSpend([], MIDNIGHT)).toBe(0n)
  })
})

describe('Stake reservation (FR-25, AD-3)', () => {
  it('counts unscored paid research and risk Calls', () => {
    const rows = [
      reservationRow({ node_type: 'research', status: 'succeeded' }),
      reservationRow({ node_type: 'risk', status: 'paid_awaiting_result' }),
      reservationRow({ node_type: 'risk', status: 'failed_after_payment' }),
    ]
    expect(stakeReservation(rows)).toBe(toBaseUnits('0.15'))
  })

  it('releases the reservation once the Call has a settlements row', () => {
    const settled = reservationRow({ settled: true })
    const unsettled = reservationRow({ settled: false })
    expect(countsTowardStakeReservation(settled)).toBe(false)
    expect(stakeReservation([settled, unsettled])).toBe(toBaseUnits('0.05'))
  })

  it('ignores the Types AD-9 never scores', () => {
    const rows = [
      reservationRow({ node_type: 'data' }),
      reservationRow({ node_type: 'execution' }),
      reservationRow({ node_type: 'notify' }),
    ]
    expect(stakeReservation(rows)).toBe(0n)
  })

  it('ignores unpaid Calls', () => {
    const rows = [
      reservationRow({ status: 'pending' }),
      reservationRow({ status: 'price_mismatch' }),
      reservationRow({ status: 'payment_failed' }),
      reservationRow({ status: 'skipped' }),
    ]
    expect(stakeReservation(rows)).toBe(0n)
  })

  it('never reserves Stake for a verification Call, which is never scored', () => {
    const row = reservationRow({ kind: 'verification' })
    expect(countsTowardStakeReservation(row)).toBe(false)
  })
})

describe('Platform Wallet verification spend (FR-11, AD-3)', () => {
  const since = at('2026-09-05T12:00:00Z')

  it('counts paid verification Calls inside the 24 h window', () => {
    const rows = [
      verificationRow({ status: 'paid_awaiting_result' }),
      verificationRow({ status: 'succeeded' }),
      verificationRow({ status: 'failed_after_payment' }),
    ]
    expect(verificationSpend(rows, since)).toBe(toBaseUnits('0.03'))
  })

  it('ignores Calls older than the window', () => {
    const stale = verificationRow({ at: at('2026-09-05T11:59:59Z') })
    const fresh = verificationRow({ at: at('2026-09-05T12:00:00Z') })
    expect(verificationSpend([stale, fresh], since)).toBe(toBaseUnits('0.01'))
  })

  it('ignores unpaid verification Calls', () => {
    const rows = [
      verificationRow({ status: 'pending' }),
      verificationRow({ status: 'price_mismatch' }),
      verificationRow({ status: 'payment_failed' }),
    ]
    expect(verificationSpend(rows, since)).toBe(0n)
  })

  it('never counts a Run Call against the verification cap', () => {
    const row = verificationRow({ kind: 'run' })
    expect(countsTowardVerificationSpend(row, since)).toBe(false)
  })

  it('is under the 5 tUSD cap for a normal day of listings', () => {
    const rows = Array.from({ length: 12 }, () => verificationRow({ locked_price: price('0.05') }))
    expect(verificationSpend(rows, since)).toBeLessThan(toBaseUnits('5'))
  })
})
