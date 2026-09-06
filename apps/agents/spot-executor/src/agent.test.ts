import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgent, type Agent } from '@agent-desk/agent-kit'
import {
  buildPaymentSignatureHeader,
  requestPaid,
  requestUnpaid,
  StubFacilitator,
} from '@agent-desk/agent-kit/testing'
import { getDeployment, X402_HEADERS, type InternalSettings } from '@agent-desk/schemas'
import { createExecutionHandler } from './handler.ts'
import { createInternalRoutes } from './internal-routes.ts'
import { ExchangeRejectionError, ORDER_DOES_NOT_EXIST, type Exchange } from './exchange.ts'
import { createSettingsClient, type SettingsSource } from './settings.ts'

/**
 * The Spot Executor end to end against a stub facilitator and a mocked
 * `Exchange` port. Nobody has provided Spot Testnet credentials, so no real
 * order is placed anywhere in this file; `scripts/place-order.ts` is what
 * proves the live call once a key pair exists.
 *
 * What is proved here is the part the buyer pays for: a refusal is a settled
 * 200 with a schema-valid body, and the internal routes are unreachable
 * without the bearer token.
 */

const PAY_TO = '0x3333333333333333333333333333333333333333'
const INTERNAL_TOKEN = 'test-internal-token'
const INPUT = { symbol: 'BNBUSDT', side: 'BUY', size_usdt: '6' }
const OPEN: InternalSettings = { emergency_stop: false, order_ceiling_usdt: '1000' }

const FILL = {
  orderId: '6789012',
  status: 'FILLED',
  executedQty: '0.00788',
  cumulativeQuoteQty: '5.9999952',
  transactTime: 1788674230047,
  raw: { symbol: 'BNBUSDT', orderId: 6789012, status: 'FILLED' },
}

const running: Agent<'execution'>[] = []

function exchangeStub(overrides: Partial<Exchange> = {}): Exchange {
  return {
    placeMarketOrder: () => Promise.resolve(FILL),
    getOrder: (_symbol, orderId) => Promise.resolve({ orderId, raw: FILL.raw }),
    getBalance: () => Promise.resolve({ balanceUsdt: '9412.51' }),
    ...overrides,
  }
}

async function start(options: { exchange?: Exchange; settings?: SettingsSource } = {}) {
  const facilitator = new StubFacilitator()
  const exchange = options.exchange ?? exchangeStub()
  const logger = { info() {}, warn() {}, error() {} } as never
  const agent = createAgent({
    type: 'execution',
    price: '0.01',
    payTo: PAY_TO,
    facilitatorUrl: 'http://facilitator.test:4020',
    internalToken: INTERNAL_TOKEN,
    facilitatorClient: facilitator,
    logger,
    handler: createExecutionHandler({
      exchange,
      settings: options.settings ?? (() => Promise.resolve(OPEN)),
    }),
    internalRoutes: createInternalRoutes({ exchange, logger }),
  })
  running.push(agent)
  const { port } = await agent.listen(0)
  return { agent, facilitator, baseUrl: `http://127.0.0.1:${port}` }
}

/** A 402, then the same body with a payment header. */
async function pay(baseUrl: string, body: unknown) {
  const unpaid = await requestUnpaid(baseUrl, body)
  const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)
  return { unpaid, paid: await requestPaid(baseUrl, body, signature) }
}

afterEach(async () => {
  while (running.length > 0) {
    const agent = running.pop()
    if (agent) await agent.close()
  }
})

