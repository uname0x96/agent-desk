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
  /** Base units minted per demo wallet; `TUSD.MINT_CAP` is 1,000 tUSD. */
  DEMO_MINT_AMOUNT: bigint
}

const DECIMAL_BNB = /^\d+(\.\d+)?$/
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/

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

  const chainId = source.CHAIN_ID?.trim() ?? '97'
  if (!/^\d+$/.test(chainId)) problems.push('  CHAIN_ID: must be an integer')

  const rpcUrls = csv(source.RPC_URLS ?? '')
  if (rpcUrls.length === 0) problems.push('  RPC_URLS: needs at least one URL')

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
    DEMO_MINT_AMOUNT: BigInt(optional('DEMO_MINT_AMOUNT', '100000000', /^\d+$/, 'must be base units')),
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
