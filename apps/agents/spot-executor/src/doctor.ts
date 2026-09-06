import type { EnvSource } from '@agent-desk/agent-kit'
import {
  createBinanceExchange,
  DEMO_BASE_URL,
  TESTNET_BASE_URL,
} from './binance-exchange.ts'
import { credentialKeysFor, exchangeOptionsFor, parseExchangeEnv } from './env.ts'

/**
 * Story 2.5: `pnpm doctor` gains checks that ping both exchange hosts and
 * print the Platform Exchange Account's USDT balance. `scripts/src/doctor.ts`
 * belongs to Story 1.10, so the checks themselves live here — in the one place
 * allowed to know an exchange exists (AD-11) — and the doctor imports them.
 *
 * Every check answers rather than throws, so one unreachable host does not
 * hide the rest of the report. `pnpm doctor` exits non-zero when any `ok` is
 * false, which is the existing rule and needs no special case here.
 *
 * `ExchangeCheck` is deliberately the same shape as the doctor's own `Check`
 * in `scripts/src/checks.ts`, so `checks.push(...await runExchangeChecks())`
 * needs no adapter.
 */

export interface ExchangeCheck {
  /** Printed verbatim by the doctor; the column is 34 wide, these fit. */
  name: string
  ok: boolean
  detail: string
}

/** Well under the doctor's patience, and long enough for a healthy host. */
export const DOCTOR_TIMEOUT_MS = 5_000

export interface ExchangeCheckOptions {
  timeoutMs?: number
  fetchImpl?: typeof globalThis.fetch
}

/** `GET /api/v3/ping` is public on both hosts: no key, empty body, 200. */
export async function pingExchangeHost(
  baseUrl: string,
  options: ExchangeCheckOptions = {},
): Promise<ExchangeCheck> {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DOCTOR_TIMEOUT_MS
  const host = URL.canParse(baseUrl) ? new URL(baseUrl).host : baseUrl
  const name = `exchange ${host}`

  try {
    const response = await doFetch(`${baseUrl.replace(/\/+$/, '')}/api/v3/ping`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return { name, ok: false, detail: `answered ${response.status}` }
    return { name, ok: true, detail: 'reachable' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { name, ok: false, detail: `unreachable: ${reason}` }
  }
}

/** AD-11: both hosts, because either one can be the configured endpoint. */
export function checkExchangeHosts(options: ExchangeCheckOptions = {}): Promise<ExchangeCheck[]> {
  return Promise.all([
    pingExchangeHost(TESTNET_BASE_URL, options),
    pingExchangeHost(DEMO_BASE_URL, options),
  ])
}

/**
 * The free USDT of the Platform Exchange Account, through the same `Exchange`
 * port and the same credentials the agent itself uses. A missing key pair is a
 * failure, not a skip: the executor cannot place an order without one.
 */
export async function checkExchangeBalance(
  source: EnvSource = process.env,
): Promise<ExchangeCheck> {
  const name = 'platform exchange account USDT'
  const env = parseExchangeEnv(source)
  if (!env.ok) {
    return { name, ok: false, detail: env.issues.join('; ') }
  }
  const keys = credentialKeysFor(env.value.EXCHANGE_MODE)

  try {
    const exchange = createBinanceExchange(exchangeOptionsFor(env.value))
    const balance = await exchange.getBalance()
    return {
      name,
      ok: true,
      detail: `${balance.balanceUsdt} USDT free on ${env.value.EXCHANGE_BASE_URL} (${env.value.EXCHANGE_MODE}, ${keys.apiKey})`,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { name, ok: false, detail: `${env.value.EXCHANGE_BASE_URL}: ${reason}` }
  }
}

/** Everything Story 2.5 adds to `pnpm doctor`, in print order. */
export async function runExchangeChecks(
  source: EnvSource = process.env,
  options: ExchangeCheckOptions = {},
): Promise<ExchangeCheck[]> {
  const hosts = await checkExchangeHosts(options)
  return [...hosts, await checkExchangeBalance(source)]
}
