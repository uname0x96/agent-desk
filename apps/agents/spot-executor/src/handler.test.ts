import { describe, expect, it, vi } from 'vitest'
import type { AgentHandlerContext } from '@agent-desk/agent-kit'
import { validateOutput, type ExecutionInput, type InternalSettings } from '@agent-desk/schemas'
import {
  createExecutionHandler,
  REASON_ABOVE_CEILING,
  REASON_EMERGENCY_STOP,
  REASON_SETTINGS_UNAVAILABLE,
} from './handler.ts'
import { ExchangeRejectionError, ExchangeUnavailableError, type Exchange } from './exchange.ts'
import { SettingsUnavailableError, type SettingsSource } from './settings.ts'

/**
 * Every path of the paid request, against a mocked `Exchange`. No Spot Testnet
 * credentials exist, so nothing here reaches an exchange; what it does check is
 * that each answer is a schema-valid `execution` output by running the real
 * `validateOutput` over it, which is exactly what `createAgent` does before
 * answering 200.
 */

const NOW = new Date('2026-09-06T10:15:00.000Z')
const INPUT: ExecutionInput = { symbol: 'BNBUSDT', side: 'BUY', size_usdt: '6' }
const OPEN: InternalSettings = { emergency_stop: false, order_ceiling_usdt: '1000' }

const FILL = {
  orderId: '6789012',
  status: 'FILLED',
  executedQty: '0.00788',
  cumulativeQuoteQty: '5.9999952',
  transactTime: 1788674230047,
  raw: { symbol: 'BNBUSDT' },
}

function context(): AgentHandlerContext {
  return {
    signal: new AbortController().signal,
    logger: { info() {}, warn() {}, error() {} } as never,
    paymentSignature: null,
  }
}

function exchange(overrides: Partial<Exchange> = {}): Exchange {
  return {
    placeMarketOrder: () => Promise.resolve(FILL),
    getOrder: () => Promise.resolve({ orderId: FILL.orderId, raw: FILL.raw }),
    getBalance: () => Promise.resolve({ balanceUsdt: '9412.51' }),
    ...overrides,
  }
}

function settingsOf(settings: InternalSettings): SettingsSource {
  return () => Promise.resolve(settings)
}

async function run(options: { exchange?: Exchange; settings?: SettingsSource; input?: ExecutionInput }) {
  const handler = createExecutionHandler({
    exchange: options.exchange ?? exchange(),
    settings: options.settings ?? settingsOf(OPEN),
    now: () => NOW,
  })
  const input = options.input ?? INPUT
  const output = await handler(input, context())
  // The kit refuses to answer 200 with an output this rejects.
  expect(validateOutput('execution', input, output).ok).toBe(true)
  return output
}

describe('the three refusals, each a paid schema-valid 200', () => {
  it('refuses on emergency stop without touching the exchange', async () => {
    const placeMarketOrder = vi.fn(() => Promise.resolve(FILL))
    const output = await run({
      exchange: exchange({ placeMarketOrder }),
      settings: settingsOf({ emergency_stop: true, order_ceiling_usdt: '1000' }),
    })

    expect(output).toEqual({
      status: 'REJECTED',
      reason: REASON_EMERGENCY_STOP,
      ts: NOW.toISOString(),
    })
    expect(placeMarketOrder).not.toHaveBeenCalled()
  })

  it('refuses above the platform order ceiling', async () => {
    const placeMarketOrder = vi.fn(() => Promise.resolve(FILL))
    const output = await run({
      exchange: exchange({ placeMarketOrder }),
      settings: settingsOf({ emergency_stop: false, order_ceiling_usdt: '1000' }),
      input: { symbol: 'BNBUSDT', side: 'BUY', size_usdt: '1000.01' },
    })

    expect(output).toMatchObject({ status: 'REJECTED', reason: REASON_ABOVE_CEILING })
    expect(placeMarketOrder).not.toHaveBeenCalled()
  })

  it('places an order exactly at the ceiling', async () => {
    const output = await run({
      settings: settingsOf({ emergency_stop: false, order_ceiling_usdt: '1000' }),
      input: { symbol: 'BNBUSDT', side: 'BUY', size_usdt: '1000' },
    })
    expect(output.status).toBe('FILLED')
  })

  it('refuses when the settings call fails', async () => {
    const placeMarketOrder = vi.fn(() => Promise.resolve(FILL))
    const output = await run({
      exchange: exchange({ placeMarketOrder }),
      settings: () => Promise.reject(new SettingsUnavailableError('platform settings answered 500')),
    })

    expect(output).toMatchObject({ status: 'REJECTED', reason: REASON_SETTINGS_UNAVAILABLE })
    expect(placeMarketOrder).not.toHaveBeenCalled()
  })

  it('checks emergency stop before the ceiling', async () => {
    const output = await run({
      settings: settingsOf({ emergency_stop: true, order_ceiling_usdt: '10' }),
      input: { symbol: 'BNBUSDT', side: 'BUY', size_usdt: '500' },
    })
    expect(output).toMatchObject({ reason: REASON_EMERGENCY_STOP })
  })
})

