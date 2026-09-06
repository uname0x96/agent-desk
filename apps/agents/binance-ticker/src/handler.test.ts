import { describe, expect, it, vi } from 'vitest'
import { validateOutput } from '@agent-desk/schemas'
import type { AgentHandlerContext } from '@agent-desk/agent-kit'
import { changePct, createTickerHandler, normalizeDecimal, volatility24hPct } from './handler.ts'
import { MarketDataError } from './market-data.ts'

const TICKER = {
  symbol: 'BNBUSDT',
  priceChange: '38.50000000',
  priceChangePercent: '5.327',
  lastPrice: '761.27000000',
  openPrice: '722.77000000',
  highPrice: '780.64000000',
  lowPrice: '721.56000000',
  volume: '360664.75900000',
  quoteVolume: '273658549.23192000',
  openTime: 1788587830047,
  closeTime: 1788674230047,
}

function context(signal: AbortSignal = new AbortController().signal): AgentHandlerContext {
  return { signal, paymentSignature: null, logger: { info() {}, warn() {}, error() {} } as never }
}

function stubFetch(body: unknown, init: { status?: number } = {}) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof globalThis.fetch
}

describe('volatility24hPct', () => {
  it('is (high - low) / low in percent', () => {
    // (120 - 100) / 100 * 100
    expect(volatility24hPct('120', '100')).toBe(20)
    // The live BNBUSDT window used above.
    expect(volatility24hPct('780.64000000', '721.56000000')).toBeCloseTo(8.1878, 4)
  })

  it('is zero for a flat window', () => {
    expect(volatility24hPct('100', '100')).toBe(0)
  })

  it('never goes negative', () => {
    expect(volatility24hPct('90', '100')).toBe(0)
  })

  it('refuses a non-positive low or a non-numeric range', () => {
    expect(() => volatility24hPct('100', '0')).toThrow(MarketDataError)
    expect(() => volatility24hPct('abc', '100')).toThrow(MarketDataError)
  })
})

describe('normalizeDecimal and changePct', () => {
  it('drops the padding zeros Binance sends', () => {
    expect(normalizeDecimal('761.27000000')).toBe('761.27')
    expect(normalizeDecimal('700.00000000')).toBe('700')
    expect(normalizeDecimal('612')).toBe('612')
  })

  it('reads a signed percent', () => {
    expect(changePct('5.327')).toBe(5.327)
    expect(changePct('-1.8')).toBe(-1.8)
    expect(() => changePct('n/a')).toThrow(MarketDataError)
  })
})

describe('createTickerHandler', () => {
  it('answers a schema-valid data output for the live response shape', async () => {
    const fetchImpl = stubFetch(TICKER)
    const handler = createTickerHandler({ fetchImpl, baseUrl: 'https://market.test' })

    const output = await handler({ symbol: 'BNBUSDT' }, context())

    expect(output).toEqual({
      symbol: 'BNBUSDT',
      price: '761.27',
      change_24h_pct: 5.327,
      volatility_24h_pct: 8.1878,
      ts: new Date(TICKER.closeTime).toISOString(),
    })
    expect(validateOutput('data', { symbol: 'BNBUSDT' }, output).ok).toBe(true)
  })

  it('asks the configured host for the requested symbol', async () => {
    const fetchImpl = stubFetch(TICKER)
    const handler = createTickerHandler({ fetchImpl, baseUrl: 'https://market.test/' })
    await handler({ symbol: 'BNBUSDT' }, context())
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(
      'https://market.test/api/v3/ticker/24hr?symbol=BNBUSDT',
    )
  })

  it('fails on an unknown symbol', async () => {
    const fetchImpl = stubFetch({ code: -1121, msg: 'Invalid symbol.' }, { status: 400 })
    const handler = createTickerHandler({ fetchImpl })
    await expect(handler({ symbol: 'NOTASYMBOL' }, context())).rejects.toThrow(
      'unknown symbol NOTASYMBOL',
    )
  })

  it('fails when market data does not answer within the timeout', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as unknown as typeof globalThis.fetch
    const handler = createTickerHandler({ fetchImpl, timeoutMs: 40 })

    await expect(handler({ symbol: 'BNBUSDT' }, context())).rejects.toThrow(
      'market data timed out after 40 ms',
    )
  })

  it('unwinds when the handler budget aborts first', async () => {
    const controller = new AbortController()
    const fetchImpl = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by budget')))
      })) as unknown as typeof globalThis.fetch
    const handler = createTickerHandler({ fetchImpl, timeoutMs: 8_000 })

    const pending = handler({ symbol: 'BNBUSDT' }, context(controller.signal))
    controller.abort()
    await expect(pending).rejects.toThrow('aborted by budget')
  })

  it('rejects a response missing the fields the output needs', async () => {
    const fetchImpl = stubFetch({ symbol: 'BNBUSDT', lastPrice: '1' })
    const handler = createTickerHandler({ fetchImpl })
    await expect(handler({ symbol: 'BNBUSDT' }, context())).rejects.toThrow(
      'market data is missing priceChangePercent',
    )
  })
})
