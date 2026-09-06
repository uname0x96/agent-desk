/**
 * Exact arithmetic over the decimal USDT strings a Settlement compares.
 *
 * AD-13 keeps money off floats, and every threshold in PRD addendum §4 is a
 * ratio — `|end - start| / start < 0.001`, `drawdown <= 0.02` — so the rules
 * need subtraction and a comparison against a fraction, not just an ordering.
 * `packages/core/run/decimal.ts` compares two amounts and stops there;
 * `toBaseUnits` is the wrong tool because a Binance price may carry more than
 * tUSD's six decimal places and it throws on the seventh.
 *
 * So this module pads both fractions to one width, reads them as BigInts, and
 * lets the rules multiply out the ratio. Nothing here rounds and nothing here
 * touches a float, which is what makes the boundary cases in `rules.ts`
 * (exactly 0.001, exactly 0.02) decidable rather than a matter of luck.
 */

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/

export function isDecimalAmount(value: string): boolean {
  return DECIMAL.test(value)
}

/**
 * Every value as a BigInt at one shared scale. Throws on anything that is not a
 * non-negative decimal string: every price reaching here has already been
 * through a Zod schema or the `MarketData` port, so a malformed one is a bug to
 * surface, not a comparison to guess at.
 */
export function align(values: readonly string[]): bigint[] {
  const parts = values.map((value) => {
    if (!DECIMAL.test(value)) throw new Error(`not a decimal amount: ${value}`)
    const [whole = '0', fraction = ''] = value.split('.')
    return { whole, fraction }
  })
  const width = parts.reduce((widest, part) => Math.max(widest, part.fraction.length), 0)
  return parts.map((part) => BigInt(part.whole + part.fraction.padEnd(width, '0')))
}

/** A ratio threshold as an exact fraction, so no rule ever writes `0.001`. */
export interface Fraction {
  numerator: bigint
  denominator: bigint
}

/**
 * `|left - right| / right < limit`, decided exactly.
 *
 * A `right` of zero has no ratio at all. Rather than divide by it, this answers
 * false: a start price of zero means the reference read is broken, and a rule
 * that silently passed on it would score a Call it cannot score.
 */
export function relativeGapBelow(left: bigint, right: bigint, limit: Fraction): boolean {
  if (right <= 0n) return false
  const gap = left > right ? left - right : right - left
  return gap * limit.denominator < right * limit.numerator
}

/**
 * `numerator / denominator <= limit`, decided exactly. A negative numerator —
 * the price never moved against the position — passes, which is what a drawdown
 * of "none at all" should do.
 *
 * A denominator of zero answers false for the same reason as above: there is no
 * ratio to compare, so there is nothing to pass.
 */
export function ratioAtMost(numerator: bigint, denominator: bigint, limit: Fraction): boolean {
  if (denominator <= 0n) return false
  return numerator * limit.denominator <= denominator * limit.numerator
}

/**
 * `numerator / denominator` as a JavaScript number, for `settlements`
 * diagnostics and log lines only. No rule branches on this value;
 * {@link ratioAtMost} and {@link relativeGapBelow} decide.
 */
export function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return Number.NaN
  return Number(numerator) / Number(denominator)
}
