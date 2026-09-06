import type { RunResponse } from '@agent-desk/schemas'

/**
 * A Run as `GET /api/runs/<id>` will return it once Story 1.8 lands the route.
 * Test-only: nothing in `app/` imports this. It exists so the polling test and
 * the shape test have a body that actually satisfies `runResponse`.
 */

const DATA_PAY_TO = '0x1e4a2f7d3c9b60518a7d3f2c4b8e91d0a6c73f52'
const RESEARCH_PAY_TO = '0x8b21c6d4e70f9a3b52c1d8e46f70a9b3c25d18e4'
const RISK_PAY_TO = '0x3f70b9c2d81e46a05b7c93d2e18f4a60c5b72d93'
const WALLET = '0xa71c3d90e5b28f4607c93d1a2b85e04f7d16c982'
const ASSET = '0x0000000000000000000000000000000000000000'

export const runningRunFixture: RunResponse = {
  id: 'run_01K4RWZ8QY7M3B0P5X2A9TGCVD',
  workflow_id: 'wf_01K4RWZ0N3F8H2S6C1E7YQAB4M',
  workflow_name: 'BNB momentum desk',
  symbol: 'BNBUSDT',
  status: 'running',
  failure_reason: null,
  wallet_address: WALLET,
  total_cost: '10000',
  created_at: '2026-09-05T02:00:00Z',
  started_at: '2026-09-05T02:00:01Z',
  ended_at: null,
  price_lock: {
    locked_at: '2026-09-05T02:00:00Z',
    total: '45000',
    nodes: [
      {
        node_index: 0,
        node_type: 'data',
        listing_id: 'lst_01K4RWY1S8D3G7J2M5P9V0BXQZ',
        provider: 'Binance Ticker',
        price: '10000',
        asset: ASSET,
        network: 'eip155:97',
        pay_to: DATA_PAY_TO,
      },
      {
        node_index: 1,
        node_type: 'research',
        listing_id: 'lst_01K4RWY4T1B6N9C3F8H2J5MDRX',
        provider: 'Claude Analyst',
        price: '25000',
        asset: ASSET,
        network: 'eip155:97',
        pay_to: RESEARCH_PAY_TO,
      },
      {
        node_index: 2,
        node_type: 'risk',
        listing_id: 'lst_01K4RWY7V4E9Q2Z5B8D1G3KFNS',
        provider: 'Volatility Guard',
        price: '10000',
        asset: ASSET,
        network: 'eip155:97',
        pay_to: RISK_PAY_TO,
      },
    ],
  },
  calls: [
    {
      id: 'call_01K4RWZ9C2M5T8W1Y4B7E0HJQN',
      kind: 'run',
      node_index: 0,
      node_type: 'data',
      listing_id: 'lst_01K4RWY1S8D3G7J2M5P9V0BXQZ',
      provider: 'Binance Ticker',
      status: 'succeeded',
      locked_price: '10000',
      locked_pay_to: DATA_PAY_TO,
      locked_asset: ASSET,
      locked_network: 'eip155:97',
      request: { symbol: 'BNBUSDT' },
      response: {
        symbol: 'BNBUSDT',
        price: '612.40',
        change_24h_pct: -1.8,
        volatility_24h_pct: 3.2,
        ts: '2026-09-05T02:00:03Z',
      },
      payment_required: null,
      payment_tx_hash: '0x2c4e8a1b90d7f36524ab8c0e91d5f7b23604ae8c19d2f5063b7a41c8e0d926f3',
      attempt: 1,
      reference_price: '612.40',
      reference_at: '2026-09-05T02:00:04Z',
      failure_reason: null,
      skip_reason: null,
      started_at: '2026-09-05T02:00:01Z',
      ended_at: '2026-09-05T02:00:04Z',
      settlement: null,
    },
    {
      id: 'call_01K4RWZB5E8H1K4N7Q0T3W6ZCX',
      kind: 'run',
      node_index: 1,
      node_type: 'research',
      listing_id: 'lst_01K4RWY4T1B6N9C3F8H2J5MDRX',
      provider: 'Claude Analyst',
      status: 'paid_awaiting_result',
      locked_price: '25000',
      locked_pay_to: RESEARCH_PAY_TO,
      locked_asset: ASSET,
      locked_network: 'eip155:97',
      request: {
        symbol: 'BNBUSDT',
        market: {
          symbol: 'BNBUSDT',
          price: '612.40',
          change_24h_pct: -1.8,
          volatility_24h_pct: 3.2,
          ts: '2026-09-05T02:00:03Z',
        },
      },
      response: null,
      payment_required: null,
      payment_tx_hash: null,
      attempt: 1,
      reference_price: null,
      reference_at: null,
      failure_reason: null,
      skip_reason: null,
      started_at: '2026-09-05T02:00:04Z',
      ended_at: null,
      settlement: null,
    },
    {
      id: 'call_01K4RWZD8G1K4N7Q0T3W6Z9CXB',
      kind: 'run',
      node_index: 2,
      node_type: 'risk',
      listing_id: 'lst_01K4RWY7V4E9Q2Z5B8D1G3KFNS',
      provider: 'Volatility Guard',
      status: 'pending',
      locked_price: '10000',
      locked_pay_to: RISK_PAY_TO,
      locked_asset: ASSET,
      locked_network: 'eip155:97',
      request: null,
      response: null,
      payment_required: null,
      payment_tx_hash: null,
      attempt: 0,
      reference_price: null,
      reference_at: null,
      failure_reason: null,
      skip_reason: null,
      started_at: null,
      ended_at: null,
      settlement: null,
    },
  ],
}

/** The same Run once the engine has finished with it. */
export const completedRunFixture: RunResponse = {
  ...runningRunFixture,
  status: 'completed',
  total_cost: '45000',
  ended_at: '2026-09-05T02:00:11Z',
  calls: runningRunFixture.calls.map((call) =>
    call.status === 'succeeded'
      ? call
      : {
          ...call,
          status: 'succeeded' as const,
          attempt: 1,
          payment_tx_hash: '0x71d3b0c95e2a846f10c7b3d925e08a4f6c1b23d70985ea3f4c6b17d0928e35af',
          started_at: call.started_at ?? '2026-09-05T02:00:05Z',
          ended_at: '2026-09-05T02:00:10Z',
        },
  ),
}
