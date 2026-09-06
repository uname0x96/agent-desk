import type { AgentType } from './types/index.ts'

/**
 * The sample input the platform sends on the FR-11 verification Call, and the
 * payloads the public schema page prints. Shared so the engine, the agents,
 * and the schema page never drift.
 */
export const samples = {
  data: { symbol: 'BNBUSDT' },
  research: {
    symbol: 'BNBUSDT',
    market: {
      symbol: 'BNBUSDT',
      price: '612.40',
      change_24h_pct: -1.8,
      volatility_24h_pct: 3.2,
      ts: '2026-09-05T02:00:00Z',
    },
  },
  risk: {
    symbol: 'BNBUSDT',
    signal: 'LONG',
    confidence: 0.72,
    proposed_size_usdt: '100',
    balance_usdt: '950.00',
    market: {
      symbol: 'BNBUSDT',
      price: '612.40',
      change_24h_pct: -1.8,
      volatility_24h_pct: 3.2,
      ts: '2026-09-05T02:00:00Z',
    },
  },
  execution: { symbol: 'BNBUSDT', side: 'BUY', size_usdt: '60' },
  notify: {
    run_id: null,
    recipient: { channel: 'telegram', address: '000000000' },
    summary: 'AgentDesk listing verification call.',
    cost_table: [],
    tx_hashes: [],
  },
} as const satisfies Record<AgentType, unknown>

export const sampleOutputs = {
  data: {
    symbol: 'BNBUSDT',
    price: '612.40',
    change_24h_pct: -1.8,
    volatility_24h_pct: 3.2,
    ts: '2026-09-05T02:00:00Z',
  },
  research: {
    signal: 'LONG',
    confidence: 0.72,
    reason: 'Price reclaimed the 24h midpoint on rising volume.',
  },
  risk: { decision: 'REDUCE', size_usdt: '60', reason: '24h volatility above 3%.' },
  execution: {
    status: 'FILLED',
    order_id: '123456789',
    filled_price: '612.55',
    filled_qty: '0.0979',
    ts: '2026-09-05T02:00:07Z',
  },
  notify: { delivered: true, channel: 'telegram', message_ref: '4521' },
} as const satisfies Record<AgentType, unknown>
