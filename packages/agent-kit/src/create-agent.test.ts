import { afterEach, describe, expect, it } from 'vitest'
import { Router } from 'express'
import { decodePaymentResponseHeader } from '@x402/core/http'
import type { PaymentRequirements } from '@x402/core/types'
import { getDeployment, X402_HEADERS, type DataOutput } from '@agent-desk/schemas'
import { createAgent, type Agent, type AgentHandler } from './create-agent.ts'
import {
  buildPaymentSignatureHeader,
  requestPaid,
  requestUnpaid,
  StubFacilitator,
  STUB_TX_HASH,
} from './test-support.ts'

const PAY_TO = '0x2222222222222222222222222222222222222222'
const SAMPLE: DataOutput = {
  symbol: 'BNBUSDT',
  price: '612.40',
  change_24h_pct: -1.8,
  volatility_24h_pct: 3.2,
  ts: '2026-09-05T02:00:00Z',
}

interface Harness {
  agent: Agent<'data'>
  baseUrl: string
  facilitator: StubFacilitator
  handlerCalls: () => number
}

const running: Agent<'data'>[] = []

async function start(options: {
  handler?: AgentHandler<'data'>
  facilitator?: StubFacilitator
  internalRoutes?: Parameters<typeof createAgent<'data'>>[0]['internalRoutes']
  internalToken?: string | undefined
  handlerBudgetMs?: number
  price?: string
}): Promise<Harness> {
  let calls = 0
  const facilitator = options.facilitator ?? new StubFacilitator()
  const handler: AgentHandler<'data'> = options.handler ?? (() => SAMPLE)
  const agent = createAgent<'data'>({
    type: 'data',
    price: options.price ?? '0.01',
    payTo: PAY_TO,
    facilitatorUrl: 'http://facilitator.test:4020',
    internalToken: options.internalToken === undefined ? 'test-internal-token' : options.internalToken,
    facilitatorClient: facilitator,
    handlerBudgetMs: options.handlerBudgetMs ?? 10_000,
    internalRoutes: options.internalRoutes,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    handler: (input, context) => {
      calls += 1
      return handler(input, context)
    },
  })
  running.push(agent)
  const { port } = await agent.listen(0)
  return {
    agent,
    baseUrl: `http://127.0.0.1:${port}`,
    facilitator,
    handlerCalls: () => calls,
  }
}

afterEach(async () => {
  while (running.length > 0) {
    const agent = running.pop()
    if (agent) await agent.close()
  }
})

describe('GET /health and GET /schema', () => {
  it('answers 200 on /health', async () => {
    const { baseUrl } = await start({})
    const response = await fetch(`${baseUrl}/health`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      type: 'data',
      price: '0.01',
      amount: '10000',
      network: 'eip155:97',
    })
  })

  it('publishes the Type input and output JSON schema on /schema', async () => {
    const { baseUrl } = await start({})
    const response = await fetch(`${baseUrl}/schema`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, never>

    expect(body).toMatchObject({ type: 'data', x402Version: 2 })
    expect(body.input).toMatchObject({
      type: 'object',
      required: ['symbol'],
      properties: { symbol: { type: 'string', pattern: '^[A-Z0-9]{5,20}$' } },
    })
    expect(body.output).toMatchObject({
      type: 'object',
      required: ['symbol', 'price', 'change_24h_pct', 'volatility_24h_pct', 'ts'],
      properties: {
        change_24h_pct: { type: 'number' },
        volatility_24h_pct: { type: 'number', minimum: 0 },
        ts: { type: 'string', format: 'date-time' },
      },
    })
    expect(body.payment).toMatchObject({
      scheme: 'exact',
      network: 'eip155:97',
      amount: '10000',
      payTo: PAY_TO,
      maxTimeoutSeconds: 15,
      extra: { name: 'tUSD', version: '1' },
    })
  })
})

describe('the unpaid 402', () => {
  it('answers one accepts entry that matches the AD-6 binding', async () => {
    const { baseUrl } = await start({})
    const unpaid = await requestUnpaid(baseUrl, { symbol: 'BNBUSDT' })

    expect(unpaid.status).toBe(402)
    expect(unpaid.headers.get(X402_HEADERS.required)).toBeTruthy()
    expect(unpaid.paymentRequired.x402Version).toBe(2)
    expect(unpaid.paymentRequired.accepts).toHaveLength(1)

    const accepts = unpaid.paymentRequired.accepts[0] as PaymentRequirements
    // deployments/97.json still holds the zero address until Story 1.2 deploys,
    // so the asset is asserted against whatever the file says today.
    const deployment = getDeployment(97)
    expect(accepts).toEqual({
      scheme: 'exact',
      network: 'eip155:97',
      asset: deployment.tusd.address.toLowerCase(),
      amount: '10000',
      payTo: PAY_TO,
      maxTimeoutSeconds: 15,
      extra: { name: 'tUSD', version: '1' },
    })
    expect(accepts.maxTimeoutSeconds).toBeLessThanOrEqual(15)
  })

  it('scales the amount with AGENT_PRICE through toBaseUnits', async () => {
    const { baseUrl } = await start({ price: '0.005' })
    const unpaid = await requestUnpaid(baseUrl, { symbol: 'BNBUSDT' })
    expect(unpaid.paymentRequired.accepts[0]?.amount).toBe('5000')
  })

  it('does not settle an unpaid request', async () => {
    const { baseUrl, facilitator, handlerCalls } = await start({})
    await requestUnpaid(baseUrl, { symbol: 'BNBUSDT' })
    expect(facilitator.verifyCalls).toBe(0)
    expect(facilitator.settleCalls).toBe(0)
    expect(handlerCalls()).toBe(0)
  })
})

