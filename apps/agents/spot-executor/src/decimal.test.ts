import { describe, expect, it } from 'vitest'
import { decimalAmount } from '@agent-desk/schemas'
import {
  compareDecimal,
  DecimalError,
  divideDecimal,
  isDecimalString,
  isZero,
  normalizeDecimal,
} from './decimal.ts'

describe('divideDecimal', () => {
  it('computes the fill price as cumulative quote over executed quantity', () => {
    // A real BNBUSDT market buy: 6 USDT at about 761.
    expect(divideDecimal('5.99999520', '0.00788000')).toBe('761.42071066')
  })

  it('never produces the float noise a double divide would', () => {
    // The double answers 28.999999999999996 for the same two numbers.
    expect(divideDecimal('0.29000000', '0.01000000')).toBe('29')
    expect(Number('0.29') / Number('0.01')).not.toBe(29)
  })

  it('never produces an exponent, which the output schema would refuse', () => {
    // The double answers 1e-11, and `decimalAmount` has no exponent form.
    const tiny = divideDecimal('0.00000001', '1000')
    expect(tiny).not.toContain('e')
    expect(decimalAmount.safeParse(String(Number('0.00000001') / 1000)).success).toBe(false)
    expect(decimalAmount.safeParse(tiny).success).toBe(true)
  })

  it('rounds half up at eight places', () => {
    expect(divideDecimal('1', '3')).toBe('0.33333333')
    expect(divideDecimal('2', '3')).toBe('0.66666667')
  })

  it('answers a whole number without a trailing dot', () => {
    expect(divideDecimal('100', '4')).toBe('25')
  })

  it('always answers a string the execution output schema accepts', () => {
    for (const [quote, qty] of [
      ['5.99999520', '0.00788000'],
      ['0.00000001', '1000'],
      ['1', '3'],
      ['100', '4'],
    ] as const) {
      expect(decimalAmount.safeParse(divideDecimal(quote, qty)).success).toBe(true)
    }
  })

  it('refuses to divide by zero rather than answer Infinity', () => {
    expect(() => divideDecimal('5', '0')).toThrow(DecimalError)
  })

  it('refuses a value that is not a non-negative decimal string', () => {
    expect(() => divideDecimal('-5', '1')).toThrow(DecimalError)
    expect(() => divideDecimal('1e3', '1')).toThrow(DecimalError)
  })
})

describe('compareDecimal', () => {
  it('compares by value, not by string length', () => {
    expect(compareDecimal('9', '10')).toBe(-1)
    expect(compareDecimal('1000.00', '1000')).toBe(0)
    expect(compareDecimal('1000.01', '1000')).toBe(1)
  })

  it('holds at the order ceiling boundary', () => {
    expect(compareDecimal('1000', '1000') > 0).toBe(false)
    expect(compareDecimal('1000.000001', '1000') > 0).toBe(true)
  })
})

describe('normalizeDecimal and isZero', () => {
  it('drops the exchange padding', () => {
    expect(normalizeDecimal('0.01000000')).toBe('0.01')
    expect(normalizeDecimal('612.40000000')).toBe('612.4')
    expect(normalizeDecimal('0.00000000')).toBe('0')
    expect(normalizeDecimal('5')).toBe('5')
  })

  it('recognises every spelling of zero', () => {
    expect(isZero('0')).toBe(true)
    expect(isZero('0.00000000')).toBe(true)
    expect(isZero('0.00000001')).toBe(false)
  })
})

describe('isDecimalString', () => {
  it('matches the decimalAmount shape of the Type schemas', () => {
    for (const value of ['0', '0.01', '1000', '612.4']) {
      expect(isDecimalString(value)).toBe(decimalAmount.safeParse(value).success)
    }
    for (const value of ['-1', '.5', '1.', '1e3', '']) {
      expect(isDecimalString(value)).toBe(decimalAmount.safeParse(value).success)
    }
  })
})
