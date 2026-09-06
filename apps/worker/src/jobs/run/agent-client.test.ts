import { describe, expect, it } from 'vitest'
import { X402_HEADERS } from '@agent-desk/schemas'
import { createAgentClient } from './agent-client.ts'

/**
 * The engine's half of the x402 wire, against a stubbed `fetch`.
 *
 * The base64-JSON encoding asserted below is the x402 v2 header format that
 * `@x402/core/http` implements and the agents and the facilitator both go
 * through; the fixtures are built with `Buffer.from(...).toString('base64')`,
 * which is byte-for-byte what `safeBase64Encode` produces.
 */

const ENDPOINT = 'https://ticker.test/'
const TX = `0x${'3c'.repeat(32)}`

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

const PAYMENT_REQUIRED = {
  x402Version: 2,
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:97',
      asset: '0xd0e0851ca8a176d211e2a410f5bcf1fa440fada7',
      amount: '10000',
      payTo: '0x1e4a2f7d3c9b60518a7d3f2c4b8e91d0a6c73f52',
      maxTimeoutSeconds: 15,
      extra: { name: 'tUSD', version: '1' },
    },
  ],
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers })
}

describe('requestUnpaid', () => {
  it('reads the payment-required payload out of the header', async () => {
    const client = createAgentClient({
      fetch: () =>
        Promise.resolve(
          response(402, { error: 'payment required' }, {
            [X402_HEADERS.required]: encode(PAYMENT_REQUIRED),
          }),
        ),
    })
    expect(await client.requestUnpaid(ENDPOINT, { symbol: 'BNBUSDT' })).toEqual({
      kind: 'payment_required',
      payload: PAYMENT_REQUIRED,
    })
  })

  it('falls back to the body when the header is missing or unreadable', async () => {
    const fromBody = createAgentClient({
      fetch: () => Promise.resolve(response(402, PAYMENT_REQUIRED)),
    })
    expect(await fromBody.requestUnpaid(ENDPOINT, {})).toMatchObject({ kind: 'payment_required' })

    const brokenHeader = createAgentClient({
      fetch: () =>
        Promise.resolve(
          response(402, PAYMENT_REQUIRED, { [X402_HEADERS.required]: 'not base64 !!' }),
        ),
    })
    expect(await brokenHeader.requestUnpaid(ENDPOINT, {})).toMatchObject({
      kind: 'payment_required',
    })
  })

  it('reports a 402 with no readable payload as unexpected rather than paying', async () => {
    const client = createAgentClient({ fetch: () => Promise.resolve(response(402, { nope: true })) })
    expect(await client.requestUnpaid(ENDPOINT, {})).toEqual({
      kind: 'unexpected',
      status: 402,
      detail: 'the 402 carried no readable payment-required payload',
    })
  })

  it('reports any other status as unexpected, body included', async () => {
    const client = createAgentClient({ fetch: () => Promise.resolve(response(500, { error: 'boom' })) })
    expect(await client.requestUnpaid(ENDPOINT, {})).toMatchObject({
      kind: 'unexpected',
      status: 500,
      detail: '{"error":"boom"}',
    })
  })

  it('separates a timeout from any other transport failure', async () => {
    const timedOut = createAgentClient({
      fetch: () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
    })
    expect(await timedOut.requestUnpaid(ENDPOINT, {})).toEqual({ kind: 'timeout' })

    const refused = createAgentClient({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    })
    expect(await refused.requestUnpaid(ENDPOINT, {})).toEqual({
      kind: 'transport',
      detail: 'fetch failed',
    })
  })

  it('sends the input as a JSON POST and no payment header', async () => {
    let seen: RequestInit | undefined
    const client = createAgentClient({
      fetch: (_url, init) => {
        seen = init
        return Promise.resolve(response(402, PAYMENT_REQUIRED))
      },
    })
    await client.requestUnpaid(ENDPOINT, { symbol: 'BNBUSDT' })
    expect(seen?.method).toBe('POST')
    expect(seen?.body).toBe('{"symbol":"BNBUSDT"}')
    expect((seen?.headers as Record<string, string>)[X402_HEADERS.signature]).toBeUndefined()
  })
})

describe('requestPaid', () => {
  it('sends the stored header and decodes the settlement receipt', async () => {
    let seen: RequestInit | undefined
    const client = createAgentClient({
      fetch: (_url, init) => {
        seen = init
        return Promise.resolve(
          response(200, { ok: true }, {
            [X402_HEADERS.response]: encode({ success: true, transaction: TX, network: 'eip155:97' }),
          }),
        )
      },
    })

    const result = await client.requestPaid(ENDPOINT, { symbol: 'BNBUSDT' }, 'HEADER')

    expect((seen?.headers as Record<string, string>)[X402_HEADERS.signature]).toBe('HEADER')
    expect(result).toEqual({
      kind: 'ok',
      status: 200,
      body: { ok: true },
      settlement: { success: true, transaction: TX, network: 'eip155:97' },
    })
  })

  it('reports a 200 with no PAYMENT-RESPONSE as a settlement of null', async () => {
    const client = createAgentClient({ fetch: () => Promise.resolve(response(200, { ok: true })) })
    expect(await client.requestPaid(ENDPOINT, {}, 'HEADER')).toMatchObject({
      kind: 'ok',
      settlement: null,
    })
  })

  it('ignores a PAYMENT-RESPONSE with no transaction hash', async () => {
    const client = createAgentClient({
      fetch: () =>
        Promise.resolve(
          response(200, { ok: true }, { [X402_HEADERS.response]: encode({ success: false }) }),
        ),
    })
    expect(await client.requestPaid(ENDPOINT, {}, 'HEADER')).toMatchObject({ settlement: null })
  })

  it('reports a 5xx as an error, not a timeout, so it is never retried', async () => {
    const client = createAgentClient({
      fetch: () => Promise.resolve(response(500, { error: { message: 'handler failed' } })),
    })
    expect(await client.requestPaid(ENDPOINT, {}, 'HEADER')).toMatchObject({
      kind: 'error',
      status: 500,
      settlement: null,
    })
  })

  it('reports a timeout as a timeout, which is the only retryable outcome', async () => {
    const client = createAgentClient({
      fetch: () => Promise.reject(new DOMException('aborted', 'TimeoutError')),
    })
    expect(await client.requestPaid(ENDPOINT, {}, 'HEADER')).toEqual({ kind: 'timeout' })
  })
})
