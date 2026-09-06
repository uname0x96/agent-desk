import { describe, expect, it } from 'vitest'
import { toBaseUnits } from '@agent-desk/schemas'
import {
  bnbToWei,
  checkCreatorStakeMinimum,
  checkDailyFeeBudget,
  checkGasFloor,
  checkStakeReservation,
  checkVerificationCap,
  weiToBnb,
} from './policy.ts'

/**
 * Every case here is a clause of AD-5's rule text: change the rule and a case
 * must change. Amounts are written in tUSD and converted with the one
 * conversion the repository has (AD-13), so a fixture never spells out a
 * base-unit integer by hand.
 */

const tusd = (decimal: string) => toBaseUnits(decimal)

describe('checkDailyFeeBudget (FR-3)', () => {
  it('passes when the spend plus this Call fits the budget', () => {
    const refusal = checkDailyFeeBudget(
      { spend: tusd('0.90'), budget: tusd('1'), callCounted: false },
      tusd('0.10'),
    )
    expect(refusal).toBeNull()
  })

  it('refuses with refused_budget and the shortfall', () => {
    const refusal = checkDailyFeeBudget(
      { spend: tusd('0.95'), budget: tusd('1'), callCounted: false },
      tusd('0.10'),
    )
    expect(refusal?.code).toBe('refused_budget')
    expect(refusal?.check).toBe('daily_fee_budget')
    expect(refusal?.details.shortfall).toBe(tusd('0.05').toString())
    expect(refusal?.message).toContain('0.05')
  })

  it('does not count the Call twice when the AD-3 query already includes it', () => {
    // The Call is `pending` in a still-`running` Run, so `spend` contains it.
    // Adding the amount again would refuse a Run the API already admitted.
    const usage = { spend: tusd('1'), budget: tusd('1'), callCounted: true }
    expect(checkDailyFeeBudget(usage, tusd('0.10'))).toBeNull()
    expect(checkDailyFeeBudget({ ...usage, callCounted: false }, tusd('0.10'))).not.toBeNull()
  })

  it('admits a spend exactly at the budget', () => {
    expect(
      checkDailyFeeBudget({ spend: tusd('0.9'), budget: tusd('1'), callCounted: false }, tusd('0.1')),
    ).toBeNull()
  })
})

describe('checkStakeReservation (FR-25)', () => {
  const usage = { stake: tusd('0.30'), reserved: tusd('0.25'), callCounted: false }

  it('reserves Stake for research and risk only', () => {
    expect(checkStakeReservation('research', usage, tusd('0.10'))?.code).toBe('refused_stake')
    expect(checkStakeReservation('risk', usage, tusd('0.10'))?.code).toBe('refused_stake')
    for (const type of ['data', 'execution', 'notify'] as const) {
      expect(checkStakeReservation(type, usage, tusd('0.10'))).toBeNull()
    }
  })

  it('passes when the free Stake covers the Call', () => {
    expect(checkStakeReservation('research', usage, tusd('0.05'))).toBeNull()
  })

  it('names the shortfall', () => {
    const refusal = checkStakeReservation('risk', usage, tusd('0.10'))
    expect(refusal?.check).toBe('stake_reservation')
    expect(refusal?.details.shortfall).toBe(tusd('0.05').toString())
    expect(refusal?.message).toContain('stake exhausted')
  })

  it('is a boundary at exactly the free Stake', () => {
    expect(checkStakeReservation('research', usage, tusd('0.05'))).toBeNull()
    expect(checkStakeReservation('research', usage, tusd('0.050001'))).not.toBeNull()
  })
})

describe('checkCreatorStakeMinimum (FR-7, FR-9)', () => {
  it('passes at exactly ten times the price', () => {
    expect(checkCreatorStakeMinimum(tusd('0.01'), tusd('0.10'))).toBeNull()
  })

  it('refuses one base unit below', () => {
    const refusal = checkCreatorStakeMinimum(tusd('0.01'), tusd('0.10') - 1n)
    expect(refusal?.code).toBe('refused_stake')
    expect(refusal?.check).toBe('creator_stake_minimum')
    expect(refusal?.details.required).toBe(tusd('0.10').toString())
    expect(refusal?.details.shortfall).toBe('1')
  })

  it('passes with more Stake than the floor', () => {
    expect(checkCreatorStakeMinimum(tusd('0.01'), tusd('1'))).toBeNull()
  })
})

describe('checkVerificationCap (FR-11)', () => {
  it('passes below the cap', () => {
    expect(
      checkVerificationCap({ spent: tusd('4'), cap: tusd('5'), callCounted: false }, tusd('1')),
    ).toBeNull()
  })

  it('refuses with refused_budget past the cap', () => {
    const refusal = checkVerificationCap(
      { spent: tusd('4.99'), cap: tusd('5'), callCounted: false },
      tusd('0.02'),
    )
    expect(refusal?.code).toBe('refused_budget')
    expect(refusal?.check).toBe('verification_cap')
    expect(refusal?.details.shortfall).toBe(tusd('0.01').toString())
  })
})

describe('checkGasFloor', () => {
  it('passes at the floor', () => {
    expect(checkGasFloor(bnbToWei('0.005'), bnbToWei('0.005'))).toBeNull()
  })

  it('refuses below it with refused_balance', () => {
    const refusal = checkGasFloor(bnbToWei('0.004'), bnbToWei('0.005'))
    expect(refusal?.code).toBe('refused_balance')
    expect(refusal?.check).toBe('gas_floor')
    expect(refusal?.details.shortfall_wei).toBe(bnbToWei('0.001').toString())
    expect(refusal?.message).toContain('0.004')
  })
})

describe('BNB conversions', () => {
  it('round-trips the three env floors', () => {
    for (const value of ['0.005', '0.02', '0.05', '1', '0']) {
      expect(weiToBnb(bnbToWei(value))).toBe(value)
    }
  })

  it('refuses a value that is not a decimal amount', () => {
    expect(() => bnbToWei('-1')).toThrow()
    expect(() => bnbToWei('1e18')).toThrow()
  })
})
