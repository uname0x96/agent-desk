import { describe, expect, it } from 'vitest'
import type { Side, Signal } from '@agent-desk/schemas'
import {
  HOLD_BAND_PCT,
  MAX_DRAWDOWN,
  RISK_RULE_LABEL,
  FAILED_AFTER_PAYMENT_RULE_LABEL,
  riskDrawdown,
  scoreResearchDemo,
  scoreResearchProduction,
  scoreRisk,
} from './rules.ts'
import { align, ratio, ratioAtMost, relativeGapBelow } from './decimal.ts'

/**
 * PRD addendum §4 is the normative text; every case below quotes the clause it
 * pins down. Story 4.1 asks for a passing example, a failing example, and a
 * boundary case per rule — the boundaries are the interesting half, because
 * they are where a float comparison would give a different verdict from the
 * exact one and slash a Creator who was right.
 */

describe('scoreResearchProduction — §4 "window end price against start price"', () => {
  describe('LONG passes if end > start', () => {
    it('passes on a rise', () => {
      expect(scoreResearchProduction('LONG', '600', '612.40')).toBe('passed')
    })
    it('fails on a fall', () => {
      expect(scoreResearchProduction('LONG', '600', '599.99')).toBe('failed')
    })
    it('fails on exactly flat: the boundary is strict', () => {
      expect(scoreResearchProduction('LONG', '600', '600')).toBe('failed')
      expect(scoreResearchProduction('LONG', '600', '600.000000')).toBe('failed')
    })
    it('passes on the smallest rise the strings can express', () => {
      expect(scoreResearchProduction('LONG', '600.00000000', '600.00000001')).toBe('passed')
    })
  })

  describe('SHORT passes if end < start', () => {
    it('passes on a fall', () => {
      expect(scoreResearchProduction('SHORT', '600', '588.10')).toBe('passed')
    })
    it('fails on a rise', () => {
      expect(scoreResearchProduction('SHORT', '600', '600.01')).toBe('failed')
    })
    it('fails on exactly flat', () => {
      expect(scoreResearchProduction('SHORT', '600', '600')).toBe('failed')
    })
  })

  describe('HOLD passes if |end - start| / start < 0.001', () => {
    it('passes inside the band, in both directions', () => {
      // 600 * 0.001 = 0.6, so 0.59 either way is inside.
      expect(scoreResearchProduction('HOLD', '600', '600.59')).toBe('passed')
      expect(scoreResearchProduction('HOLD', '600', '599.41')).toBe('passed')
    })
    it('fails outside the band', () => {
      expect(scoreResearchProduction('HOLD', '600', '601')).toBe('failed')
      expect(scoreResearchProduction('HOLD', '600', '598')).toBe('failed')
    })
    it('fails at exactly 0.001: §4 says "<", not "<="', () => {
      expect(scoreResearchProduction('HOLD', '600', '600.6')).toBe('failed')
      expect(scoreResearchProduction('HOLD', '600', '599.4')).toBe('failed')
    })
    it('passes one unit inside that exact boundary', () => {
      expect(scoreResearchProduction('HOLD', '600', '600.599999')).toBe('passed')
    })
    it('passes on no move at all', () => {
      expect(scoreResearchProduction('HOLD', '600', '600')).toBe('passed')
    })
  })

  it('compares decimals of different widths without a float', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; these strings must not care.
    expect(scoreResearchProduction('LONG', '0.3', '0.30000000000000004')).toBe('passed')
    expect(scoreResearchProduction('SHORT', '0.30000000000000004', '0.3')).toBe('passed')
  })

  it('refuses to pass a HOLD against a zero start price', () => {
    // A zero reference price is a broken read, not a flat market.
    expect(scoreResearchProduction('HOLD', '0', '0')).toBe('failed')
  })

  it('covers every signal', () => {
    const signals: Signal[] = ['LONG', 'SHORT', 'HOLD']
    for (const signal of signals) {
      expect(['passed', 'failed']).toContain(scoreResearchProduction(signal, '600', '601'))
    }
  })
})

describe('scoreResearchDemo — §4 "change_24h_pct from the 24h ticker"', () => {
  it('LONG passes if positive, fails otherwise', () => {
    expect(scoreResearchDemo('LONG', 1.8)).toBe('passed')
    expect(scoreResearchDemo('LONG', -1.8)).toBe('failed')
    expect(scoreResearchDemo('LONG', 0)).toBe('failed')
  })

  it('SHORT passes if negative, fails otherwise', () => {
    expect(scoreResearchDemo('SHORT', -1.732)).toBe('passed')
    expect(scoreResearchDemo('SHORT', 1.732)).toBe('failed')
    expect(scoreResearchDemo('SHORT', 0)).toBe('failed')
  })

  it('HOLD passes if |value| < 0.5, and the boundary is strict', () => {
    expect(scoreResearchDemo('HOLD', 0.49)).toBe('passed')
    expect(scoreResearchDemo('HOLD', -0.49)).toBe('passed')
    expect(scoreResearchDemo('HOLD', HOLD_BAND_PCT)).toBe('failed')
    expect(scoreResearchDemo('HOLD', -HOLD_BAND_PCT)).toBe('failed')
    expect(scoreResearchDemo('HOLD', 0.6)).toBe('failed')
  })

  it('fails every signal on a value the ticker could not produce', () => {
    for (const signal of ['LONG', 'SHORT', 'HOLD'] as Signal[]) {
      expect(scoreResearchDemo(signal, Number.NaN)).toBe('failed')
    }
  })

  it('scores Sloppy Research failed and Alpha Research passed on the same tick', () => {
    // The demo beat: both read the same +1.2 % market, one fades it.
    expect(scoreResearchDemo('SHORT', 1.2)).toBe('failed')
    expect(scoreResearchDemo('LONG', 1.2)).toBe('passed')
  })
})

