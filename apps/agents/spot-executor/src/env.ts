import { parseAgentEnv, type AgentEnv, type EnvSource, type ParseResult } from '@agent-desk/agent-kit'
import {
  DEMO_BASE_URL,
  TESTNET_BASE_URL,
  type BinanceExchangeOptions,
} from './binance-exchange.ts'

/**
 * AD-11: the exchange credentials exist in this file and nowhere else in the
 * repository. Nothing outside `apps/agents/spot-executor` reads `EXCHANGE_*`,
 * and no other process needs to know an exchange is involved at all.
 *
 * AD-10 keeps the switch that matters — Emergency Stop and the order ceiling —
 * in the database rather than here, so only the endpoint and the keys are env.
 *
 * Conventions: every process validates its env at boot and exits naming the
 * keys that failed. Story 2.5 wants that failure at boot rather than at the
 * first paid request, so a missing key never becomes a 500 a buyer paid for.
 */

export type ExchangeMode = 'testnet' | 'demo'

/** What it takes to reach the exchange, and nothing else. */
export interface ExchangeEnv {
  /** `https://testnet.binance.vision`, or `https://demo-api.binance.com` for Spot Demo Mode. */
  EXCHANGE_BASE_URL: string
  /** Which key pair the base URL selected. Derived, never read from env. */
  EXCHANGE_MODE: ExchangeMode
  /** `EXCHANGE_API_KEY`, or `EXCHANGE_DEMO_API_KEY` in demo mode. */
  EXCHANGE_API_KEY: string
  /** Ed25519 PEM (or a path to one); `EXCHANGE_DEMO_PRIVATE_KEY` in demo mode. */
  EXCHANGE_PRIVATE_KEY: string
}

export interface ExecutorEnv extends ExchangeEnv {
  /** Where `GET /api/internal/settings` lives (AD-10). */
  PLATFORM_INTERNAL_URL: string
}

/**
 * Spot Demo Mode is the same client against a different host with its own key
 * pair (AD-11). The host alone decides, so switching is one env line and no
 * code change.
 */
export function exchangeModeFor(baseUrl: string): ExchangeMode {
  if (!URL.canParse(baseUrl)) return 'testnet'
  return new URL(baseUrl).origin === new URL(DEMO_BASE_URL).origin ? 'demo' : 'testnet'
}

/** The two env keys each mode reads, so an error message can name them. */
export function credentialKeysFor(mode: ExchangeMode): { apiKey: string; privateKey: string } {
  return mode === 'demo'
    ? { apiKey: 'EXCHANGE_DEMO_API_KEY', privateKey: 'EXCHANGE_DEMO_PRIVATE_KEY' }
    : { apiKey: 'EXCHANGE_API_KEY', privateKey: 'EXCHANGE_PRIVATE_KEY' }
}

/**
 * A PEM cannot hold a literal newline in a dotenv file, so `\n` escapes are
 * accepted and unescaped here. A path to a key file passes through untouched;
 * `@binance/spot` reads it itself.
 */
export function normalizePrivateKey(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value
}

function readUrl(source: EnvSource, key: string, fallback: string | null, issues: string[]): string {
  const raw = source[key]?.trim()
  if (raw === undefined || raw === '') {
    if (fallback !== null) return fallback
    issues.push(`${key}: required`)
    return ''
  }
  if (!URL.canParse(raw)) {
    issues.push(`${key}: must be an absolute URL, got ${raw}`)
    return ''
  }
  return raw.replace(/\/+$/, '')
}

/**
 * The exchange half on its own, for the two callers that reach the exchange
 * without serving a request: the doctor check and `scripts/place-order.ts`.
 * Neither needs `PLATFORM_INTERNAL_URL`, and naming it in their failure would
 * send the reader after the wrong key.
 */
export function parseExchangeEnv(source: EnvSource = process.env): ParseResult<ExchangeEnv> {
  const issues: string[] = []

  const EXCHANGE_BASE_URL = readUrl(source, 'EXCHANGE_BASE_URL', TESTNET_BASE_URL, issues)
  const EXCHANGE_MODE = exchangeModeFor(EXCHANGE_BASE_URL)
  const keys = credentialKeysFor(EXCHANGE_MODE)

  const apiKey = source[keys.apiKey]?.trim() ?? ''
  if (apiKey === '') {
    issues.push(`${keys.apiKey}: required for ${EXCHANGE_MODE} mode (EXCHANGE_BASE_URL=${EXCHANGE_BASE_URL})`)
  }
  const privateKey = source[keys.privateKey]?.trim() ?? ''
  if (privateKey === '') {
    issues.push(
      `${keys.privateKey}: required for ${EXCHANGE_MODE} mode (an Ed25519 PEM or a path to one)`,
    )
  }

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    value: {
      EXCHANGE_BASE_URL,
      EXCHANGE_MODE,
      EXCHANGE_API_KEY: apiKey,
      EXCHANGE_PRIVATE_KEY: normalizePrivateKey(privateKey),
    },
  }
}

export function parseExecutorEnv(source: EnvSource = process.env): ParseResult<ExecutorEnv> {
  const issues: string[] = []
  const PLATFORM_INTERNAL_URL = readUrl(source, 'PLATFORM_INTERNAL_URL', null, issues)
  const exchange = parseExchangeEnv(source)

  if (!exchange.ok || issues.length > 0) {
    return { ok: false, issues: [...(exchange.ok ? [] : exchange.issues), ...issues] }
  }
  return { ok: true, value: { ...exchange.value, PLATFORM_INTERNAL_URL } }
}

/** The shared agent keys and this agent's own, validated together. */
export function parseFullEnv(source: EnvSource = process.env): ParseResult<AgentEnv & ExecutorEnv> {
  const agent = parseAgentEnv(source)
  const executor = parseExecutorEnv(source)
  if (!agent.ok || !executor.ok) {
    return {
      ok: false,
      issues: [...(agent.ok ? [] : agent.issues), ...(executor.ok ? [] : executor.issues)],
    }
  }
  return { ok: true, value: { ...agent.value, ...executor.value } }
}

/** Boot-time loader: writes every failed key to stderr and exits 1. */
export function loadExecutorEnv(source: EnvSource = process.env): AgentEnv & ExecutorEnv {
  const parsed = parseFullEnv(source)
  if (parsed.ok) return parsed.value
  process.stderr.write(
    `agent-spot-executor cannot start; the environment is incomplete:\n${parsed.issues
      .map((issue) => `  ${issue}`)
      .join('\n')}\n`,
  )
  process.exit(1)
}

/**
 * The exchange client the validated env asks for. This is the whole of the
 * Spot Demo Mode switch: `EXCHANGE_BASE_URL` picks the host, the host picks the
 * key pair, and `createBinanceExchange` uses whatever comes out. No branch in
 * the client, no second code path.
 */
export function exchangeOptionsFor(env: ExchangeEnv): BinanceExchangeOptions {
  return {
    apiKey: env.EXCHANGE_API_KEY,
    privateKey: env.EXCHANGE_PRIVATE_KEY,
    baseUrl: env.EXCHANGE_BASE_URL,
  }
}
