import { csv } from '@agent-desk/schemas/env'

/**
 * Conventions: every process validates its env at boot and exits naming the
 * keys that failed. This one is hand-written rather than Zod because `scripts`
 * does not depend on Zod and adding a dependency is not this story's to make;
 * the behaviour — collect every failure, print them all, exit 1 — is the same
 * as `defineEnv`.
 *
 * `MASTER_KEY` and `PLATFORM_WALLET_KEY` are here because `scripts/` signs:
 * `pnpm seed` creates wallets and imports the Platform Wallet, which is exactly
 * the work `.env.example` marks "Worker only". Neither key is read anywhere
 * else in this repository, and neither is reachable from `apps/web` — AD-1's
 * ESLint boundary stops `@agent-desk/adapters/signer` being imported there at
 * all, so there is nothing in the web app that could open a wallet key.
 *
 * `FACILITATOR_RELAYER_KEY` is deliberately *not* here. AD-5 puts that key in
 * `apps/facilitator` and nowhere else, so the relayer's BNB floor is checked
 * against `FACILITATOR_RELAYER_ADDRESS` — an address, not a secret — and the
 * facilitator's own `GET /health` supplies it when the variable is unset.
 */

export interface ScriptsEnv {
  DATABASE_URL: string
  CHAIN_ID: number
  RPC_URLS: string[]
  /** AES-256-GCM key for every System Wallet private key (AD-5). */
  MASTER_KEY: string
  /** Imported once, by `importPlatformWallet`, and read by nothing else. */
  PLATFORM_WALLET_KEY: string
  /** Decimal BNB. */
  WALLET_GAS_FLOOR: string
  PLATFORM_WALLET_BNB_FLOOR: string
  CREATOR_WALLET_BNB_FLOOR: string
  FACILITATOR_RELAYER_BNB_FLOOR: string
  /** Base units minted per demo wallet; `TUSD.MINT_CAP` is 1,000 tUSD. */
  DEMO_MINT_AMOUNT: bigint
  /** Where `pnpm doctor` reads `/health` and its pending nonce count. */
  FACILITATOR_URL: string
  /** The relayer's address only. Empty falls back to the facilitator's `/health`. */
  FACILITATOR_RELAYER_ADDRESS: string
  /**
   * A Creator key funded outside the platform (`.env`), held to
   * `CREATOR_WALLET_BNB_FLOOR` like every other Creator wallet. Empty is fine.
   */
  DEMO_CREATOR_ADDRESS: string
  /** AD-2: empty means every `agentURI` is a `data:` URI. */
  PUBLIC_BASE_URL: string
  /** AD-13: the base of every `explorerLink()` the seed prints. */
  EXPLORER_URL: string
  /** The endpoint the seed lists Binance Ticker at (compose: the service name). */
  SEED_BINANCE_TICKER_URL: string
}

