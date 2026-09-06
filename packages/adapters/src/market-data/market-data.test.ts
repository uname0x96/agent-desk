import { describe, expect, it } from 'vitest'
import {
  MARKET_DATA_BASE_URL,
  MarketDataError,
  compareDecimal,
  createMarketData,
  trimDecimal,
  windowHigh,
  windowLow,
} from './index.ts'

/**
 * The response bodies below were copied from live `data-api.binance.vision`
 * answers, then trimmed to the fields this adapter reads. Nothing in this file
 * touches the network: the point is the mapping and the failure behaviour, not
 * that Binance is reachable.
 */

const TICKER_PRICE = { symbol: 'BNBUSDT', price: '760.05000000' }

const TICKER_24H = {
  symbol: 'BNBUSDT',
  priceChange: '-9.14000000',
  priceChangePercent: '-1.188',
  weightedAvgPrice: '763.42910182',
  prevClosePrice: '769.19000000',
  lastPrice: '760.05000000',
  lastQty: '0.02100000',
  bidPrice: '760.04000000',
  askPrice: '760.05000000',
  openPrice: '769.19000000',
  highPrice: '772.00000000',
  lowPrice: '752.31000000',
  volume: '431862.19100000',
  quoteVolume: '329696314.85350000',
  openTime: 1_757_050_800_000,
  closeTime: 1_757_137_249_137,
  firstId: 1,
  lastId: 2,
  count: 2,
}

const KLINE_ROW = [
  1_757_137_200_000,
  '760.11000000',
  '760.30000000',
  '759.80000000',
  '760.05000000',
  '128.44000000',
  1_757_137_259_999,
  '97640.12000000',
  312,
  '60.11000000',
  '45700.00000000',
  '0',
]

interface Call {
  url: string
  init: RequestInit | undefined
}

