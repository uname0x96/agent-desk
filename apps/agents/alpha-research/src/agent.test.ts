import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgent, type Agent } from '@agent-desk/agent-kit'
import {
  buildPaymentSignatureHeader,
  requestPaid,
  requestUnpaid,
  StubFacilitator,
} from '@agent-desk/agent-kit/testing'
import { getDeployment, toBaseUnits, X402_HEADERS } from '@agent-desk/schemas'
import { createAlphaHandler, FALLBACK_OUTPUT } from './handler.ts'
import type { ResearchModel } from './model.ts'
import { seedListing } from './seed-listing.ts'

/**
 * The Alpha Research agent end to end against a stub facilitator and a stubbed
 * model. The chain half is `packages/agent-kit/scripts/paid-request.ts`; the
 * live model half needs an ANTHROPIC_API_KEY that is not set in this repo.
 */

const PAY_TO = '0x5555555555555555555555555555555555555555'
const REQUEST = {
  symbol: 'BNBUSDT',
  market: {
    symbol: 'BNBUSDT',
    price: '761.27',
    change_24h_pct: 5.327,
    volatility_24h_pct: 8.1878,
    ts: '2026-09-05T12:00:00.000Z',
  },
}
const ANSWER = '{"signal":"LONG","confidence":0.72,"reason":"BNBUSDT rose 5.33 % over 24 h."}'

const running: Agent<'research'>[] = []

async function start(model: ResearchModel) {
  const facilitator = new StubFacilitator()
  const agent = createAgent({
    type: 'research',
    price: seedListing.price,
    payTo: PAY_TO,
    facilitatorUrl: 'http://facilitator.test:4020',
    internalToken: 'test-internal-token',
    facilitatorClient: facilitator,
    logger: { info() {}, warn() {}, error() {} } as never,
    handler: createAlphaHandler({ model, timeoutMs: 40 }),
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

describe('agent-alpha-research', () => {
  it('answers 402 for exactly toBaseUnits(AGENT_PRICE) with the AD-6 binding', async () => {
    const { baseUrl } = await start(vi.fn(async () => ANSWER))
    const unpaid = await requestUnpaid(baseUrl, REQUEST)

    expect(unpaid.status).toBe(402)
    expect(unpaid.paymentRequired.accepts).toEqual([
      {
        scheme: 'exact',
        network: 'eip155:97',
        asset: getDeployment(97).tusd.address.toLowerCase(),
        // 0.05 tUSD at six decimals.
        amount: toBaseUnits('0.05').toString(),
        payTo: PAY_TO,
        maxTimeoutSeconds: 15,
        extra: { name: 'tUSD', version: '1' },
      },
    ])
  })

  it('answers the model signal and a settlement receipt for a paid request', async () => {
    const { baseUrl, facilitator } = await start(vi.fn(async () => ANSWER))
    const unpaid = await requestUnpaid(baseUrl, REQUEST)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(baseUrl, REQUEST, signature)

    expect(paid.status).toBe(200)
    expect(paid.body).toEqual({
      signal: 'LONG',
      confidence: 0.72,
      reason: 'BNBUSDT rose 5.33 % over 24 h.',
    })
    expect(paid.headers.get(X402_HEADERS.response)).toBeTruthy()
    expect(facilitator.settleCalls).toBe(1)
  })

  it('answers 200 and settles the HOLD fallback when the model is unavailable', async () => {
    // The paid request is still an answer: a settled 200, not a failed Call.
    const { baseUrl, facilitator } = await start(
      vi.fn(async () => {
        throw new Error('529 overloaded_error')
      }),
    )
    const unpaid = await requestUnpaid(baseUrl, REQUEST)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(baseUrl, REQUEST, signature)

    expect(paid.status).toBe(200)
    expect(paid.body).toEqual(FALLBACK_OUTPUT)
    expect(facilitator.settleCalls).toBe(1)
  })

  it('runs the model once for one PAYMENT-SIGNATURE, however often it arrives', async () => {
    const model = vi.fn(async () => ANSWER)
    const { baseUrl, facilitator } = await start(model)
    const unpaid = await requestUnpaid(baseUrl, REQUEST)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const first = await requestPaid(baseUrl, REQUEST, signature)
    const replay = await requestPaid(baseUrl, REQUEST, signature)

    expect(first.body).toEqual(replay.body)
    expect(model).toHaveBeenCalledTimes(1)
    expect(facilitator.settleCalls).toBe(2)
  })

  it('answers 400 for a body the research input schema refuses', async () => {
    const model = vi.fn(async () => ANSWER)
    const { baseUrl, facilitator } = await start(model)
    const unpaid = await requestUnpaid(baseUrl, REQUEST)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(baseUrl, { symbol: 'BNBUSDT', market: {} }, signature)

    expect(paid.status).toBe(400)
    expect(paid.body).toMatchObject({ error: { code: 'validation_failed' } })
    expect(model).not.toHaveBeenCalled()
    expect(facilitator.settleCalls).toBe(0)
  })

  it('answers /health and /schema', async () => {
    const { baseUrl } = await start(vi.fn(async () => ANSWER))
    const health = await fetch(`${baseUrl}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok', type: 'research', price: '0.05' })

    const schema = await (await fetch(`${baseUrl}/schema`)).json()
    expect(schema).toMatchObject({ type: 'research', payment: { amount: '50000' } })
  })
})
