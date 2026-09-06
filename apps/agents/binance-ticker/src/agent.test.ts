import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgent, type Agent } from '@agent-desk/agent-kit'
import {
  buildPaymentSignatureHeader,
  requestPaid,
  requestUnpaid,
  StubFacilitator,
} from '@agent-desk/agent-kit/testing'
import { getDeployment, X402_HEADERS } from '@agent-desk/schemas'
import { createTickerHandler } from './handler.ts'
import { DEFAULT_MARKET_DATA_URL } from './market-data.ts'

/**
 * The Binance Ticker agent end to end against a stub facilitator and stub
 * market data. The chain half — a real signature, a real settlement, a tx hash
 * on BSC testnet — is `packages/agent-kit/scripts/paid-request.ts`, which
 * cannot run until tUSD is deployed and the facilitator is up.
 */

const PAY_TO = '0x3333333333333333333333333333333333333333'
const TICKER = {
  symbol: 'BNBUSDT',
  priceChangePercent: '5.327',
  lastPrice: '761.27000000',
  highPrice: '780.64000000',
  lowPrice: '721.56000000',
  closeTime: 1788674230047,
}

const running: Agent<'data'>[] = []

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function start(fetchImpl: typeof globalThis.fetch, facilitator = new StubFacilitator()) {
  const agent = createAgent({
    type: 'data',
    price: '0.01',
    payTo: PAY_TO,
    facilitatorUrl: 'http://facilitator.test:4020',
    internalToken: 'test-internal-token',
    facilitatorClient: facilitator,
    logger: { info() {}, warn() {}, error() {} } as never,
    handler: createTickerHandler({ fetchImpl, baseUrl: DEFAULT_MARKET_DATA_URL }),
  })
  running.push(agent)
  const { port } = await agent.listen(0)
  return { agent, facilitator, baseUrl: `http://127.0.0.1:${port}` }
}

afterEach(async () => {
  while (running.length > 0) {
    const agent = running.pop()
    if (agent) await agent.close()
  }
})

describe('agent-binance-ticker', () => {
  it('answers 402 at AGENT_PRICE=0.01 with the AD-6 binding', async () => {
    const { baseUrl } = await start(vi.fn(async () => jsonResponse(TICKER)) as never)
    const unpaid = await requestUnpaid(baseUrl, { symbol: 'BNBUSDT' })

    expect(unpaid.status).toBe(402)
    expect(unpaid.paymentRequired.accepts).toEqual([
      {
        scheme: 'exact',
        network: 'eip155:97',
        asset: getDeployment(97).tusd.address.toLowerCase(),
        amount: '10000',
        payTo: PAY_TO,
        maxTimeoutSeconds: 15,
        extra: { name: 'tUSD', version: '1' },
      },
    ])
  })

  it('answers the 24 h ticker and a settlement receipt for a paid request', async () => {
    const { baseUrl, facilitator } = await start(
      vi.fn(async () => jsonResponse(TICKER)) as never,
    )
    const unpaid = await requestUnpaid(baseUrl, { symbol: 'BNBUSDT' })
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(baseUrl, { symbol: 'BNBUSDT' }, signature)

    expect(paid.status).toBe(200)
    expect(paid.body).toEqual({
      symbol: 'BNBUSDT',
      price: '761.27',
      change_24h_pct: 5.327,
      volatility_24h_pct: 8.1878,
      ts: new Date(TICKER.closeTime).toISOString(),
    })
    expect(paid.headers.get(X402_HEADERS.response)).toBeTruthy()
    expect(facilitator.settleCalls).toBe(1)
  })

  it('answers 500 and never settles on an unknown symbol', async () => {
    const { baseUrl, facilitator } = await start(
      vi.fn(async () => jsonResponse({ code: -1121, msg: 'Invalid symbol.' }, 400)) as never,
    )
    const unpaid = await requestUnpaid(baseUrl, { symbol: 'NOTASYMBOL' })
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(baseUrl, { symbol: 'NOTASYMBOL' }, signature)

    expect(paid.status).toBe(500)
    expect(paid.body).toMatchObject({ error: { code: 'internal_error' } })
    expect((paid.body as { error: { message: string } }).error.message).toContain(
      'unknown symbol NOTASYMBOL',
    )
    expect(facilitator.settleCalls).toBe(0)
  })

  it('answers 500 and never settles when market data outlives its 8 s deadline', async () => {
    const hanging = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as unknown as typeof globalThis.fetch
    const facilitator = new StubFacilitator()
    const agent = createAgent({
      type: 'data',
      price: '0.01',
      payTo: PAY_TO,
      facilitatorUrl: 'http://facilitator.test:4020',
      internalToken: 'test-internal-token',
      facilitatorClient: facilitator,
      logger: { info() {}, warn() {}, error() {} } as never,
      // The same 8 s rule, shortened so the test does not wait for it.
      handler: createTickerHandler({ fetchImpl: hanging, timeoutMs: 60 }),
    })
    running.push(agent)
    const { port } = await agent.listen(0)
    const baseUrl = `http://127.0.0.1:${port}`

    const unpaid = await requestUnpaid(baseUrl, { symbol: 'BNBUSDT' })
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)
    const paid = await requestPaid(baseUrl, { symbol: 'BNBUSDT' }, signature)

    expect(paid.status).toBe(500)
    expect((paid.body as { error: { message: string } }).error.message).toContain('timed out')
    expect(facilitator.settleCalls).toBe(0)
  })

  it('answers 400 for a body the data input schema refuses', async () => {
    const { baseUrl, facilitator } = await start(vi.fn(async () => jsonResponse(TICKER)) as never)
    const unpaid = await requestUnpaid(baseUrl, { symbol: 'BNBUSDT' })
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(baseUrl, { symbol: 'bnb' }, signature)

    expect(paid.status).toBe(400)
    expect(paid.body).toMatchObject({ error: { code: 'validation_failed' } })
    expect(facilitator.settleCalls).toBe(0)
  })

  it('answers /health and /schema', async () => {
    const { baseUrl } = await start(vi.fn(async () => jsonResponse(TICKER)) as never)
    await expect((await fetch(`${baseUrl}/health`)).status).toBe(200)
    const schema = await (await fetch(`${baseUrl}/schema`)).json()
    expect(schema).toMatchObject({ type: 'data', payment: { amount: '10000' } })
  })
})
