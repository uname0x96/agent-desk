import {
  X402_HEADERS,
  X402_PAID_TIMEOUT_MS,
  X402_UNPAID_TIMEOUT_MS,
} from '@agent-desk/schemas'
import type {
  AgentClient,
  PaidResult,
  PaymentRequiredPayload,
  SettlementReceipt,
  UnpaidResult,
} from './ports.ts'

/**
 * AD-6 / PRD addendum §3: the engine's half of the x402 wire.
 *
 * Two requests, both `POST {endpoint}` with the Type's input as the body: the
 * unpaid one that is answered 402, and the paid one that carries the stored
 * `PAYMENT-SIGNATURE` header. Both time out at 15 s, and a timeout is reported
 * as its own outcome rather than an error, because it is the only failure AD-6
 * lets the engine retry.
 *
 * `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` are base64 JSON, which is the x402
 * v2 header encoding itself and not an implementation detail of any package:
 * `@x402/core/http` is exactly `btoa(JSON.stringify(...))` over the standard
 * alphabet, and the facilitator and the agents both go through it. The worker
 * has no `@x402/core` dependency and adding one is out of this story's scope, so
 * the fifteen lines below decode it directly rather than pull the package in.
 *
 * A 402 that carries no readable `PAYMENT-REQUIRED` falls back to the response
 * body, which the reference middleware also fills; a 402 with neither is
 * `unexpected` and the Call fails before any payment.
 */

export interface AgentClientConfig {
  unpaidTimeoutMs?: number
  paidTimeoutMs?: number
  /** Injectable so the engine tests never open a socket. */
  fetch?: typeof globalThis.fetch
}

/** The standard base64 alphabet, as x402 v2 encodes its headers. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function decodeHeader(value: string): unknown {
  if (!BASE64.test(value)) throw new Error('not a base64 x402 header')
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown
}

/** A slice of a body, short enough for `calls.failure_reason`. */
const DETAIL_LIMIT = 300

function detailOf(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text
}

function isTimeout(cause: unknown): boolean {
  if (cause instanceof DOMException) return cause.name === 'TimeoutError' || cause.name === 'AbortError'
  const name = (cause as { name?: unknown })?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/** The x402 v2 `PaymentRequired`, narrowed to what the comparison reads. */
function toPaymentRequired(value: unknown): PaymentRequiredPayload | null {
  if (!value || typeof value !== 'object') return null
  const accepts = (value as { accepts?: unknown }).accepts
  if (!Array.isArray(accepts)) return null
  return value as PaymentRequiredPayload
}

function readPaymentRequired(response: Response, body: unknown): PaymentRequiredPayload | null {
  const header = response.headers.get(X402_HEADERS.required)
  if (header) {
    try {
      const decoded = toPaymentRequired(decodeHeader(header))
      if (decoded) return decoded
    } catch {
      // Fall through to the body: an unreadable header is not worth failing on
      // while the same payload is available unencoded.
    }
  }
  return toPaymentRequired(body)
}

function readSettlement(response: Response): SettlementReceipt | null {
  const header = response.headers.get(X402_HEADERS.response)
  if (!header) return null
  try {
    const decoded = decodeHeader(header) as SettlementReceipt
    return typeof decoded?.transaction === 'string' && decoded.transaction !== '' ? decoded : null
  } catch {
    return null
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

export function createAgentClient(config: AgentClientConfig = {}): AgentClient {
  const doFetch = config.fetch ?? globalThis.fetch
  const unpaidTimeoutMs = config.unpaidTimeoutMs ?? X402_UNPAID_TIMEOUT_MS
  const paidTimeoutMs = config.paidTimeoutMs ?? X402_PAID_TIMEOUT_MS

  async function post(
    endpoint: string,
    input: unknown,
    timeoutMs: number,
    header?: string,
  ): Promise<Response> {
    return doFetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(header ? { [X402_HEADERS.signature]: header } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  return {
    async requestUnpaid(endpoint, input): Promise<UnpaidResult> {
      let response: Response
      try {
        response = await post(endpoint, input, unpaidTimeoutMs)
      } catch (cause) {
        if (isTimeout(cause)) return { kind: 'timeout' }
        return { kind: 'transport', detail: (cause as Error).message }
      }

      const body = await readBody(response)
      if (response.status !== 402) {
        return {
          kind: 'unexpected',
          status: response.status,
          detail: detailOf(body),
        }
      }

      const payload = readPaymentRequired(response, body)
      if (!payload) {
        return {
          kind: 'unexpected',
          status: 402,
          detail: 'the 402 carried no readable payment-required payload',
        }
      }
      return { kind: 'payment_required', payload }
    },

    async requestPaid(endpoint, input, header): Promise<PaidResult> {
      let response: Response
      try {
        response = await post(endpoint, input, paidTimeoutMs, header)
      } catch (cause) {
        if (isTimeout(cause)) return { kind: 'timeout' }
        return { kind: 'transport', detail: (cause as Error).message }
      }

      const settlement = readSettlement(response)
      const body = await readBody(response)
      if (response.status >= 200 && response.status < 300) {
        return { kind: 'ok', status: response.status, body, settlement }
      }
      return { kind: 'error', status: response.status, detail: detailOf(body), settlement }
    },
  }
}
