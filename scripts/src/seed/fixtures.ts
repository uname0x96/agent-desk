import { ID_PREFIXES, toBaseUnits, type AgentType, type IdKind } from '@agent-desk/schemas'
import { PLATFORM_ACCOUNT_EMAIL } from '../platform-wallet.ts'

/**
 * Everything `pnpm seed` hard-codes.
 *
 * The ids are fixed rather than minted, and that is what makes the seed
 * idempotent in the way Story 1.10 asks for: a second run finds the same rows
 * by primary key instead of guessing at a natural key, and the Workflow id an
 * Operator copied out of the first run still resolves after a `--reset`.
 *
 * A fixed id must still be a valid AD-13 id, because other code parses them:
 * `POST /api/runs` asserts `^acc_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$` before it
 * locks the account row. So the bodies below are 26 characters of Crockford
 * base-32 — the ULID alphabet, which has no I, L, O or U.
 */

const CROCKFORD_ULID = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

/** `seedId('listing', 'SEEDTCKR01')` -> `lst_0000000000000000SEEDTCKR01`. */
export function seedId(kind: IdKind, label: string): string {
  const body = label.padStart(26, '0')
  if (!CROCKFORD_ULID.test(body)) {
    throw new Error(`seed id label ${label} is not 26 characters of Crockford base-32 once padded`)
  }
  return `${ID_PREFIXES[kind]}_${body}`
}

// ----------------------------------------------------------- the two logins

/**
 * Story 2.1 signs in as both seeded accounts, so both carry a real bcrypt
 * `accounts.password_hash` and the Platform Account carries `is_operator`.
 *
 * The hashes are constants rather than something the seed computes, for two
 * reasons. The credentials are fixed, so the hash can be too, and a constant
 * makes the seed deterministic — the same row every run, which is what lets a
 * sign-in test assert against it. And `bcryptjs` is declared in `apps/web`,
 * which AD-1 forbids `scripts` from importing; adding it to
 * `scripts/package.json` would buy nothing but a dependency.
 *
 * Cost 10, which is what `apps/web/lib/accounts.ts` states its own dummy hash
 * uses and compares against. To change a password, change the plaintext and
 * regenerate:
 *
 *   node -e "console.log(require('bcryptjs').hashSync('<plaintext>', 10))"
 *
 * Both are printed at the end of every seed run. They are local demo
 * credentials against a testnet chain, committed on purpose.
 */
export const BCRYPT_COST = 10

/**
 * One Builder, so the demo has an owner for the Workflow and a wallet that is
 * not the platform's.
 */
export const SEED_BUILDER = {
  accountId: seedId('account', 'SEEDACC01'),
  email: 'builder@agentdesk.local',
  password: 'agentdesk',
  passwordHash: '$2b$10$VYE3Td8IjwM5OouSRkol8eX97q8OI26ywVCrgu3LdvLDJDnTkJLNi',
} as const

/**
 * The Operator login is the Platform Account, which already exists for other
 * reasons — it owns the Platform Wallet and every platform Listing — so the
 * seed gives it a password rather than inventing a second operator.
 *
 * Its password differs from the Builder's on purpose: the Operator console
 * holds Emergency Stop and the mode switch, and a demo that shows the Builder's
 * credentials on screen should not also hand over that console.
 */
export const SEED_OPERATOR = {
  email: PLATFORM_ACCOUNT_EMAIL,
  password: 'agentdesk-operator',
  passwordHash: '$2b$10$uqZerT5xeSf1/ttJPm9YDe7i4T3bvKgNZU6Wu24xE9RvQgpAmD5b6',
} as const

// ---------------------------------------------------------- the Listing

/**
 * FR-44: Binance Ticker, the one Seed Listing Epic 1 needs. It is created under
 * the Platform Account — the platform operates it, and Stories 2.3 to 2.6 add
 * the other five agents to the same account with the same `skip_verification`
 * path.
 *
 * The Stake is exactly ten times the price, which is the Registry's
 * `STAKE_MULTIPLE` floor; anything less reverts `list(...)`.
 */
