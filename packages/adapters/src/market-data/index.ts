import type { Kline, KlineRequest, MarketData, Ticker24h } from '@agent-desk/core/ports'

/**
 * AD-9 and PRD addendum §4: Binance production public market data is the only
 * price source a Settlement may name, and it is never the paid `data` Agent and
 * never the Spot Testnet book. `data-api.binance.vision` serves it without a
 * key and without a signature, so this adapter carries no credentials at all.
 *
 * Every amount comes back as a decimal string in USDT (AD-13). Binance pads to
 * eight decimals; the padding is stripped so `"760.05000000"` is stored and
 * rendered as `"760.05"`, which changes no comparison — settlement compares
 * numbers, not strings — and keeps the Run view readable.
 */

export const MARKET_DATA_BASE_URL = 'https://data-api.binance.vision'
/** Conventions: an external read that outlives this is a failed read. */
export const MARKET_DATA_TIMEOUT_MS = 5_000

export interface MarketDataConfig {
  baseUrl?: string
  timeoutMs?: number
  /** Injectable so unit tests never reach the network. */
  fetch?: typeof globalThis.fetch
}

/** A market-data read failed. AD-9 leaves the Call unscored for the next tick. */
export class MarketDataError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'MarketDataError'
    this.status = status
  }
}

export function createMarketData(config: MarketDataConfig = {}): MarketData {
  const baseUrl = (config.baseUrl ?? MARKET_DATA_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = config.timeoutMs ?? MARKET_DATA_TIMEOUT_MS
  const doFetch = config.fetch ?? globalThis.fetch

  async function get(path: string, query: Record<string, string | number | undefined>): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    let response: Response
    try {
      response = await doFetch(url.toString(), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      throw new MarketDataError(`${path} failed: ${(cause as Error).message}`)
    }
    if (!response.ok) {
      // Binance answers 400 with `{ code, msg }` for an unknown symbol and 429
      // when a caller is rate limited; both are read failures to AD-9.
      throw new MarketDataError(`${path} answered ${response.status}`, response.status)
    }
    return response.json()
  }

  return {
    async lastPrice(symbol: string): Promise<string> {
      const body = await get('/api/v3/ticker/price', { symbol })
      const price = (body as { price?: unknown }).price
      if (typeof price !== 'string') {
        throw new MarketDataError(`ticker/price for ${symbol} carried no price`)
      }
      return trimDecimal(price)
    },

    async ticker24h(symbol: string): Promise<Ticker24h> {
      const body = (await get('/api/v3/ticker/24hr', { symbol })) as Record<string, unknown>
      return {
        symbol: expectString(body.symbol, 'symbol'),
        lastPrice: trimDecimal(expectString(body.lastPrice, 'lastPrice')),
        // FR-33's demo rule reads this as a number, so it is parsed once here
        // rather than at every call site.
        change24hPct: Number(expectString(body.priceChangePercent, 'priceChangePercent')),
        highPrice: trimDecimal(expectString(body.highPrice, 'highPrice')),
        lowPrice: trimDecimal(expectString(body.lowPrice, 'lowPrice')),
        volume: trimDecimal(expectString(body.volume, 'volume')),
        closeTime: expectNumber(body.closeTime, 'closeTime'),
      }
    },

    async klines(request: KlineRequest): Promise<Kline[]> {
      const body = await get('/api/v3/klines', {
        symbol: request.symbol,
        interval: request.interval,
        startTime: request.startTime,
        endTime: request.endTime,
        limit: request.limit,
      })
      if (!Array.isArray(body)) throw new MarketDataError('klines did not answer an array')
      return body.map(toKline)
    },
  }
}

/**
 * Binance klines are positional arrays:
 * `[openTime, open, high, low, close, volume, closeTime, ...]`.
 */
function toKline(row: unknown): Kline {
  if (!Array.isArray(row) || row.length < 7) {
    throw new MarketDataError('klines row is not a 7+ element array')
  }
  return {
    openTime: expectNumber(row[0], 'openTime'),
    open: trimDecimal(expectString(row[1], 'open')),
    high: trimDecimal(expectString(row[2], 'high')),
    low: trimDecimal(expectString(row[3], 'low')),
    close: trimDecimal(expectString(row[4], 'close')),
    volume: trimDecimal(expectString(row[5], 'volume')),
    closeTime: expectNumber(row[6], 'closeTime'),
  }
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new MarketDataError(`market data field ${field} is not a string`)
  return value
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MarketDataError(`market data field ${field} is not a number`)
  }
  return value
}

/** `"760.05000000"` -> `"760.05"`, `"0.00000000"` -> `"0"`. Never touches the value. */
export function trimDecimal(value: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new MarketDataError(`market data returned a non-decimal amount: ${value}`)
  }
  if (!value.includes('.')) return String(BigInt(value))
  const [whole = '0', fraction = ''] = value.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  const normalisedWhole = String(BigInt(whole))
  return trimmed === '' ? normalisedWhole : `${normalisedWhole}.${trimmed}`
}

/**
 * AD-9's window min and max for the risk drawdown rule. Kept here, beside the
 * shape it reads, so `packages/core/settlement` never has to know that a kline
 * is an array with a `low` at index three.
 */
export function windowLow(klines: readonly Kline[]): string | null {
  return extreme(klines.map((k) => k.low), (a, b) => compareDecimal(a, b) < 0)
}

export function windowHigh(klines: readonly Kline[]): string | null {
  return extreme(klines.map((k) => k.high), (a, b) => compareDecimal(a, b) > 0)
}

function extreme(values: readonly string[], better: (a: string, b: string) => boolean): string | null {
  let best: string | null = null
  for (const value of values) {
    if (best === null || better(value, best)) best = value
  }
  return best
}

/** Compares two decimal strings without a float, AD-13. */
export function compareDecimal(left: string, right: string): number {
  const scale = (value: string) => {
    const [whole = '0', fraction = ''] = value.split('.')
    return { whole, fraction }
  }
  const a = scale(left)
  const b = scale(right)
  const width = Math.max(a.fraction.length, b.fraction.length)
  const asInt = (parts: { whole: string; fraction: string }) =>
    BigInt(parts.whole + parts.fraction.padEnd(width, '0'))
  const x = asInt(a)
  const y = asInt(b)
  return x === y ? 0 : x < y ? -1 : 1
}