const DECIMAL_BNB = /^\d+(\.\d+)?$/
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function parseScriptsEnv(source: NodeJS.ProcessEnv = process.env): ScriptsEnv {
  const problems: string[] = []

  const required = (key: string, pattern?: RegExp, hint?: string): string => {
    const value = source[key]?.trim()
    if (!value) {
      problems.push(`  ${key}: is required`)
      return ''
    }
    if (pattern && !pattern.test(value)) {
      problems.push(`  ${key}: ${hint ?? `does not match ${pattern.source}`}`)
      return ''
    }
    return value
  }

  const optional = (key: string, fallback: string, pattern: RegExp, hint: string): string => {
    const value = source[key]?.trim()
    if (!value) return fallback
    if (!pattern.test(value)) {
      problems.push(`  ${key}: ${hint}`)
      return fallback
    }
    return value
  }

  /** Absent is a valid answer; a malformed value never is. */
  const optionalPattern = (key: string, pattern: RegExp, hint: string): string => {
    const value = source[key]?.trim()
    if (!value) return ''
    if (!pattern.test(value)) {
      problems.push(`  ${key}: ${hint}`)
      return ''
    }
    return value
  }

  const url = (key: string, fallback: string): string => {
    const value = source[key]?.trim()
    if (!value) return fallback
    if (!URL.canParse(value)) {
      problems.push(`  ${key}: must be an absolute URL`)
      return fallback
    }
    return value.replace(/\/+$/, '')
  }

  const chainId = source.CHAIN_ID?.trim() ?? '97'
  if (!/^\d+$/.test(chainId)) problems.push('  CHAIN_ID: must be an integer')

  const rpcUrls = csv(source.RPC_URLS ?? '')
  if (rpcUrls.length === 0) problems.push('  RPC_URLS: needs at least one URL')

  const publicBaseUrl = source.PUBLIC_BASE_URL?.trim() ?? ''
  if (publicBaseUrl !== '' && !URL.canParse(publicBaseUrl)) {
    problems.push('  PUBLIC_BASE_URL: must be an absolute URL, or empty for data: URIs')
  }

  const env: ScriptsEnv = {
    DATABASE_URL: required('DATABASE_URL'),
    CHAIN_ID: Number(/^\d+$/.test(chainId) ? chainId : '97'),
    RPC_URLS: rpcUrls,
    MASTER_KEY: required('MASTER_KEY'),
    PLATFORM_WALLET_KEY: required(
      'PLATFORM_WALLET_KEY',
      PRIVATE_KEY,
      'must be 0x followed by 64 hex characters',
    ),
    WALLET_GAS_FLOOR: optional('WALLET_GAS_FLOOR', '0.005', DECIMAL_BNB, 'must be a decimal BNB amount'),
    PLATFORM_WALLET_BNB_FLOOR: optional(
      'PLATFORM_WALLET_BNB_FLOOR',
      '0.05',
      DECIMAL_BNB,
      'must be a decimal BNB amount',
    ),
    CREATOR_WALLET_BNB_FLOOR: optional(
      'CREATOR_WALLET_BNB_FLOOR',
      '0.02',
      DECIMAL_BNB,
      'must be a decimal BNB amount',
    ),
    FACILITATOR_RELAYER_BNB_FLOOR: optional(
      'FACILITATOR_RELAYER_BNB_FLOOR',
      '0.05',
      DECIMAL_BNB,
      'must be a decimal BNB amount',
    ),
    DEMO_MINT_AMOUNT: BigInt(optional('DEMO_MINT_AMOUNT', '100000000', /^\d+$/, 'must be base units')),
    FACILITATOR_URL: url('FACILITATOR_URL', 'http://localhost:4020'),
    FACILITATOR_RELAYER_ADDRESS: optionalPattern(
      'FACILITATOR_RELAYER_ADDRESS',
      ADDRESS,
      'must be a 20-byte hex address',
    ),
    DEMO_CREATOR_ADDRESS: optionalPattern(
      'DEMO_CREATOR_ADDRESS',
      ADDRESS,
      'must be a 20-byte hex address',
    ),
    PUBLIC_BASE_URL: URL.canParse(publicBaseUrl) ? publicBaseUrl.replace(/\/+$/, '') : '',
    EXPLORER_URL: url('EXPLORER_URL', 'https://testnet.bscscan.com'),
    SEED_BINANCE_TICKER_URL: url('SEED_BINANCE_TICKER_URL', 'http://localhost:4101'),
  }

  if (problems.length > 0) throw new EnvError(problems)
  return env
}

/** The boot-time form: print every failing key and stop. */
export function loadScriptsEnv(source: NodeJS.ProcessEnv = process.env): ScriptsEnv {
  try {
    return parseScriptsEnv(source)
  } catch (error) {
    if (!(error instanceof EnvError)) throw error
    process.stderr.write(`Invalid environment:\n${error.problems.join('\n')}\n`)
    process.exit(1)
  }
}

export class EnvError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`Invalid environment:\n${problems.join('\n')}`)
    this.name = 'EnvError'
    this.problems = problems
  }
}
