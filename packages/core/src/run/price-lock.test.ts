import { describe, expect, it } from 'vitest'
import { X402_MAX_TIMEOUT_SECONDS, X402_SCHEME } from '@agent-desk/schemas'
import {
  caseInsensitiveAddressEquals,
  comparePriceLock,
  describeMismatch,
  lockTermsFor,
  type AcceptsEntry,
  type LockTerms,
} from './price-lock.ts'
import { buildNodeInput } from './inputs.ts'

const ASSET = '0xd0e0851ca8a176d211e2a410f5bcf1fa440fada7'
const PAY_TO = '0x1e4a2f7d3c9b60518a7d3f2c4b8e91d0a6c73f52'
const OTHER = '0x8b21c6d4e70f9a3b52c1d8e46f70a9b3c25d18e4'

const LOCK: LockTerms = {
  scheme: X402_SCHEME,
  network: 'eip155:97',
  asset: ASSET,
  amount: '10000',
  payTo: PAY_TO,
  maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
}

function accepts(overrides: Partial<AcceptsEntry> = {}): AcceptsEntry {
  return {
    scheme: X402_SCHEME,
    network: 'eip155:97',
    asset: ASSET,
    amount: '10000',
    payTo: PAY_TO,
    maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
    extra: { name: 'tUSD', version: '1' },
    ...overrides,
  }
}

describe('lockTermsFor', () => {
  it('reads the terms straight off the Price Lock node', () => {
    expect(
      lockTermsFor({ price: '25000', asset: ASSET, network: 'eip155:97', pay_to: PAY_TO }),
    ).toEqual({
      scheme: 'exact',
      network: 'eip155:97',
      asset: ASSET,
      amount: '25000',
      payTo: PAY_TO,
      maxTimeoutSeconds: 15,
    })
  })
})