describe('a filled order', () => {
  it('answers the fill with the price as cumulative quote over executed quantity', async () => {
    const placeMarketOrder = vi.fn(() => Promise.resolve(FILL))
    const output = await run({ exchange: exchange({ placeMarketOrder }) })

    expect(placeMarketOrder).toHaveBeenCalledWith({
      symbol: 'BNBUSDT',
      side: 'BUY',
      quoteQty: '6',
    })
    expect(output).toEqual({
      status: 'FILLED',
      order_id: '6789012',
      filled_price: '761.42071066',
      filled_qty: '0.00788',
      ts: new Date(FILL.transactTime).toISOString(),
    })
  })

  it('falls back to the handler clock when the exchange sends no transactTime', async () => {
    const output = await run({
      exchange: exchange({
        placeMarketOrder: () => Promise.resolve({ ...FILL, transactTime: null }),
      }),
    })
    expect(output.ts).toBe(NOW.toISOString())
  })

  it('passes SELL through as SELL', async () => {
    const placeMarketOrder = vi.fn(() => Promise.resolve(FILL))
    await run({
      exchange: exchange({ placeMarketOrder }),
      input: { symbol: 'BNBUSDT', side: 'SELL', size_usdt: '6' },
    })
    expect(placeMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL' }))
  })
})

describe('an exchange refusal', () => {
  it('answers REJECTED with the exchange message when the notional is too small', async () => {
    const output = await run({
      exchange: exchange({
        placeMarketOrder: () =>
          Promise.reject(new ExchangeRejectionError('Filter failure: NOTIONAL', -1013)),
      }),
    })
    expect(output).toEqual({
      status: 'REJECTED',
      reason: 'Filter failure: NOTIONAL',
      ts: NOW.toISOString(),
    })
  })

  it('answers REJECTED with the exchange message on insufficient balance', async () => {
    const output = await run({
      exchange: exchange({
        placeMarketOrder: () =>
          Promise.reject(new ExchangeRejectionError('Account has insufficient balance for requested action.', -2010)),
      }),
    })
    expect(output).toMatchObject({
      status: 'REJECTED',
      reason: 'Account has insufficient balance for requested action.',
    })
  })

  it('answers REJECTED rather than dividing by zero when the order did not fill', async () => {
    const output = await run({
      exchange: exchange({
        placeMarketOrder: () =>
          Promise.resolve({
            ...FILL,
            status: 'EXPIRED',
            executedQty: '0',
            cumulativeQuoteQty: '0',
          }),
      }),
    })
    expect(output).toMatchObject({ status: 'REJECTED', reason: 'order EXPIRED with no fill' })
  })

  it('does not claim REJECTED when the exchange never answered', async () => {
    // Binance documents a 5xx as "execution status UNKNOWN", so the order may
    // have reached the book. The kit turns this into a 500 and the payment
    // never settles, which is the only honest outcome.
    const handler = createExecutionHandler({
      exchange: exchange({
        placeMarketOrder: () =>
          Promise.reject(new ExchangeUnavailableError('exchange newOrder failed: Server error: 503')),
      }),
      settings: settingsOf(OPEN),
      now: () => NOW,
    })
    await expect(handler(INPUT, context())).rejects.toBeInstanceOf(ExchangeUnavailableError)
  })

  it('lets a handler budget expiry through rather than answering a refusal', async () => {
    const handler = createExecutionHandler({
      exchange: exchange(),
      settings: () => Promise.reject(new Error('The operation was aborted')),
      now: () => NOW,
    })
    await expect(handler(INPUT, context())).rejects.toThrow('The operation was aborted')
  })
})
