import { afterEach, describe, expect, it } from 'vitest'
import { createAgent, type Agent } from '@agent-desk/agent-kit'
import {
  buildPaymentSignatureHeader,
  requestPaid,
  requestUnpaid,
  StubFacilitator,
} from '@agent-desk/agent-kit/testing'
import { getDeployment, toBaseUnits, X402_HEADERS } from '@agent-desk/schemas'
import { createSloppyHandler, SLOPPY_REASON } from './handler.ts'
import { seedListing } from './seed-listing.ts'

/**
 * The Sloppy Research agent end to end against a stub facilitator. The chain
 * half — a real signature, a real settlement, a tx hash on BSC testnet — is
 * `packages/agent-kit/scripts/paid-request.ts`.
 */

const PAY_TO = '0x4444444444444444444444444444444444444444'
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

const running: Agent<'research'>[] = []

async function start() {
  const facilitator = new StubFacilitator()
  const agent = createAgent({
    type: 'research',
    price: seedListing.price,
    payTo: PAY_TO,
    facilitatorUrl: 'http://facilitator.test:4020',
    internalToken: 'test-internal-token',
    facilitatorClient: facilitator,
    logger: { info() {}, warn() {}, error() {} } as never,
    handler: createSloppyHandler(),
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

describe('agent-sloppy-research', () => {
  it('answers 402 for exactly toBaseUnits(AGENT_PRICE) with the AD-6 binding', async () => {
    const { baseUrl } = await start()
    const unpaid = await requestUnpaid(baseUrl, REQUEST)

    expect(unpaid.status).toBe(402)
    expect(unpaid.paymentRequired.accepts).toEqual([
      {
        scheme: 'exact',
        network: 'eip155:97',
        asset: getDeployment(97).tusd.address.toLowerCase(),
        // 0.03 tUSD at six decimals.
        amount: toBaseUnits('0.03').toString(),
        payTo: PAY_TO,
        maxTimeoutSeconds: 15,
        extra: { name: 'tUSD', version: '1' },
      },
    ])
  })

  it('answers the contrarian signal and a settlement receipt for a paid request', async () => {
    const { baseUrl, facilitator } = await start()
    const unpaid = await requestUnpaid(baseUrl, REQUEST)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(baseUrl, REQUEST, signature)

    expect(paid.status).toBe(200)
    expect(paid.body).toEqual({ signal: 'SHORT', confidence: 0.9, reason: SLOPPY_REASON })
    expect(paid.headers.get(X402_HEADERS.response)).toBeTruthy()
    expect(facilitator.settleCalls).toBe(1)
  })

  it('answers 400 for a body the research input schema refuses', async () => {
    const { baseUrl, facilitator } = await start()
    const unpaid = await requestUnpaid(baseUrl, REQUEST)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(baseUrl, { symbol: 'BNBUSDT' }, signature)

    expect(paid.status).toBe(400)
    expect(paid.body).toMatchObject({ error: { code: 'validation_failed' } })
    expect(facilitator.settleCalls).toBe(0)
  })

  it('answers /health and /schema', async () => {
    const { baseUrl } = await start()
    const health = await fetch(`${baseUrl}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok', type: 'research', price: '0.03' })

    const schema = await (await fetch(`${baseUrl}/schema`)).json()
    expect(schema).toMatchObject({ type: 'research', payment: { amount: '30000' } })
  })
})