describe('scoreRisk — §4 "pass if drawdown <= 0.02"', () => {
  describe('BUY: drawdown = (p_fill - min price in window) / p_fill', () => {
    it('passes on a shallow dip', () => {
      // (600 - 594) / 600 = 0.01
      expect(scoreRisk('BUY', '600', '594', null)).toBe('passed')
    })
    it('fails on a deep dip', () => {
      // (600 - 570) / 600 = 0.05
      expect(scoreRisk('BUY', '600', '570', null)).toBe('failed')
    })
    it('passes at exactly 2 %: §4 says "<=" ', () => {
      // (600 - 588) / 600 = 0.02
      expect(scoreRisk('BUY', '600', '588', null)).toBe('passed')
      expect(riskDrawdown('BUY', '600', '588', null)).toBeCloseTo(0.02, 12)
    })
    it('fails one base unit past that boundary', () => {
      expect(scoreRisk('BUY', '600', '587.999999', null)).toBe('failed')
    })
    it('passes when the market never went below the fill', () => {
      expect(scoreRisk('BUY', '600', '601', null)).toBe('passed')
      expect(riskDrawdown('BUY', '600', '601', null)).toBeLessThan(0)
    })
  })

  describe('SELL: drawdown = (max price in window - p_fill) / p_fill', () => {
    it('passes on a shallow rally', () => {
      expect(scoreRisk('SELL', '600', null, '606')).toBe('passed')
    })
    it('fails on a sharp rally', () => {
      expect(scoreRisk('SELL', '600', null, '630')).toBe('failed')
    })
    it('passes at exactly 2 %', () => {
      expect(scoreRisk('SELL', '600', null, '612')).toBe('passed')
      expect(riskDrawdown('SELL', '600', null, '612')).toBeCloseTo(0.02, 12)
    })
    it('fails one base unit past that boundary', () => {
      expect(scoreRisk('SELL', '600', null, '612.000001')).toBe('failed')
    })
    it('passes when the market never went above the fill', () => {
      expect(scoreRisk('SELL', '600', null, '599')).toBe('passed')
    })
  })

  it('reads only the extreme its side needs', () => {
    // A BUY ignores the max entirely, and a SELL the min.
    expect(scoreRisk('BUY', '600', '594', '10000')).toBe('passed')
    expect(scoreRisk('SELL', '600', '1', '606')).toBe('passed')
  })

  it('refuses to score a side whose extreme is missing', () => {
    const sides: Side[] = ['BUY', 'SELL']
    for (const side of sides) {
      expect(() => scoreRisk(side, '600', side === 'BUY' ? null : '600', side === 'SELL' ? null : '600')).toThrow(
        /needs a window/,
      )
    }
    expect(riskDrawdown('BUY', '600', null, '600')).toBeNaN()
  })

  it('refuses a zero fill price rather than dividing by it', () => {
    expect(scoreRisk('BUY', '0', '0', null)).toBe('failed')
  })
})

describe('the exact comparisons behind the rules', () => {
  it('aligns decimals of different widths to one scale', () => {
    expect(align(['1', '1.5', '1.25'])).toEqual([100n, 150n, 125n])
    expect(align(['0', '0.000001'])).toEqual([0n, 1n])
  })

  it('rejects anything that is not a non-negative decimal', () => {
    for (const bad of ['', '-1', '1.', '.5', 'abc', '1e3', '01']) {
      expect(() => align([bad])).toThrow(/not a decimal amount/)
    }
  })

  it('decides ratios without a float', () => {
    expect(ratioAtMost(2n, 100n, MAX_DRAWDOWN)).toBe(true)
    expect(ratioAtMost(3n, 100n, MAX_DRAWDOWN)).toBe(false)
    expect(ratioAtMost(-5n, 100n, MAX_DRAWDOWN)).toBe(true)
    expect(ratioAtMost(1n, 0n, MAX_DRAWDOWN)).toBe(false)
    expect(ratio(1n, 4n)).toBe(0.25)
    expect(ratio(1n, 0n)).toBeNaN()
    expect(relativeGapBelow(1001n, 1000n, { numerator: 1n, denominator: 1000n })).toBe(false)
    expect(relativeGapBelow(1000n, 0n, { numerator: 1n, denominator: 1000n })).toBe(false)
  })
})

describe('the rule labels the Settlement view prints verbatim', () => {
  it('names the risk rule and the failure-after-payment rule as the stories fix them', () => {
    expect(RISK_RULE_LABEL).toBe('risk rule: 2% drawdown in window')
    expect(FAILED_AFTER_PAYMENT_RULE_LABEL).toBe('failed after payment')
  })
})
