/**
 * AD-13: money is integer base units off the wire. These are the only
 * conversions in the repository; nothing else may parse or format an amount.
 */

export const TUSD_DECIMALS = 6 as const

declare const baseUnitsBrand: unique symbol
declare const usdtDecimalBrand: unique symbol

/** An integer amount in tUSD base units, carried as a string in the DB and on the wire. */
export type BaseUnits = string & { readonly [baseUnitsBrand]: true }
/** A human-facing decimal tUSD amount, e.g. "0.05". */
export type UsdtDecimal = string & { readonly [usdtDecimalBrand]: true }

const DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const BASE_UNITS_RE = /^(?:0|[1-9]\d*)$/

export function isDecimalUsdt(value: string): value is UsdtDecimal {
  return DECIMAL_RE.test(value)
}

export function isBaseUnits(value: string): value is BaseUnits {
  return BASE_UNITS_RE.test(value)
}

export function asDecimalUsdt(value: string): UsdtDecimal {
  if (!isDecimalUsdt(value)) throw new Error(`not a decimal USDT amount: ${value}`)
  const fraction = value.split('.')[1]
  if (fraction !== undefined && fraction.length > TUSD_DECIMALS) {
    throw new Error(`more than ${TUSD_DECIMALS} decimal places: ${value}`)
  }
  return value
}

export function asBaseUnits(value: string): BaseUnits {
  if (!isBaseUnits(value)) throw new Error(`not a base-unit integer string: ${value}`)
  return value
}

/** "0.01" -> 10000n */
export function toBaseUnits(decimal: string): bigint {
  const checked = asDecimalUsdt(decimal)
  const [whole, fraction = ''] = checked.split('.')
  const padded = fraction.padEnd(TUSD_DECIMALS, '0')
  return BigInt(whole ?? '0') * 10n ** BigInt(TUSD_DECIMALS) + BigInt(padded === '' ? '0' : padded)
}

/** 10000n (or "10000") -> "0.01" */
export function toDecimalUsdt(base: bigint | string): UsdtDecimal {
  const value = typeof base === 'bigint' ? base : BigInt(asBaseUnits(base))
  if (value < 0n) throw new Error(`negative amount: ${value}`)
  const divisor = 10n ** BigInt(TUSD_DECIMALS)
  const whole = value / divisor
  const fraction = (value % divisor).toString().padStart(TUSD_DECIMALS, '0').replace(/0+$/, '')
  return (fraction === '' ? `${whole}` : `${whole}.${fraction}`) as UsdtDecimal
}

/** Sum base-unit strings without ever touching a float. */
export function sumBaseUnits(values: readonly string[]): bigint {
  return values.reduce((total, value) => total + BigInt(asBaseUnits(value)), 0n)
}

export function baseUnitsToString(value: bigint): BaseUnits {
  if (value < 0n) throw new Error(`negative amount: ${value}`)
  return value.toString() as BaseUnits
}
