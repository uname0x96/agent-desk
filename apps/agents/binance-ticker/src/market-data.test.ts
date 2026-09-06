import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MARKET_DATA_URL,
  fetchTicker24h,
  MarketDataError,
  MARKET_DATA_TIMEOUT_MS,
} from './market-data.ts'

/** Opt in with AGENT_LIVE_MARKET_DATA=1; the suite stays offline by default. */
const live = process.env.AGENT_LIVE_MARKET_DATA === '1'

describe('fetchTicker24h', () => {
  it('keeps the external deadline at the AD-7 ceiling of 8 s', () => {
    expect(MARKET_DATA_TIMEOUT_MS).toBeLessThanOrEqual(8_000)
  })

  it('reports an unreadable error body by status', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 502 })) as never
    await expect(fetchTicker24h('BNBUSDT', { fetchImpl })).rejects.toThrow(
      'market data answered 502',
    )
  })

  it('passes a non-code error message through', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: -1003, msg: 'Too many requests.' }), { status: 429 }),
    ) as never
    await expect(fetchTicker24h('BNBUSDT', { fetchImpl })).rejects.toThrow('Too many requests.')
  })

  it('wraps a transport failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as never
    const error = await fetchTicker24h('BNBUSDT', { fetchImpl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MarketDataError)
    expect((error as MarketDataError).message).toContain('market data is unreachable')
  })

  it('rejects a response that is not a ticker object', async () => {
    const nulled = vi.fn(async () => new Response('null', { status: 200 })) as never
    await expect(fetchTicker24h('BNBUSDT', { fetchImpl: nulled })).rejects.toThrow('non-object')

    const wrongShape = vi.fn(async () => new Response('[]', { status: 200 })) as never
    await expect(fetchTicker24h('BNBUSDT', { fetchImpl: wrongShape })).rejects.toThrow(
      'market data is missing symbol',
    )
  })

  it.skipIf(!live)('reads the live 24 h ticker from data-api.binance.vision', async () => {
    const ticker = await fetchTicker24h('BNBUSDT', { baseUrl: DEFAULT_MARKET_DATA_URL })
    expect(ticker.symbol).toBe('BNBUSDT')
    expect(ticker.lastPrice).toMatch(/^\d+(\.\d+)?$/)
    expect(ticker.highPrice).toMatch(/^\d+(\.\d+)?$/)
    expect(ticker.closeTime).toBeGreaterThan(0)
  }, 15_000)

  it.skipIf(!live)('answers an unknown symbol with an error', async () => {
    await expect(
      fetchTicker24h('NOTASYMBOL', { baseUrl: DEFAULT_MARKET_DATA_URL }),
    ).rejects.toThrow('unknown symbol NOTASYMBOL')
  }, 15_000)
})