export const SEED_BINANCE_TICKER = {
  listingId: seedId('listing', 'SEEDTCKR01'),
  name: 'Binance Ticker',
  description:
    'BNBUSDT last price, 24 hour change and 24 hour volatility from Binance public market data.',
  type: 'data' as AgentType,
  priceUsdt: '0.01',
  stakeUsdt: '0.1',
} as const

export const SEED_BINANCE_TICKER_PRICE = toBaseUnits(SEED_BINANCE_TICKER.priceUsdt).toString()
export const SEED_BINANCE_TICKER_STAKE = toBaseUnits(SEED_BINANCE_TICKER.stakeUsdt).toString()

// --------------------------------------------------------- the Workflow

/**
 * The Builder's one-node Workflow: the whole of Epic 1's exit criterion is a
 * Run of this. `order_cap_usdt` stays null because there is no `execution`
 * Node; Story 2.7 is what builds the five-node chain.
 */
export const SEED_WORKFLOW = {
  workflowId: seedId('workflow', 'SEEDWF01'),
  name: 'Binance Ticker (seed)',
  symbol: 'BNBUSDT',
} as const

// --------------------------------------------------- the demo account roster

/**
 * NFR-2 and PRD addendum §5: "two Builder Accounts and two Creator Accounts
 * prepared in advance, each pre-funded with testnet BNB for gas and testnet
 * USDT; a spare set for failover".
 *
 * Six accounts, each created through the same `wallet.create` path `POST
 * /api/auth/sign-up` publishes, so a demo wallet is not a special kind of
 * wallet — it is an ordinary System Wallet that happens to exist before anyone
 * signed up. The Builder above is the first of them, kept under its own name
 * because Story 1.10's Workflow and every printed credential already point at
 * it.
 *
 * All six share the Builder's password so the demo has one thing to remember;
 * each carries its own bcrypt hash, generated with the one-liner `fixtures.ts`
 * records above. The Operator login is deliberately *not* in this roster: it is
 * the Platform Account, and it keeps its own password.
 */
export interface SeedDemoAccount {
  accountId: string
  email: string
  password: string
  passwordHash: string
  role: 'builder' | 'creator'
  /** The failover pair of addendum §5, swapped in by `--activate-spare`. */
  spare: boolean
  /** How the seed's output names it. */
  label: string
}

const DEMO_PASSWORD = 'agentdesk'

export const SEED_DEMO_ACCOUNTS: readonly SeedDemoAccount[] = [
  {
    accountId: SEED_BUILDER.accountId,
    email: SEED_BUILDER.email,
    password: SEED_BUILDER.password,
    passwordHash: SEED_BUILDER.passwordHash,
    role: 'builder',
    spare: false,
    label: 'Builder 1 (demo)',
  },
  {
    accountId: seedId('account', 'SEEDACC02'),
    email: 'builder2@agentdesk.local',
    password: DEMO_PASSWORD,
    passwordHash: '$2b$10$EiigNm9OvIFMrE8GmJphpevhV3ruTAhlVSfZkJNtN1EnZJSnfVEUe',
    role: 'builder',
    spare: false,
    label: 'Builder 2',
  },
  {
    accountId: seedId('account', 'SEEDCRE01'),
    email: 'creator@agentdesk.local',
    password: DEMO_PASSWORD,
    passwordHash: '$2b$10$mw72fkPSP5Zz0o1CAZZBSu94PJQwk9FViTiqmDFutBiF/eFdR6Adi',
    role: 'creator',
    spare: false,
    label: 'Creator 1 (demo)',
  },
  {
    accountId: seedId('account', 'SEEDCRE02'),
    email: 'creator2@agentdesk.local',
    password: DEMO_PASSWORD,
    passwordHash: '$2b$10$r8qCONns7NQCeH0nBKy1u.H2mSHX5DJLvd83/ZUKrPQ2yHfq61ira',
    role: 'creator',
    spare: false,
    label: 'Creator 2',
  },
  {
    accountId: seedId('account', 'SEEDSPB01'),
    email: 'builder-spare@agentdesk.local',
    password: DEMO_PASSWORD,
    passwordHash: '$2b$10$rcJZTMxuYQLPyGnu.MXwIeB9ueEUBseVgfXC7HJmUgJJMdkAg28NS',
    role: 'builder',
    spare: true,
    label: 'Builder (spare)',
  },
  {
    accountId: seedId('account', 'SEEDSPC01'),
    email: 'creator-spare@agentdesk.local',
    password: DEMO_PASSWORD,
    passwordHash: '$2b$10$wOPgzrFIMzsHHp8V2Xtxlufk8iYnhBIZ3DC3y7zOhcOElcQQKEoTa',
    role: 'creator',
    spare: true,
    label: 'Creator (spare)',
  },
]

