/**
 * Decimal string arithmetic for the two numbers this agent has to get exactly
 * right: `size_usdt` against `order_ceiling_usdt`, and the fill price the
 * `execution` output schema wants as a decimal string.
 *
 * AD-13 puts every shared conversion in `@agent-desk/schemas`, but that is the
 * tUSD base-unit conversion; these are exchange decimals, which never cross a
 * process boundary. Everything here is BigInt: a float divide of
 * `cummulativeQuoteQty / executedQty` produces `612.4000000000001`, which the
 * output schema then refuses.
 */

/** Enough for every Binance Spot price and quantity; the exchange sends 8. */
export const FILL_PRICE_DECIMALS = 8

/** Working scale for the division; wider than anything the exchange sends. */
const SCALE = 18

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/

export class DecimalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecimalError'
  }
}

/** True for the `decimalAmount` shape of the Type schemas: non-negative, no exponent. */
export function isDecimalString(value: string): boolean {
  return DECIMAL.test(value)
}

/**
 * "612.40000000" -> "612.4", "0.01000000" -> "0.01", "5.00" -> "5". The
 * trailing zeros the exchange pads with are noise, and the schema accepts
 * either, so the output carries the shorter one.
 */
export function normalizeDecimal(value: string): string {
  if (!value.includes('.')) return value
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '')
  return trimmed === '' ? '0' : trimmed
}

/** A non-negative decimal string as an integer scaled by 10^SCALE. */
function toScaled(value: string, label: string): bigint {
  const normalized = value.trim()
  if (!DECIMAL.test(normalized)) {
    throw new DecimalError(`${label} is not a non-negative decimal string: ${value}`)
  }
  const [whole = '0', fraction = ''] = normalized.split('.')
  if (fraction.length > SCALE) {
    throw new DecimalError(`${label} has more than ${SCALE} decimal places: ${value}`)
  }
  return BigInt(whole + fraction.padEnd(SCALE, '0'))
}

function fromScaled(value: bigint, decimals: number): string {
  const digits = value.toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

/** -1, 0 or 1, comparing two non-negative decimal strings by value. */
export function compareDecimal(a: string, b: string): number {
  const left = toScaled(a, 'value')
  const right = toScaled(b, 'value')
  return left === right ? 0 : left < right ? -1 : 1
}

export function isZero(value: string): boolean {
  return toScaled(value, 'value') === 0n
}

/**
 * `numerator / denominator` to `decimals` places, half-up. This is the fill
 * price: cumulative quote divided by executed quantity.
 */
export function divideDecimal(
  numerator: string,
  denominator: string,
  decimals: number = FILL_PRICE_DECIMALS,
): string {
  const top = toScaled(numerator, 'numerator')
  const bottom = toScaled(denominator, 'denominator')
  if (bottom === 0n) throw new DecimalError('cannot divide by zero')
  const shifted = top * 10n ** BigInt(decimals)
  // Half-up, so 1/3 at two places is "0.33" and 2/3 is "0.67".
  const quotient = (shifted * 2n + bottom) / (bottom * 2n)
  return fromScaled(quotient, decimals)
}