describe('the paid pipeline', () => {
  it('verifies, runs the handler, validates, settles, and answers 200', async () => {
    const harness = await start({})
    const unpaid = await requestUnpaid(harness.baseUrl, { symbol: 'BNBUSDT' })
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(harness.baseUrl, { symbol: 'BNBUSDT' }, signature)

    expect(paid.status).toBe(200)
    expect(paid.body).toEqual(SAMPLE)
    expect(harness.facilitator.verifyCalls).toBe(1)
    expect(harness.facilitator.settleCalls).toBe(1)
    expect(harness.handlerCalls()).toBe(1)

    const receipt = paid.headers.get(X402_HEADERS.response)
    expect(receipt).toBeTruthy()
    expect(decodePaymentResponseHeader(receipt!)).toMatchObject({
      success: true,
      transaction: STUB_TX_HASH,
      network: 'eip155:97',
    })
  })

  it('rejects a body the Type input schema refuses with 400 and never settles', async () => {
    const harness = await start({})
    const unpaid = await requestUnpaid(harness.baseUrl, { symbol: 'BNBUSDT' })
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(harness.baseUrl, { symbol: 'bnb' }, signature)

    expect(paid.status).toBe(400)
    expect(paid.body).toMatchObject({ error: { code: 'validation_failed' } })
    expect(harness.facilitator.verifyCalls).toBe(1)
    expect(harness.facilitator.settleCalls).toBe(0)
    expect(harness.handlerCalls()).toBe(0)
  })

  it('answers 500 and never settles when the output fails validateOutput', async () => {
    const harness = await start({
      handler: () => ({ ...SAMPLE, volatility_24h_pct: -1 }) as never,
    })
    const unpaid = await requestUnpaid(harness.baseUrl, { symbol: 'BNBUSDT' })
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(harness.baseUrl, { symbol: 'BNBUSDT' }, signature)

    expect(paid.status).toBe(500)
    expect(paid.body).toMatchObject({ error: { code: 'internal_error' } })
    expect((paid.body as { error: { message: string } }).error.message).toContain(
      'invalid agent output',
    )
    expect(harness.facilitator.settleCalls).toBe(0)
  })

  it('answers 500 and never settles when the handler throws', async () => {
    const harness = await start({
      handler: () => {
        throw new Error('upstream exploded')
      },
    })
    const unpaid = await requestUnpaid(harness.baseUrl, { symbol: 'BNBUSDT' })
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(harness.baseUrl, { symbol: 'BNBUSDT' }, signature)

    expect(paid.status).toBe(500)
    expect((paid.body as { error: { message: string } }).error.message).toContain(
      'upstream exploded',
    )
    expect(harness.facilitator.settleCalls).toBe(0)
  })

  it('aborts the handler and answers 500 when the budget expires', async () => {
    let aborted = false
    const harness = await start({
      handlerBudgetMs: 120,
      handler: (_input, context) =>
        new Promise<DataOutput>((resolve) => {
          context.signal.addEventListener('abort', () => {
            aborted = true
          })
          setTimeout(() => resolve(SAMPLE), 2_000).unref?.()
        }),
    })
    const unpaid = await requestUnpaid(harness.baseUrl, { symbol: 'BNBUSDT' })
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(harness.baseUrl, { symbol: 'BNBUSDT' }, signature)

    expect(paid.status).toBe(500)
    expect((paid.body as { error: { message: string } }).error.message).toContain('120 ms budget')
    expect(aborted).toBe(true)
    expect(harness.facilitator.settleCalls).toBe(0)
  })
})

