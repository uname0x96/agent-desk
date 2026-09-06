import { afterEach, describe, expect, it } from 'vitest'
import { createAgent, type Agent } from '@agent-desk/agent-kit'
import {
  buildPaymentSignatureHeader,
  requestPaid,
  requestUnpaid,
  StubFacilitator,
} from '@agent-desk/agent-kit/testing'
import { getDeployment, X402_HEADERS, type RiskInput } from '@agent-desk/schemas'
import { riskHandler } from './handler.ts'
import { seedListing } from './listing.ts'

/**
 * The Guardrail Risk agent end to end against a stub facilitator. The chain
 * half — a real signature, a real settlement, a tx hash on BSC testnet — is
 * `packages/agent-kit/scripts/paid-request.ts`.
 */

const PAY_TO = '0x4444444444444444444444444444444444444444'

const CALM_MARKET = {
  symbol: 'BNBUSDT',
  price: '612.40',
  change_24h_pct: 2.4,
  volatility_24h_pct: 4.2,
  ts: '2026-09-05T02:00:00Z',
}

const REQUEST: RiskInput = {
  symbol: 'BNBUSDT',
  signal: 'LONG',
  confidence: 0.72,
  proposed_size_usdt: '100',
  balance_usdt: '950.00',
  market: CALM_MARKET,
}

const running: Agent<'risk'>[] = []

async function start(facilitator = new StubFacilitator()) {
  const agent = createAgent({
    type: 'risk',
    price: seedListing.price,
    payTo: PAY_TO,
    facilitatorUrl: 'http://facilitator.test:4020',
    internalToken: 'test-internal-token',
    facilitatorClient: facilitator,
    logger: { info() {}, warn() {}, error() {} } as never,
    handler: riskHandler,
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

describe('agent-guardrail-risk', () => {
  it('answers 402 at AGENT_PRICE=0.02 with the AD-6 binding', async () => {
    const { baseUrl } = await start()
    const unpaid = await requestUnpaid(baseUrl, REQUEST)

    expect(unpaid.status).toBe(402)
    expect(unpaid.paymentRequired.accepts).toEqual([
      {
        scheme: 'exact',
        network: 'eip155:97',
        asset: getDeployment(97).tusd.address.toLowerCase(),
        amount: '20000',
        payTo: PAY_TO,
        maxTimeoutSeconds: 15,
        extra: { name: 'tUSD', version: '1' },
      },
    ])
  })

  it('answers a decision and a settlement receipt for a paid request', async () => {
    const { baseUrl, facilitator } = await start()
    const unpaid = await requestUnpaid(baseUrl, REQUEST)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(baseUrl, REQUEST, signature)

    expect(paid.status).toBe(200)
    expect(paid.body).toMatchObject({ decision: 'REDUCE', size_usdt: '60' })
    expect(paid.headers.get(X402_HEADERS.response)).toBeTruthy()
    expect(facilitator.settleCalls).toBe(1)
  })

  it('rejects the demo beat: a confident LONG into a falling market', async () => {
    const { baseUrl, facilitator } = await start()
    const body: RiskInput = {
      ...REQUEST,
      confidence: 0.9,
      market: { ...CALM_MARKET, change_24h_pct: -2.4 },
    }
    const unpaid = await requestUnpaid(baseUrl, body)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(baseUrl, body, signature)

    expect(paid.status).toBe(200)
    expect(paid.body).toMatchObject({ decision: 'REJECT', size_usdt: '0' })
    // A REJECT is a paid answer, not a failure: the Creator is still settled.
    expect(facilitator.settleCalls).toBe(1)
  })

  it('answers 400 for a body the risk input schema refuses', async () => {
    const { baseUrl, facilitator } = await start()
    const unpaid = await requestUnpaid(baseUrl, REQUEST)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(baseUrl, { ...REQUEST, confidence: 1.4 }, signature)

    expect(paid.status).toBe(400)
    expect(paid.body).toMatchObject({ error: { code: 'validation_failed' } })
    expect(facilitator.settleCalls).toBe(0)
  })

  it('answers /health and /schema', async () => {
    const { baseUrl } = await start()
    const health = await fetch(`${baseUrl}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok', type: 'risk', price: '0.02' })
    const schema = await (await fetch(`${baseUrl}/schema`)).json()
    expect(schema).toMatchObject({ type: 'risk', payment: { amount: '20000' } })
  })
})

describe('seedListing', () => {
  it('carries what the seed needs, matching the compose service', () => {
    expect(seedListing).toEqual({
      name: 'Guardrail Risk',
      type: 'risk',
      price: '0.02',
      port: 4104,
      endpointEnv: 'GUARDRAIL_RISK_URL',
      defaultEndpoint: 'http://agent-guardrail-risk:4104',
      description: expect.any(String),
    })
  })
})
