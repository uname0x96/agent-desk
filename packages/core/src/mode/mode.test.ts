import { describe, expect, it } from 'vitest'
import { PLATFORM_MODES, toDecimalUsdt } from '@agent-desk/schemas'
import { MODE_CONSTANTS, modeConstants, RESEARCH_RULES } from './index.ts'

/**
 * Every case here is one cell of the PRD addendum §6 table. The table is the
 * normative source; if a cell changes there, exactly one case must change here.
 */

describe('MODE_CONSTANTS (PRD addendum §6)', () => {
  it('has a row for every platform mode and no others', () => {
    expect(Object.keys(MODE_CONSTANTS).sort()).toEqual([...PLATFORM_MODES].sort())
  })

  it('production is the 60 minute window on a 60 second poll', () => {
    const production = modeConstants('production')
    expect(production.settlementWindowMs).toBe(60 * 60 * 1_000)
    expect(production.settlementPollMs).toBe(60 * 1_000)
  })

  it('demo is the 20 second window on a 2 second poll', () => {
    const demo = modeConstants('demo')
    expect(demo.settlementWindowMs).toBe(20 * 1_000)
    expect(demo.settlementPollMs).toBe(2 * 1_000)
  })

  it('scores research by the window price move in production and the 24h trend on demo', () => {
    expect(modeConstants('production').researchRule).toBe('window price move')
    expect(modeConstants('demo').researchRule).toBe('24h trend')
    for (const mode of PLATFORM_MODES) {
      expect(RESEARCH_RULES).toContain(modeConstants(mode).researchRule)
    }
  })

  it('uses the addendum §4 wording for the demo rule label', () => {
    // "The Settlement view shows 'demo settlement rule: 24h trend'." — §4, §8.
    expect(modeConstants('demo').researchRuleLabel).toBe('demo settlement rule: 24h trend')
    expect(modeConstants('production').researchRuleLabel).toContain('window price move')
  })

  it('reads drawdown klines at 1 minute in production and 1 second on demo', () => {
    expect(modeConstants('production').klineInterval).toBe('1m')
    expect(modeConstants('demo').klineInterval).toBe('1s')
  })

  it('defaults the Daily Fee Budget to 1 tUSD in production and 100 tUSD on demo', () => {
    // AD-13: base units on the wire and in the row, decimals only for humans.
    expect(toDecimalUsdt(modeConstants('production').defaultDailyFeeBudget)).toBe('1')
    expect(toDecimalUsdt(modeConstants('demo').defaultDailyFeeBudget)).toBe('100')
    expect(modeConstants('production').defaultDailyFeeBudget).toBe('1000000')
    expect(modeConstants('demo').defaultDailyFeeBudget).toBe('100000000')
  })

  it('times a Run out after 120 seconds in both modes', () => {
    for (const mode of PLATFORM_MODES) {
      expect(modeConstants(mode).runTimeoutMs).toBe(120 * 1_000)
    }
  })
})