describe('single flight per PAYMENT-SIGNATURE', () => {
  it('runs the handler once for two concurrent duplicates', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = await start({
      handler: async () => {
        await gate
        return SAMPLE
      },
    })
    const unpaid = await requestUnpaid(harness.baseUrl, { symbol: 'BNBUSDT' })
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const first = requestPaid(harness.baseUrl, { symbol: 'BNBUSDT' }, signature)
    const second = requestPaid(harness.baseUrl, { symbol: 'BNBUSDT' }, signature)
    // Let both requests reach the handler before it can finish.
    await new Promise((resolve) => setTimeout(resolve, 50))
    release?.()
    const [a, b] = await Promise.all([first, second])

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.body).toEqual(SAMPLE)
    expect(b.body).toEqual(SAMPLE)
    expect(harness.handlerCalls()).toBe(1)
  })

  it('runs the handler again for a different PAYMENT-SIGNATURE', async () => {
    const harness = await start({})
    const unpaid = await requestUnpaid(harness.baseUrl, { symbol: 'BNBUSDT' })
    const accepts = unpaid.paymentRequired.accepts[0]!

    await requestPaid(harness.baseUrl, { symbol: 'BNBUSDT' }, buildPaymentSignatureHeader(accepts))
    await requestPaid(harness.baseUrl, { symbol: 'BNBUSDT' }, buildPaymentSignatureHeader(accepts))

    expect(harness.handlerCalls()).toBe(2)
    expect(harness.facilitator.settleCalls).toBe(2)
  })

  it('caches the output when settle fails and re-attempts settle on the retry', async () => {
    const facilitator = new StubFacilitator({
      settle: (call) =>
        call === 1
          ? {
              success: false,
              transaction: '',
              errorReason: 'unexpected_settle_error',
              errorMessage: 'relayer nonce stuck',
            }
          : { success: true, transaction: STUB_TX_HASH },
    })
    const harness = await start({ facilitator })
    const unpaid = await requestUnpaid(harness.baseUrl, { symbol: 'BNBUSDT' })
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const first = await requestPaid(harness.baseUrl, { symbol: 'BNBUSDT' }, signature)
    // The middleware answers the settlement failure itself; the point is that the
    // caller never got a receipt and the handler output survives for the retry.
    expect(first.status).toBe(402)
    expect(decodePaymentResponseHeader(first.headers.get(X402_HEADERS.response)!)).toMatchObject({
      success: false,
      errorReason: 'unexpected_settle_error',
    })
    expect(harness.handlerCalls()).toBe(1)
    expect(facilitator.settleCalls).toBe(1)

    const retry = await requestPaid(harness.baseUrl, { symbol: 'BNBUSDT' }, signature)

    // The handler is not run a second time; only settle is re-attempted.
    expect(harness.handlerCalls()).toBe(1)
    expect(facilitator.settleCalls).toBe(2)
    expect(retry.status).toBe(200)
    expect(retry.body).toEqual(SAMPLE)
    expect(decodePaymentResponseHeader(retry.headers.get(X402_HEADERS.response)!)).toMatchObject({
      success: true,
      transaction: STUB_TX_HASH,
    })
  })

  it('does not cache a failed attempt, so the retry runs the handler again', async () => {
    let attempts = 0
    const harness = await start({
      handler: () => {
        attempts += 1
        if (attempts === 1) throw new Error('transient upstream')
        return SAMPLE
      },
    })
    const unpaid = await requestUnpaid(harness.baseUrl, { symbol: 'BNBUSDT' })
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const first = await requestPaid(harness.baseUrl, { symbol: 'BNBUSDT' }, signature)
    expect(first.status).toBe(500)

    const retry = await requestPaid(harness.baseUrl, { symbol: 'BNBUSDT' }, signature)
    expect(retry.status).toBe(200)
    expect(harness.handlerCalls()).toBe(2)
    expect(harness.facilitator.settleCalls).toBe(1)
  })
})

describe('/internal/* behind Authorization: Bearer INTERNAL_TOKEN', () => {
  const routes = (router: Router) => {
    router.get('/balance', (_req, res) => {
      res.status(200).json({ balance_usdt: '950.00' })
    })
  }

  it('answers 401 without a token', async () => {
    const { baseUrl } = await start({ internalRoutes: routes })
    const response = await fetch(`${baseUrl}/internal/balance`)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'unauthorized' } })
  })

  it('answers 401 with the wrong token', async () => {
    const { baseUrl } = await start({ internalRoutes: routes })
    const response = await fetch(`${baseUrl}/internal/balance`, {
      headers: { authorization: 'Bearer not-the-token' },
    })
    expect(response.status).toBe(401)
  })

  it('answers the declared route with the right token', async () => {
    const { baseUrl } = await start({ internalRoutes: routes })
    const response = await fetch(`${baseUrl}/internal/balance`, {
      headers: { authorization: 'Bearer test-internal-token' },
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ balance_usdt: '950.00' })
  })

  it('accepts a pre-built Router as well as a builder', async () => {
    const router = Router()
    router.get('/ping', (_req, res) => {
      res.status(200).json({ pong: true })
    })
    const { baseUrl } = await start({ internalRoutes: router })
    const response = await fetch(`${baseUrl}/internal/ping`, {
      headers: { authorization: 'Bearer test-internal-token' },
    })
    expect(response.status).toBe(200)
  })

  it('guards /internal/* even when the agent declares no internal route', async () => {
    const { baseUrl } = await start({})
    const response = await fetch(`${baseUrl}/internal/anything`)
    expect(response.status).toBe(401)
  })

  it('answers 401 when no INTERNAL_TOKEN is configured', async () => {
    const { baseUrl } = await start({ internalRoutes: routes, internalToken: '' })
    const response = await fetch(`${baseUrl}/internal/balance`, {
      headers: { authorization: 'Bearer ' },
    })
    expect(response.status).toBe(401)
  })
})