describe('comparePriceLock', () => {
  it('matches an identical 402 and hands back the entry to echo and its domain', () => {
    const entry = accepts()
    const result = comparePriceLock(LOCK, [entry])
    expect(result).toEqual({ ok: true, entry, extra: { name: 'tUSD', version: '1' } })
  })

  it('matches the asset case-insensitively, as isAddressEqual does', () => {
    const result = comparePriceLock(LOCK, [
      accepts({ asset: ASSET.toUpperCase().replace('0X', '0x'), payTo: PAY_TO.toUpperCase().replace('0X', '0x') }),
    ])
    expect(result.ok).toBe(true)
  })

  it('selects the first entry matching scheme, network and asset, skipping the others', () => {
    const wanted = accepts({ amount: '10000' })
    const result = comparePriceLock(LOCK, [
      accepts({ network: 'eip155:56', amount: '1' }),
      accepts({ scheme: 'permit2-exact', amount: '2' }),
      accepts({ asset: OTHER, amount: '3' }),
      wanted,
      accepts({ amount: '99999' }),
    ])
    expect(result).toMatchObject({ ok: true, entry: { amount: '10000' } })
  })

  it('refuses when no entry carries the locked scheme, network and asset', () => {
    const result = comparePriceLock(LOCK, [accepts({ network: 'eip155:56' })])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.mismatch.field).toBe('accepts')
    expect(describeMismatch(result.mismatch)).toContain('eip155:97')
    expect(describeMismatch(result.mismatch)).toContain('eip155:56')
  })

  it('compares the network as an exact string, so eip155:097 is not eip155:97', () => {
    const result = comparePriceLock(LOCK, [accepts({ network: 'eip155:097' })])
    expect(result).toMatchObject({ ok: false, mismatch: { field: 'accepts' } })
  })

  it('refuses an empty accepts array and says so', () => {
    const result = comparePriceLock(LOCK, [])
    expect(result).toMatchObject({ ok: false, mismatch: { field: 'accepts', actual: 'no accepts entry' } })
  })

  it('refuses a different payTo with both addresses in the reason', () => {
    const result = comparePriceLock(LOCK, [accepts({ payTo: OTHER })])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.mismatch).toEqual({ field: 'pay_to', expected: PAY_TO, actual: OTHER })
    expect(describeMismatch(result.mismatch)).toBe(
      `price lock mismatch on pay_to: expected ${PAY_TO}, got ${OTHER}`,
    )
  })

  it('refuses a different amount with both values in the reason', () => {
    const result = comparePriceLock(LOCK, [accepts({ amount: '10001' })])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.mismatch).toEqual({ field: 'amount', expected: '10000', actual: '10001' })
    expect(describeMismatch(result.mismatch)).toContain('expected 10000, got 10001')
  })

  it('compares the amount as a bigint, so leading zeroes are not a mismatch of value', () => {
    // "010000" is not a base-unit string (AD-13), so it is refused as a difference
    // rather than silently parsed; a value beyond Number.MAX_SAFE_INTEGER is exact.
    expect(comparePriceLock(LOCK, [accepts({ amount: '010000' })]).ok).toBe(false)
    const big = '9007199254740993'
    expect(comparePriceLock({ ...LOCK, amount: big }, [accepts({ amount: big })]).ok).toBe(true)
    expect(
      comparePriceLock({ ...LOCK, amount: big }, [accepts({ amount: '9007199254740992' })]).ok,
    ).toBe(false)
  })

  it('refuses a maxTimeoutSeconds above 15 and accepts one below', () => {
    const above = comparePriceLock(LOCK, [accepts({ maxTimeoutSeconds: 16 })])
    expect(above).toMatchObject({
      ok: false,
      mismatch: { field: 'max_timeout_seconds', expected: 'at most 15', actual: '16' },
    })
    expect(comparePriceLock(LOCK, [accepts({ maxTimeoutSeconds: 15 })]).ok).toBe(true)
    expect(comparePriceLock(LOCK, [accepts({ maxTimeoutSeconds: 5 })]).ok).toBe(true)
  })

  it('refuses a 402 with no EIP-712 domain, which could not be signed for eip155:97', () => {
    expect(comparePriceLock(LOCK, [accepts({ extra: undefined })])).toMatchObject({
      ok: false,
      mismatch: { field: 'extra', actual: 'absent' },
    })
    expect(comparePriceLock(LOCK, [accepts({ extra: { name: 'tUSD' } })])).toMatchObject({
      ok: false,
      mismatch: { field: 'extra' },
    })
  })

  it('uses the injected address comparison, which the worker fills with isAddressEqual', () => {
    const never = () => false
    expect(comparePriceLock(LOCK, [accepts()], never)).toMatchObject({
      ok: false,
      mismatch: { field: 'accepts' },
    })
  })

  it('never throws on a malformed address or amount', () => {
    expect(caseInsensitiveAddressEquals('nonsense', PAY_TO)).toBe(false)
    expect(comparePriceLock(LOCK, [accepts({ payTo: 'nonsense' })]).ok).toBe(false)
    expect(comparePriceLock(LOCK, [accepts({ amount: 'ten thousand' })]).ok).toBe(false)
    expect(comparePriceLock(LOCK, [accepts({ maxTimeoutSeconds: Number.NaN })]).ok).toBe(false)
  })
})

describe('buildNodeInput', () => {
  it('builds a data Node input from the Workflow symbol', () => {
    expect(buildNodeInput({ nodeType: 'data', symbol: 'BNBUSDT', outputs: {} })).toEqual({
      ok: true,
      input: { symbol: 'BNBUSDT' },
    })
  })

  it('refuses the four Types the engine cannot feed yet, before any payment', () => {
    for (const nodeType of ['research', 'risk', 'execution', 'notify'] as const) {
      const result = buildNodeInput({ nodeType, symbol: 'BNBUSDT', outputs: {} })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).toContain(nodeType)
    }
  })
})