describe('agent-spot-executor', () => {
  it('answers 402 at AGENT_PRICE=0.01 with the AD-6 binding', async () => {
    const { baseUrl } = await start()
    const unpaid = await requestUnpaid(baseUrl, INPUT)

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

  it('answers the fill and a settlement receipt for a paid order', async () => {
    const { baseUrl, facilitator } = await start()
    const { paid } = await pay(baseUrl, INPUT)

    expect(paid.status).toBe(200)
    expect(paid.body).toEqual({
      status: 'FILLED',
      order_id: '6789012',
      filled_price: '761.42071066',
      filled_qty: '0.00788',
      ts: new Date(FILL.transactTime).toISOString(),
    })
    expect(paid.headers.get(X402_HEADERS.response)).toBeTruthy()
    expect(facilitator.settleCalls).toBe(1)
  })

  it('settles the emergency stop refusal: the buyer paid for the check', async () => {
    const { baseUrl, facilitator } = await start({
      settings: () => Promise.resolve({ emergency_stop: true, order_ceiling_usdt: '1000' }),
    })
    const { paid } = await pay(baseUrl, INPUT)

    expect(paid.status).toBe(200)
    expect(paid.body).toMatchObject({ status: 'REJECTED', reason: 'emergency stop' })
    expect(facilitator.settleCalls).toBe(1)
  })

  it('settles the order ceiling refusal', async () => {
    const { baseUrl, facilitator } = await start({
      settings: () => Promise.resolve({ emergency_stop: false, order_ceiling_usdt: '10' }),
    })
    const { paid } = await pay(baseUrl, { ...INPUT, size_usdt: '500' })

    expect(paid.status).toBe(200)
    expect(paid.body).toMatchObject({
      status: 'REJECTED',
      reason: 'above platform order ceiling',
    })
    expect(facilitator.settleCalls).toBe(1)
  })

  it('settles the settings-unavailable refusal through the real settings client', async () => {
    // Story 2.2 has not shipped `GET /api/internal/settings` yet, so this is
    // exactly what production sees today: the route is not there.
    const unreachable = createSettingsClient({
      baseUrl: 'http://web:3000',
      token: INTERNAL_TOKEN,
      fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as never,
    })
    const { baseUrl, facilitator } = await start({ settings: unreachable })
    const { paid } = await pay(baseUrl, INPUT)

    expect(paid.status).toBe(200)
    expect(paid.body).toMatchObject({ status: 'REJECTED', reason: 'settings unavailable' })
    expect(facilitator.settleCalls).toBe(1)
  })

  it('never places an order when the settings call fails', async () => {
    const placeMarketOrder = vi.fn(() => Promise.resolve(FILL))
    const unreachable = createSettingsClient({
      baseUrl: 'http://web:3000',
      token: INTERNAL_TOKEN,
      fetchImpl: (async () =>
        new Response('not found', { status: 404 })) as unknown as typeof globalThis.fetch,
    })
    const { baseUrl } = await start({
      exchange: exchangeStub({ placeMarketOrder }),
      settings: unreachable,
    })
    const { paid } = await pay(baseUrl, INPUT)

    expect(paid.body).toMatchObject({ status: 'REJECTED', reason: 'settings unavailable' })
    expect(placeMarketOrder).not.toHaveBeenCalled()
  })

  it('settles an exchange refusal as REJECTED, never a 5xx', async () => {
    const { baseUrl, facilitator } = await start({
      exchange: exchangeStub({
        placeMarketOrder: () =>
          Promise.reject(new ExchangeRejectionError('Filter failure: NOTIONAL', -1013)),
      }),
    })
    const { paid } = await pay(baseUrl, { ...INPUT, size_usdt: '1' })

    expect(paid.status).toBe(200)
    expect(paid.body).toMatchObject({ status: 'REJECTED', reason: 'Filter failure: NOTIONAL' })
    expect(facilitator.settleCalls).toBe(1)
  })

  it('answers 400 for a body the execution input schema refuses', async () => {
    const { baseUrl, facilitator } = await start()
    const { paid } = await pay(baseUrl, { symbol: 'bnb', side: 'BUY', size_usdt: '6' })

    expect(paid.status).toBe(400)
    expect(paid.body).toMatchObject({ error: { code: 'validation_failed' } })
    expect(facilitator.settleCalls).toBe(0)
  })

  it('runs the handler once for one payment, however often it arrives', async () => {
    const placeMarketOrder = vi.fn(() => Promise.resolve(FILL))
    const { baseUrl } = await start({ exchange: exchangeStub({ placeMarketOrder }) })

    const unpaid = await requestUnpaid(baseUrl, INPUT)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)
    const first = await requestPaid(baseUrl, INPUT, signature)
    const replay = await requestPaid(baseUrl, INPUT, signature)

    expect(first.body).toEqual(replay.body)
    expect(placeMarketOrder).toHaveBeenCalledTimes(1)
  })

  it('answers /health and /schema', async () => {
    const { baseUrl } = await start()
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200)
    const schema = await (await fetch(`${baseUrl}/schema`)).json()
    expect(schema).toMatchObject({ type: 'execution', payment: { amount: '10000' } })
  })
})

describe('the internal routes', () => {
  const bearer = { authorization: `Bearer ${INTERNAL_TOKEN}` }

  it('answers 401 without the bearer token', async () => {
    const { baseUrl } = await start()
    expect((await fetch(`${baseUrl}/internal/balance`)).status).toBe(401)
    expect(
      (await fetch(`${baseUrl}/internal/orders/6789012?symbol=BNBUSDT`)).status,
    ).toBe(401)
    expect(
      (await fetch(`${baseUrl}/internal/balance`, { headers: { authorization: 'Bearer wrong' } }))
        .status,
    ).toBe(401)
  })

  it('answers the free USDT of the Platform Exchange Account', async () => {
    const { baseUrl } = await start()
    const response = await fetch(`${baseUrl}/internal/balance`, { headers: bearer })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ balance_usdt: '9412.51' })
  })

  it('answers the live order response for a known order', async () => {
    const getOrder = vi.fn((_symbol: string, orderId: string) =>
      Promise.resolve({ orderId, raw: FILL.raw }),
    )
    const { baseUrl } = await start({ exchange: exchangeStub({ getOrder }) })
    const response = await fetch(`${baseUrl}/internal/orders/6789012?symbol=BNBUSDT`, {
      headers: bearer,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ order_id: '6789012', raw: FILL.raw })
    expect(getOrder).toHaveBeenCalledWith('BNBUSDT', '6789012')
  })

  it('answers 400 without the symbol the exchange needs', async () => {
    const { baseUrl } = await start()
    const response = await fetch(`${baseUrl}/internal/orders/6789012`, { headers: bearer })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'validation_failed' } })
  })

  it('answers 404 when the exchange has no such order', async () => {
    const { baseUrl } = await start({
      exchange: exchangeStub({
        getOrder: () =>
          Promise.reject(new ExchangeRejectionError('Order does not exist.', ORDER_DOES_NOT_EXIST)),
      }),
    })
    const response = await fetch(`${baseUrl}/internal/orders/1?symbol=BNBUSDT`, { headers: bearer })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } })
  })

  it('answers 500 when the exchange balance cannot be read', async () => {
    const { baseUrl } = await start({
      exchange: exchangeStub({
        getBalance: () => Promise.reject(new Error('Invalid API-key, IP, or permissions')),
      }),
    })
    const response = await fetch(`${baseUrl}/internal/balance`, { headers: bearer })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: 'internal_error' } })
  })
})
