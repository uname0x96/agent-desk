import type { Side, Signal } from '@agent-desk/schemas'
import { align, ratio, ratioAtMost, relativeGapBelow, type Fraction } from './decimal.ts'

/**
 * PRD addendum §4, the normative Settlement computation, as three pure
 * functions. Nothing in this file reads a clock, a database, or the network:
 * that is what lets the rules be tested exhaustively, which AD-9 needs because
 * a wrong rule here moves real tUSD out of a Creator's Stake.
 *
 * The three rules, transcribed from §4:
 *
 *   - "Production mode research rule: window end price against start price.
 *      LONG passes if end > start; SHORT passes if end < start; HOLD passes if
 *      |end - start| / start < 0.001."
 *   - "Demo mode research rule: `change_24h_pct` from the 24h ticker at window
 *      end. LONG passes if positive; SHORT passes if negative; HOLD passes if
 *      |value| < 0.5."
 *   - "Risk rule (both modes): for a BUY, drawdown = (p_fill - min price in
 *      window) / p_fill; for a SELL, (max price in window - p_fill) / p_fill,
 *      where p_fill is the production `lastPrice` at fill time. Pass if
 *      drawdown <= 0.02."
 *
 * Every comparison is exact (see `decimal.ts`) except the demo rule's, whose
 * input `change_24h_pct` is already a number on the wire.
 */

/** The two results a rule can reach. `not_scored` is a decision not to apply one. */
export type ScoreOutcome = 'passed' | 'failed'

/** §4: HOLD passes below a 0.1 % move over the window. */
export const HOLD_BAND_RELATIVE: Fraction = { numerator: 1n, denominator: 1000n }

/** §4: HOLD passes below half a percent of 24 h change. */
export const HOLD_BAND_PCT = 0.5

/** §4: a risk Call passes at or below a 2 % drawdown. */
export const MAX_DRAWDOWN: Fraction = { numerator: 2n, denominator: 100n }

/** Story 4.1, verbatim: what a scored `risk` row records as its rule. */
export const RISK_RULE_LABEL = 'risk rule: 2% drawdown in window'

/** Story 4.2, verbatim: what a Call that took payment and then failed records. */
export const FAILED_AFTER_PAYMENT_RULE_LABEL = 'failed after payment'

/**
 * §4 production research rule. `start` is the Call's own `reference_price`,
 * `end` the `lastPrice` read at window end (AD-9).
 *
 * HOLD is a band, not the complement of LONG and SHORT: a HOLD inside the band
 * passes, and LONG and SHORT are decided by direction alone, so a rise of one
 * ten-thousandth passes LONG *and* HOLD. That is what §4 says, and it is the
 * intended asymmetry — a signal is judged against what it claimed, not against
 * the other two signals.
 */
export function scoreResearchProduction(signal: Signal, start: string, end: string): ScoreOutcome {
  const [startUnits, endUnits] = align([start, end]) as [bigint, bigint]
  switch (signal) {
    case 'LONG':
      return endUnits > startUnits ? 'passed' : 'failed'
    case 'SHORT':
      return endUnits < startUnits ? 'passed' : 'failed'
    case 'HOLD':
      return relativeGapBelow(endUnits, startUnits, HOLD_BAND_RELATIVE) ? 'passed' : 'failed'
  }
}

/**
 * §4 demo research rule. `change24hPct` is the 24 h ticker's
 * `priceChangePercent` read at window end, in percent (-1.732 is a 1.732 % fall).
 */
export function scoreResearchDemo(signal: Signal, change24hPct: number): ScoreOutcome {
  if (!Number.isFinite(change24hPct)) return 'failed'
  switch (signal) {
    case 'LONG':
      return change24hPct > 0 ? 'passed' : 'failed'
    case 'SHORT':
      return change24hPct < 0 ? 'passed' : 'failed'
    case 'HOLD':
      return Math.abs(change24hPct) < HOLD_BAND_PCT ? 'passed' : 'failed'
  }
}

/**
 * §4 risk rule, both modes. `windowMin` is read for a BUY and `windowMax` for a
 * SELL; the other may be null, because Story 4.1 asks for "the window min *or*
 * max" and recording a price the rule did not use would misread the Settlement
 * view, which prints "the prices used".
 *
 * A drawdown at exactly 2 % passes: §4 says `<= 0.02`.
 */
export function scoreRisk(
  side: Side,
  pFill: string,
  windowMin: string | null,
  windowMax: string | null,
): ScoreOutcome {
  const { numerator, denominator } = drawdownTerms(side, pFill, windowMin, windowMax)
  return ratioAtMost(numerator, denominator, MAX_DRAWDOWN) ? 'passed' : 'failed'
}

/**
 * The same drawdown as a number, for logs and for a test to read. `scoreRisk`
 * does not use it: a float comparison against 0.02 is exactly what the exact
 * path exists to avoid.
 */
export function riskDrawdown(
  side: Side,
  pFill: string,
  windowMin: string | null,
  windowMax: string | null,
): number {
  // A diagnostic never throws: a log line about a Call the rule refused to
  // score should say "no drawdown", not take the tick down with it.
  if ((side === 'BUY' ? windowMin : windowMax) === null) return Number.NaN
  const { numerator, denominator } = drawdownTerms(side, pFill, windowMin, windowMax)
  return ratio(numerator, denominator)
}

/**
 * §4 verbatim: for a BUY the numerator is `p_fill - min`, for a SELL it is
 * `max - p_fill`; the denominator is `p_fill` either way. Both rule functions
 * read the same two terms so they can never disagree about a boundary.
 */
function drawdownTerms(
  side: Side,
  pFill: string,
  windowMin: string | null,
  windowMax: string | null,
): { numerator: bigint; denominator: bigint } {
  const extreme = side === 'BUY' ? windowMin : windowMax
  if (extreme === null) {
    throw new Error(`the risk rule needs a window ${side === 'BUY' ? 'min' : 'max'} for a ${side}`)
  }
  const [fill, edge] = align([pFill, extreme]) as [bigint, bigint]
  return { numerator: side === 'BUY' ? fill - edge : edge - fill, denominator: fill }
}
