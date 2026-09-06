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
