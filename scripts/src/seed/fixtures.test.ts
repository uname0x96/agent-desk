import { describe, expect, it } from 'vitest'
import { isId, toBaseUnits, toDecimalUsdt } from '@agent-desk/schemas'
import {
  BCRYPT_COST,
  SEED_BINANCE_TICKER,
  SEED_BINANCE_TICKER_PRICE,
  SEED_BINANCE_TICKER_STAKE,
  SEED_BUILDER,
  SEED_CHAINS,
  SEED_DEMO_ACCOUNTS,
  SEED_DEMO_BUILDER,
  SEED_DEMO_CREATOR,
  SEED_DEMO_DAILY_FEE_BUDGET,
  SEED_DEMO_WORKFLOW_IDS,
  SEED_GOOD_CHAIN,
  SEED_OPERATOR,
  SEED_SLOPPY_CHAIN,
  SEED_SPARE_BUILDER,
  SEED_SPARE_CREATOR,
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

describe('the demo account roster', () => {
  const BCRYPT_HASH = new RegExp(`^\\$2[aby]\\$${BCRYPT_COST}\\$[./A-Za-z0-9]{53}$`)

  it('is two Builders, two Creators and one spare pair (NFR-2, addendum §5)', () => {
    expect(SEED_DEMO_ACCOUNTS).toHaveLength(6)
    const primary = SEED_DEMO_ACCOUNTS.filter((account) => !account.spare)
    const spare = SEED_DEMO_ACCOUNTS.filter((account) => account.spare)

    expect(primary.filter((account) => account.role === 'builder')).toHaveLength(2)
    expect(primary.filter((account) => account.role === 'creator')).toHaveLength(2)
    expect(spare.map((account) => account.role)).toEqual(['builder', 'creator'])
  })

  it('names the demo pair and the spare pair from the roster itself', () => {
    expect(SEED_DEMO_BUILDER.role).toBe('builder')
    expect(SEED_DEMO_BUILDER.spare).toBe(false)
    expect(SEED_DEMO_CREATOR.role).toBe('creator')
    expect(SEED_DEMO_CREATOR.spare).toBe(false)
    expect(SEED_SPARE_BUILDER).toMatchObject({ role: 'builder', spare: true })
    expect(SEED_SPARE_CREATOR).toMatchObject({ role: 'creator', spare: true })
  })

  it("keeps Story 1.10's Builder as the first Builder, so its Workflow keeps its owner", () => {
    expect(SEED_DEMO_BUILDER.accountId).toBe(SEED_BUILDER.accountId)
    expect(SEED_DEMO_BUILDER.email).toBe(SEED_BUILDER.email)
  })

  it('gives every account a distinct valid id and email, and a usable bcrypt hash', () => {
    const ids = SEED_DEMO_ACCOUNTS.map((account) => account.accountId)
    const emails = SEED_DEMO_ACCOUNTS.map((account) => account.email)
    expect(new Set(ids).size).toBe(6)
    expect(new Set(emails).size).toBe(6)
    for (const account of SEED_DEMO_ACCOUNTS) {
      expect(account.accountId).toMatch(ACCOUNT_ID)
      expect(isId('account', account.accountId)).toBe(true)
      expect(account.passwordHash).toMatch(BCRYPT_HASH)
    }
    // Distinct salts: no two rows carry the same digest.
    expect(new Set(SEED_DEMO_ACCOUNTS.map((a) => a.passwordHash)).size).toBe(6)
  })

  it('never puts the Operator login in the demo roster', () => {
    expect(SEED_DEMO_ACCOUNTS.map((account) => account.email)).not.toContain(SEED_OPERATOR.email)
  })

  it('budgets 100 tUSD per demo Account in base units (addendum §6, AD-13)', () => {
    expect(SEED_DEMO_DAILY_FEE_BUDGET).toBe(toBaseUnits('100').toString())
    expect(toDecimalUsdt(SEED_DEMO_DAILY_FEE_BUDGET)).toBe('100')
  })
})

describe('the two demo chains', () => {
  it('differ in exactly one thing: the research Provider', () => {
    expect(SEED_GOOD_CHAIN.research).toBe('alpha-research')
    expect(SEED_SLOPPY_CHAIN.research).toBe('sloppy-research')
    expect(SEED_GOOD_CHAIN.symbol).toBe(SEED_SLOPPY_CHAIN.symbol)
    expect(SEED_GOOD_CHAIN.orderCapUsdt).toBe(SEED_SLOPPY_CHAIN.orderCapUsdt)
  })

  it('carries the Order Cap of 10 USDT FR-4 requires of an execution chain', () => {
    for (const chain of SEED_CHAINS) expect(chain.orderCapUsdt).toBe('10')
  })

  it('has a distinct, valid workflow id per chain', () => {
    expect(SEED_GOOD_CHAIN.workflowId).not.toBe(SEED_SLOPPY_CHAIN.workflowId)
    for (const chain of SEED_CHAINS) expect(isId('workflow', chain.workflowId)).toBe(true)
  })

  it("lists both chains plus Story 1.10's Workflow as the ones a spare swap moves", () => {
    expect(SEED_DEMO_WORKFLOW_IDS).toEqual([
      SEED_WORKFLOW.workflowId,
      SEED_GOOD_CHAIN.workflowId,
      SEED_SLOPPY_CHAIN.workflowId,
    ])
  })
})