/** A fetch that answers from a queue and records what it was asked for. */
function stubFetch(responses: { status?: number; body: unknown }[]) {
  const calls: Call[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const next = responses.shift()
    if (!next) throw new Error(`no stub response left for ${String(input)}`)
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      json: async () => next.body,
    } as Response
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const market = (responses: { status?: number; body: unknown }[]) => {
  const { fetch, calls } = stubFetch(responses)
  return { api: createMarketData({ fetch }), calls }
}

describe('lastPrice', () => {
  it('reads the production endpoint and trims the padding', async () => {
    const { api, calls } = market([{ body: TICKER_PRICE }])

    expect(await api.lastPrice('BNBUSDT')).toBe('760.05')
    expect(calls[0]?.url).toBe(`${MARKET_DATA_BASE_URL}/api/v3/ticker/price?symbol=BNBUSDT`)
  })

  it('carries no credentials, because the endpoint takes none', async () => {
    const { api, calls } = market([{ body: TICKER_PRICE }])
    await api.lastPrice('BNBUSDT')

    expect(calls[0]?.init?.headers).toEqual({ accept: 'application/json' })
    expect(JSON.stringify(calls[0]?.init ?? {})).not.toMatch(/key|secret|signature/i)
  })

  it('fails a read whose body has no price', async () => {
    const { api } = market([{ body: { symbol: 'BNBUSDT' } }])
    await expect(api.lastPrice('BNBUSDT')).rejects.toThrow('carried no price')
  })

  it('fails with the status for an unknown symbol', async () => {
    const { api } = market([{ status: 400, body: { code: -1121, msg: 'Invalid symbol.' } }])
    await expect(api.lastPrice('NOPEUSDT')).rejects.toMatchObject({
      name: 'MarketDataError',
      status: 400,
    })
  })

  it('fails a read the network refused', async () => {
    const fetch = (async () => {
      throw new Error('fetch failed')
    }) as unknown as typeof globalThis.fetch
    await expect(createMarketData({ fetch }).lastPrice('BNBUSDT')).rejects.toThrow(MarketDataError)
  })
})

describe('ticker24h', () => {
  it('maps the seven fields AD-9 and FR-33 read', async () => {
    const { api, calls } = market([{ body: TICKER_24H }])

    expect(await api.ticker24h('BNBUSDT')).toEqual({
      symbol: 'BNBUSDT',
      lastPrice: '760.05',
      change24hPct: -1.188,
      highPrice: '772',
      lowPrice: '752.31',
      volume: '431862.191',
      closeTime: 1_757_137_249_137,
    })
    expect(calls[0]?.url).toContain('/api/v3/ticker/24hr?symbol=BNBUSDT')
  })

  it('refuses a body whose closeTime is not a number', async () => {
    const { api } = market([{ body: { ...TICKER_24H, closeTime: '1757137249137' } }])
    await expect(api.ticker24h('BNBUSDT')).rejects.toThrow('closeTime is not a number')
  })
})

describe('klines', () => {
  it('reads the positional array into named fields', async () => {
    const { api, calls } = market([{ body: [KLINE_ROW] }])

    const [kline] = await api.klines({ symbol: 'BNBUSDT', interval: '1m', limit: 1 })

    expect(kline).toEqual({
      openTime: 1_757_137_200_000,
      open: '760.11',
      high: '760.3',
      low: '759.8',
      close: '760.05',
      volume: '128.44',
      closeTime: 1_757_137_259_999,
    })
    const url = calls[0]?.url ?? ''
    expect(url).toContain('interval=1m')
    expect(url).toContain('limit=1')
    // Absent bounds are absent from the query, not sent as "undefined".
    expect(url).not.toContain('startTime')
  })

  it('passes the window bounds through when they are given', async () => {
    const { api, calls } = market([{ body: [] }])
    await api.klines({ symbol: 'BNBUSDT', interval: '1s', startTime: 1_000, endTime: 2_000 })
    expect(calls[0]?.url).toContain('startTime=1000&endTime=2000')
  })

  it('refuses a row that is not a kline', async () => {
    const { api } = market([{ body: [[1, '2']] }])
    await expect(api.klines({ symbol: 'BNBUSDT', interval: '1m' })).rejects.toThrow('7+ element array')
  })

  it('refuses a body that is not an array', async () => {
    const { api } = market([{ body: { code: -1121 } }])
    await expect(api.klines({ symbol: 'BNBUSDT', interval: '1m' })).rejects.toThrow('did not answer an array')
  })
})

describe('trimDecimal', () => {
  it('strips trailing zeros without changing the value', () => {
    expect(trimDecimal('760.05000000')).toBe('760.05')
    expect(trimDecimal('772.00000000')).toBe('772')
    expect(trimDecimal('0.00000000')).toBe('0')
    expect(trimDecimal('0.00000001')).toBe('0.00000001')
    expect(trimDecimal('100')).toBe('100')
  })

  it('refuses anything that is not a decimal amount', () => {
    for (const bad of ['-1.5', '1e5', 'NaN', '', '1.2.3']) {
      expect(() => trimDecimal(bad)).toThrow(MarketDataError)
    }
  })
})

describe('window extremes and comparison', () => {
  const klines = [
    { openTime: 1, open: '1', high: '772', low: '752.31', close: '1', volume: '1', closeTime: 2 },
    { openTime: 3, open: '1', high: '780.5', low: '760', close: '1', volume: '1', closeTime: 4 },
    { openTime: 5, open: '1', high: '761', low: '750.9', close: '1', volume: '1', closeTime: 6 },
  ]

  it('finds the low and the high of the window', () => {
    expect(windowLow(klines)).toBe('750.9')
    expect(windowHigh(klines)).toBe('780.5')
  })

  it('answers null for an empty window, which AD-9 leaves unscored', () => {
    expect(windowLow([])).toBeNull()
    expect(windowHigh([])).toBeNull()
  })

  it('compares decimals of different widths without a float', () => {
    expect(compareDecimal('760.05', '760.050')).toBe(0)
    expect(compareDecimal('760.1', '760.05')).toBe(1)
    expect(compareDecimal('9.9', '10')).toBe(-1)
    // The pair a float gets wrong: 0.1 + 0.2 !== 0.3 in IEEE 754.
    expect(compareDecimal('0.30000000000000004', '0.3')).toBe(1)
  })
})