/** The demo pair the Workflows and `.env.seed` point at until `--activate-spare`. */
export const SEED_DEMO_BUILDER = SEED_DEMO_ACCOUNTS[0]!
export const SEED_DEMO_CREATOR = SEED_DEMO_ACCOUNTS[2]!
/** The failover pair of addendum §5. */
export const SEED_SPARE_BUILDER = SEED_DEMO_ACCOUNTS[4]!
export const SEED_SPARE_CREATOR = SEED_DEMO_ACCOUNTS[5]!

/**
 * Addendum §6, "Daily Fee Budget default": 100 USDT on demo Accounts. Stored in
 * base units on `accounts.daily_fee_budget` (AD-13), which overrides the
 * platform default for exactly these six rows.
 */
export const SEED_DEMO_DAILY_FEE_BUDGET = toBaseUnits('100').toString()

// ------------------------------------------------------- the demo Workflows

/**
 * Story 2.10's two Workflows, both owned by the demo Builder and both over
 * BNBUSDT.
 *
 * They differ in exactly one Node — the `research` Provider — which is the whole
 * point: the same five-Node chain, one Provider swap, and the demo's Settlement
 * beat separates them. The Order Cap is 10 USDT on both, which FR-4 requires as
 * soon as a chain has an `execution` Node.
 */
export interface SeedChain {
  workflowId: string
  name: string
  symbol: string
  /** FR-4, decimal USDT. */
  orderCapUsdt: string
  /** The `research` Provider that distinguishes the two chains. */
  research: 'alpha-research' | 'sloppy-research'
}

export const SEED_GOOD_CHAIN: SeedChain = {
  workflowId: seedId('workflow', 'SEEDWFGD01'),
  name: 'BNBUSDT full chain (good)',
  symbol: 'BNBUSDT',
  orderCapUsdt: '10',
  research: 'alpha-research',
}

export const SEED_SLOPPY_CHAIN: SeedChain = {
  workflowId: seedId('workflow', 'SEEDWFSPY01'),
  name: 'BNBUSDT full chain (sloppy)',
  symbol: 'BNBUSDT',
  orderCapUsdt: '10',
  research: 'sloppy-research',
}

export const SEED_CHAINS: readonly SeedChain[] = [SEED_GOOD_CHAIN, SEED_SLOPPY_CHAIN]

/**
 * Every Workflow the demo pair owns, including Story 1.10's one-Node Binance
 * Ticker chain: `--activate-spare` moves all of them, because a failover that
 * left the smoke-test Workflow on the broken wallet would be a failover with a
 * trap in it.
 */
export const SEED_DEMO_WORKFLOW_IDS: readonly string[] = [
  SEED_WORKFLOW.workflowId,
  ...SEED_CHAINS.map((chain) => chain.workflowId),
]

/** Every table `pnpm seed --reset` truncates, children before parents. */
export const SEED_TABLES = [
  'settlements',
  'calls',
  'runs',
  'workflow_nodes',
  'workflows',
  'listings',
  'chain_tx',
  'wallets',
  'accounts',
] as const
