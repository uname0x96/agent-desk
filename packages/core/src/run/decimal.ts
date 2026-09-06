/**
 * Comparison of the decimal USDT strings PRD addendum §1 carries in every Type
 * payload: `proposed_size_usdt`, `balance_usdt`, `size_usdt`, the Order Cap and
 * the exchange minimum notional.
 *
 * AD-13 keeps money off floats. `packages/schemas` owns the base-unit
 * conversions (`toBaseUnits`, `toDecimalUsdt`) but exposes no comparison, and a
 * decimal amount on the wire may carry more precision than tUSD's six places —
 * `filled_qty` and an exchange's `size_usdt` both can — so `toBaseUnits` is the
 * wrong tool here: it throws on a seventh decimal place rather than compare it.
 * This pads both fractions to the same width and compares two BigInts.
 */

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/

export function isDecimalAmount(value: string): boolean {
  return DECIMAL.test(value)
}

/**
 * -1, 0 or 1. Throws on anything that is not a non-negative decimal string,
 * because every caller has already had the value through a Zod schema and a
 * silent "equal" would hide a real mismatch.
 */
export function compareDecimal(left: string, right: string): number {
  if (!DECIMAL.test(left)) throw new Error(`not a decimal amount: ${left}`)
  if (!DECIMAL.test(right)) throw new Error(`not a decimal amount: ${right}`)
  const [leftWhole = '0', leftFraction = ''] = left.split('.')
  const [rightWhole = '0', rightFraction = ''] = right.split('.')
  const width = Math.max(leftFraction.length, rightFraction.length)
  const a = BigInt(leftWhole + leftFraction.padEnd(width, '0'))
  const b = BigInt(rightWhole + rightFraction.padEnd(width, '0'))
  return a === b ? 0 : a < b ? -1 : 1
}
