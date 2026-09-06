import { describe, expect, it } from 'vitest'
import type { CreateListingRequest } from '@agent-desk/schemas'
import {
  defaultStake,
  validateEndpoint,
  validateListing,
  validatePayoutWallet,
  validatePrice,
  validateStake,
} from './listing-rules.ts'

/**
 * FR-10 / FR-14: every rule the listing form enforces, as a sentence a stranger
 * can act on. These are the words on screen thirty seconds into using the
 * product, so they are asserted verbatim rather than by shape.
 */

const VALID: CreateListingRequest = {
  name: 'Sloppy Research',
  type: 'research',
  endpoint: 'https://agents.example/sloppy',
  price: '0.03',
  stake: '0.3',
}

describe('the endpoint rule', () => {
  it('accepts https anywhere', () => {
    expect(validateEndpoint('https://agents.example/sloppy')).toEqual({
      ok: true,
      endpoint: 'https://agents.example/sloppy',
    })
  })

  it.each([
    ['http://localhost:4103', 'http://localhost:4103'],
    ['http://127.0.0.1:4103', 'http://127.0.0.1:4103'],
    ['http://host.docker.internal:4103', 'http://host.docker.internal:4103'],
    // A compose service name: exactly what resolves from the worker container.
    ['http://agent-sloppy-research:4103', 'http://agent-sloppy-research:4103'],
  ])('accepts %s, which is where the demo actually runs', (input, expected) => {
    expect(validateEndpoint(input)).toEqual({ ok: true, endpoint: expected })
  })

  it('refuses http on a public host, naming the whole allow-list', () => {
    const result = validateEndpoint('http://agents.example/sloppy')

    expect(result).toEqual({
      ok: false,
      message:
        'http:// is accepted only for localhost, 127.0.0.1, host.docker.internal and compose ' +
        'service names; every other endpoint must be https://',
    })
  })

  it('refuses a scheme that is not HTTP at all', () => {
    expect(validateEndpoint('ftp://agents.example/sloppy')).toEqual({
      ok: false,
      message: 'ftp:// is not an HTTP endpoint; use https://',
    })
  })

  it('refuses something that is not a URL', () => {
    expect(validateEndpoint('agents.example')).toEqual({
      ok: false,
      message: 'agents.example is not a URL',
    })
  })

  it('drops a trailing slash and a fragment, so one endpoint has one spelling', () => {
    expect(validateEndpoint('https://agents.example/sloppy/#top')).toEqual({
      ok: true,
      endpoint: 'https://agents.example/sloppy',
    })
  })
})

describe('the price rule', () => {
  it('converts decimal tUSD to base units (AD-13)', () => {
    expect(validatePrice('0.03')).toEqual({ ok: true, baseUnits: 30_000n })
  })

  it('accepts the ceiling of 1 tUSD', () => {
    expect(validatePrice('1')).toEqual({ ok: true, baseUnits: 1_000_000n })
  })

  it('refuses a free Call: x402 has nothing to settle', () => {
    expect(validatePrice('0')).toEqual({
      ok: false,
      message: 'the price must be more than 0 tUSD',
    })
  })

  it('refuses more than 1 tUSD a call', () => {
    expect(validatePrice('1.000001')).toEqual({
      ok: false,
      message: 'the price may not be more than 1 tUSD a call',
    })
  })

  it('refuses more precision than tUSD has', () => {
    expect(validatePrice('0.0000001')).toMatchObject({ ok: false })
  })

  it('refuses a negative amount without ever parsing a float', () => {
    expect(validatePrice('-0.01')).toEqual({
      ok: false,
      message: '-0.01 is not an amount in tUSD (at most 6 decimal places)',
    })
  })
})

describe('the Stake rule', () => {
  it('defaults to ten times the price', () => {
    expect(defaultStake(30_000n)).toBe(300_000n)
  })

  it('accepts exactly ten times the price', () => {
    expect(validateStake('0.3', 30_000n)).toEqual({ ok: true, baseUnits: 300_000n })
  })

  it('accepts more', () => {
    expect(validateStake('1', 30_000n)).toEqual({ ok: true, baseUnits: 1_000_000n })
  })

  it('refuses less, with both numbers, because the Registry reverts on it', () => {
    expect(validateStake('0.29', 30_000n)).toEqual({
      ok: false,
      message:
        'the Stake must be at least ten times the price, so at least 0.3 tUSD for a price of 0.03 tUSD',
    })
  })

  it('says nothing about the multiple when the price itself is unusable', () => {
    expect(validateStake('0.3', null)).toEqual({ ok: true, baseUnits: 300_000n })
  })
})

describe('the payout wallet rule', () => {
  it('is optional, and absent means the Creator System Wallet', () => {
    expect(validatePayoutWallet(undefined)).toEqual({ ok: true, address: null })
    expect(validatePayoutWallet('  ')).toEqual({ ok: true, address: null })
  })

  it('stores an address lower-case (AD-13)', () => {
    expect(validatePayoutWallet('0xF6E3A69bEb0F05cEd82C99C4DC4989BeF8fa82C4')).toEqual({
      ok: true,
      address: '0xf6e3a69beb0f05ced82c99c4dc4989bef8fa82c4',
    })
  })

  it('refuses anything that is not an address', () => {
    expect(validatePayoutWallet('0xdeadbeef')).toEqual({
      ok: false,
      message: '0xdeadbeef is not a wallet address',
    })
  })
})

describe('the form as a whole', () => {
  it('normalises a valid submission into what the row will hold', () => {
    const result = validateListing({
      ...VALID,
      name: '  Sloppy Research  ',
      description: '  Fast, cheap, and wrong about a fifth of the time.  ',
      payout_wallet: '0xF6E3A69bEb0F05cEd82C99C4DC4989BeF8fa82C4',
    })

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Sloppy Research',
        type: 'research',
        description: 'Fast, cheap, and wrong about a fifth of the time.',
        endpoint: 'https://agents.example/sloppy',
        price: '30000',
        stake: '300000',
        payoutWallet: '0xf6e3a69beb0f05ced82c99c4dc4989bef8fa82c4',
      },
    })
  })

  it('turns an empty description into null rather than an empty string', () => {
    const result = validateListing({ ...VALID, description: '   ' })

    expect(result).toMatchObject({ ok: true, value: { description: null } })
  })

  it('reports every bad field at once, so the form is fixed in one pass', () => {
    const result = validateListing({
      ...VALID,
      name: '   ',
      endpoint: 'http://agents.example/sloppy',
      stake: '0.01',
      payout_wallet: 'not-an-address',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(Object.keys(result.errors).sort()).toEqual([
      'endpoint',
      'name',
      'payout_wallet',
      'stake',
    ])
    expect(result.errors.name).toBe('a name is required')
  })

  it('does not blame the Stake for a price it could not read', () => {
    const result = validateListing({ ...VALID, price: 'free', stake: '0.3' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.errors.price).toBeDefined()
    expect(result.errors.stake).toBeUndefined()
  })
})
