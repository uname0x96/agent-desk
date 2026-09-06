import { internalBalance } from '@agent-desk/schemas'
import type { ExchangeBalance } from './ports.ts'

/**
 * AD-11: `GET /internal/balance` on the execution Agent, which is the only
 * process in the system holding an exchange key. The engine reads it just
 * before the `risk` Node to fill `balance_usdt` (PRD addendum §1) and knows
 * nothing else about an exchange.
 *
 * Three seconds, once, no retry: the read sits inside the Run's 120 s budget
 * and ahead of a paid Call, so a slow executor must not eat the budget. A
 * failure throws, and the engine turns any throw here into the pre-payment
 * refusal `exchange balance unavailable`.
 *
 * The route is guarded by `Authorization: Bearer INTERNAL_TOKEN` (AD-7), and
 * the response is parsed with the shared `InternalBalance` schema (AD-14), so a
 * 200 carrying something else is a failure rather than a balance.
 */

/** The story's own number: the read is a pre-flight, not a Node. */
export const EXCHANGE_BALANCE_TIMEOUT_MS = 3_000

export interface ExchangeBalanceConfig {
  /** The execution Agent's base URL, e.g. `http://agent-spot-executor:4105`. */
  baseUrl: string
  internalToken: string
  timeoutMs?: number
  /** Injectable so the engine tests never open a socket. */
  fetch?: typeof globalThis.fetch
}

export function createExchangeBalance(config: ExchangeBalanceConfig): ExchangeBalance {
  const doFetch = config.fetch ?? globalThis.fetch
  const timeoutMs = config.timeoutMs ?? EXCHANGE_BALANCE_TIMEOUT_MS
  const url = `${config.baseUrl.replace(/\/+$/, '')}/internal/balance`

  return {
    async balanceUsdt(): Promise<string> {
      const response = await doFetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${config.internalToken}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`)
      }
      const parsed = internalBalance.safeParse(await response.json())
      if (!parsed.success) {
        throw new Error(`${url} answered something that is not an InternalBalance`)
      }
      return parsed.data.balance_usdt
    },
  }
}

/**
 * The port when `SPOT_EXECUTOR_URL` is not configured. It fails on use rather
 * than at boot, because a worker with no execution Agent still runs every
 * Workflow that has no `risk` Node, and a Run that does have one should say
 * plainly why it stopped instead of taking the whole worker down.
 */
export function unconfiguredExchangeBalance(reason: string): ExchangeBalance {
  return {
    balanceUsdt(): Promise<string> {
      return Promise.reject(new Error(reason))
    },
  }
}
