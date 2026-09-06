import { isDecimalUsdt } from '@agent-desk/schemas'
import { AgentEnvError } from './errors.ts'

/**
 * Conventions: every process validates its env at boot and exits on failure,
 * naming the keys that failed.
 *
 * `packages/schemas` exports `defineEnv()` over Zod for that job, but `zod` is
 * not a declared dependency of `packages/agent-kit` (see the package manifest),
 * and AD-1 forbids reaching for it through another workspace package. These
 * checks are the same contract by hand; swap them for `defineEnv()` the day
 * `zod` is added to this package.
 */

export interface AgentEnv {
  /** The port `createAgent().listen()` binds. */
  AGENT_PORT: number
  /** Decimal USDT string, e.g. "0.01" (AD-13). */
  AGENT_PRICE: string
  /** The address every 402 for this agent pays to. */
  AGENT_PAYTO: string
  /** Where the kit verifies and settles (AD-6). */
  FACILITATOR_URL: string
  /** Bearer token guarding `/internal/*`. */
  INTERNAL_TOKEN: string
  CHAIN_ID: number
  LOG_LEVEL: string
  MARKET_DATA_URL: string
}

export type EnvSource = Record<string, string | undefined>

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] }

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function readString(source: EnvSource, key: string, issues: string[]): string {
  const raw = source[key]?.trim()
  if (raw === undefined || raw === '') {
    issues.push(`${key}: required`)
    return ''
  }
  return raw
}

function readPort(source: EnvSource, key: string, issues: string[]): number {
  const raw = source[key]?.trim()
  if (raw === undefined || raw === '') {
    issues.push(`${key}: required`)
    return 0
  }
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issues.push(`${key}: must be a TCP port between 1 and 65535, got ${raw}`)
    return 0
  }
  return port
}

function readUrl(source: EnvSource, key: string, issues: string[]): string {
  const raw = readString(source, key, issues)
  if (raw === '') return raw
  if (!URL.canParse(raw)) {
    issues.push(`${key}: must be an absolute URL, got ${raw}`)
    return ''
  }
  return raw.replace(/\/+$/, '')
}

/** Validate without exiting the process; the unit tests and `loadAgentEnv` share it. */
export function parseAgentEnv(source: EnvSource = process.env): ParseResult<AgentEnv> {
  const issues: string[] = []

  const AGENT_PORT = readPort(source, 'AGENT_PORT', issues)
  const AGENT_PRICE = readString(source, 'AGENT_PRICE', issues)
  if (AGENT_PRICE !== '' && !isDecimalUsdt(AGENT_PRICE)) {
    issues.push(`AGENT_PRICE: must be a decimal USDT string, got ${AGENT_PRICE}`)
  }
  const AGENT_PAYTO = readString(source, 'AGENT_PAYTO', issues)
  if (AGENT_PAYTO !== '' && !ADDRESS_RE.test(AGENT_PAYTO)) {
    issues.push(`AGENT_PAYTO: must be a 20-byte hex address, got ${AGENT_PAYTO}`)
  }
  const FACILITATOR_URL = readUrl(source, 'FACILITATOR_URL', issues)
  const INTERNAL_TOKEN = readString(source, 'INTERNAL_TOKEN', issues)

  const chainRaw = source.CHAIN_ID?.trim()
  const CHAIN_ID = chainRaw === undefined || chainRaw === '' ? 97 : Number(chainRaw)
  if (!Number.isInteger(CHAIN_ID) || CHAIN_ID <= 0) {
    issues.push(`CHAIN_ID: must be a positive integer, got ${chainRaw}`)
  }

  const marketDataRaw = source.MARKET_DATA_URL?.trim()
  const MARKET_DATA_URL =
    marketDataRaw === undefined || marketDataRaw === ''
      ? 'https://data-api.binance.vision'
      : marketDataRaw.replace(/\/+$/, '')
  if (!URL.canParse(MARKET_DATA_URL)) {
    issues.push(`MARKET_DATA_URL: must be an absolute URL, got ${marketDataRaw}`)
  }

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    value: {
      AGENT_PORT,
      AGENT_PRICE,
      AGENT_PAYTO,
      FACILITATOR_URL,
      INTERNAL_TOKEN,
      CHAIN_ID,
      LOG_LEVEL: source.LOG_LEVEL?.trim() || 'info',
      MARKET_DATA_URL,
    },
  }
}

/** Boot-time loader: writes the failed keys to stderr and exits 1, like `defineEnv`. */
export function loadAgentEnv(source: EnvSource = process.env): AgentEnv {
  const parsed = parseAgentEnv(source)
  if (parsed.ok) return parsed.value
  process.stderr.write(new AgentEnvError(parsed.issues).message + '\n')
  process.exit(1)
}

/**
 * For the keys an individual agent adds on top of the shared ones
 * (`ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `EXCHANGE_*`), so those stay in
 * the agent that owns them (AD-1).
 */
export function requireEnv(source: EnvSource, ...keys: string[]): Record<string, string> {
  const issues: string[] = []
  const values: Record<string, string> = {}
  for (const key of keys) {
    const raw = source[key]?.trim()
    if (raw === undefined || raw === '') issues.push(`${key}: required`)
    else values[key] = raw
  }
  if (issues.length > 0) throw new AgentEnvError(issues)
  return values
}
