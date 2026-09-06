import { describe, expect, it } from 'vitest'
import { isId } from '@agent-desk/schemas'
import {
  BCRYPT_COST,
  SEED_BINANCE_TICKER,
  SEED_BINANCE_TICKER_PRICE,
  SEED_BINANCE_TICKER_STAKE,
  SEED_BUILDER,
  SEED_OPERATOR,
  SEED_TABLES,
  SEED_WORKFLOW,
  seedId,
} from './fixtures.ts'
import { PLATFORM_ACCOUNT_EMAIL } from '../platform-wallet.ts'
import { parseSeedArgs } from './args.ts'

/** The regex `apps/web/app/api/runs/create-run.ts` asserts before it locks a row. */
const ACCOUNT_ID = /^acc_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

describe('seedId', () => {
  it('pads a label into a valid type-prefixed ULID', () => {
    expect(seedId('listing', 'SEEDTCKR01')).toBe('lst_0000000000000000SEEDTCKR01')
    expect(isId('listing', seedId('listing', 'SEEDTCKR01'))).toBe(true)
  })

  it('refuses a label outside the Crockford base-32 alphabet', () => {
    // I, L, O and U are not ULID characters, and neither is lower case.
    for (const label of ['BUILDER', 'seed', 'HELLO']) {
      expect(() => seedId('account', label)).toThrow()
    }
  })
})

describe('the fixed ids', () => {
  it('are the ids their tables expect', () => {
    expect(SEED_BUILDER.accountId).toMatch(ACCOUNT_ID)
    expect(isId('account', SEED_BUILDER.accountId)).toBe(true)
    expect(isId('listing', SEED_BINANCE_TICKER.listingId)).toBe(true)
    expect(isId('workflow', SEED_WORKFLOW.workflowId)).toBe(true)
  })
})

describe('the seeded logins', () => {
  /**
   * `$2b$<cost>$` and 53 characters of salt and digest. This cannot check that a
   * hash matches its plaintext — `bcryptjs` belongs to `apps/web` and AD-1 keeps
   * it out of `scripts` — so it checks the shape and the cost, and `fixtures.ts`
   * records the one-liner that regenerates a hash.
   */
  const BCRYPT_HASH = new RegExp(`^\\$2[aby]\\$${BCRYPT_COST}\\$[./A-Za-z0-9]{53}$`)

  it('give both accounts a usable bcrypt hash at the cost apps/web compares at', () => {
    expect(SEED_BUILDER.passwordHash).toMatch(BCRYPT_HASH)
    expect(SEED_OPERATOR.passwordHash).toMatch(BCRYPT_HASH)
  })

  it('are two different logins, so the Builder cannot open the Operator console', () => {
    expect(SEED_OPERATOR.email).not.toBe(SEED_BUILDER.email)
    expect(SEED_OPERATOR.password).not.toBe(SEED_BUILDER.password)
    expect(SEED_OPERATOR.passwordHash).not.toBe(SEED_BUILDER.passwordHash)
  })

  it('sign the Operator in as the Platform Account', () => {
    expect(SEED_OPERATOR.email).toBe(PLATFORM_ACCOUNT_EMAIL)
  })
})

describe('the Seed Listing', () => {
  it('stakes exactly the Registry minimum of ten times the price', () => {
    expect(BigInt(SEED_BINANCE_TICKER_STAKE)).toBe(BigInt(SEED_BINANCE_TICKER_PRICE) * 10n)
  })

  it('prices in base units, not decimals (AD-13)', () => {
    expect(SEED_BINANCE_TICKER_PRICE).toBe('10000')
    expect(SEED_BINANCE_TICKER_STAKE).toBe('100000')
  })
})

describe('SEED_TABLES', () => {
  it('includes chain_tx, which is the one Story 1.10 names', () => {
    expect(SEED_TABLES).toContain('chain_tx')
  })
})

describe('parseSeedArgs', () => {
  it('reads the two flags and collects anything else', () => {
    expect(parseSeedArgs(['--reset', '--yes'])).toMatchObject({ reset: true, yes: true })
    expect(parseSeedArgs(['-y'])).toMatchObject({ yes: true })
    expect(parseSeedArgs(['--rest']).unknown).toEqual(['--rest'])
    expect(parseSeedArgs([])).toMatchObject({ reset: false, yes: false, help: false })
  })
})
