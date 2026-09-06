/**
 * The 24 h ticker from Binance's public market-data host. No key, no vendor
 * SDK: one `fetch` against `MARKET_DATA_URL` (AD-1 keeps the agent's
 * dependencies to `@agent-desk/schemas`, `@agent-desk/agent-kit` and whatever
 * this agent itself needs).
 */

/** AD-7: handlers keep external timeouts at or below 8 s. */
export const MARKET_DATA_TIMEOUT_MS = 8_000

export const DEFAULT_MARKET_DATA_URL = 'https://data-api.binance.vision'

export interface Ticker24h {
  symbol: string
  lastPrice: string
  priceChangePercent: string
  highPrice: string
  lowPrice: string
  /** Window end, epoch milliseconds. */
  closeTime: number
}

export interface MarketDataOptions {
  baseUrl?: string
  timeoutMs?: number
  /** The handler budget signal; the market-data deadline is combined with it. */
  signal?: AbortSignal
  fetchImpl?: typeof globalThis.fetch
}

export class MarketDataError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'MarketDataError'
    this.status = status
  }
}

const REQUIRED_STRINGS = [
  'symbol',
  'lastPrice',
  'priceChangePercent',
  'highPrice',
  'lowPrice',
] as const

function readTicker(payload: unknown): Ticker24h {
  if (typeof payload !== 'object' || payload === null) {
    throw new MarketDataError('market data returned a non-object response')
  }
  const raw = payload as Record<string, unknown>
  for (const field of REQUIRED_STRINGS) {
    if (typeof raw[field] !== 'string' || raw[field] === '') {
      throw new MarketDataError(`market data is missing ${field}`)
    }
  }
  if (typeof raw.closeTime !== 'number' || !Number.isFinite(raw.closeTime)) {
    throw new MarketDataError('market data is missing closeTime')
  }
  return {
    symbol: raw.symbol as string,
    lastPrice: raw.lastPrice as string,
    priceChangePercent: raw.priceChangePercent as string,
    highPrice: raw.highPrice as string,
    lowPrice: raw.lowPrice as string,
    closeTime: raw.closeTime,
  }
}

async function readErrorMessage(response: Response, symbol: string): Promise<string> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return `market data answered ${response.status}`
  }
  const error = body as { code?: number; msg?: string }
  // -1121 is Binance's "Invalid symbol"; the acceptance criteria call it out.
  if (error.code === -1121) return `unknown symbol ${symbol}`
  return `market data answered ${response.status}: ${error.msg ?? 'unknown error'}`
}

export async function fetchTicker24h(
  symbol: string,
  options: MarketDataOptions = {},
): Promise<Ticker24h> {
  const baseUrl = options.baseUrl ?? DEFAULT_MARKET_DATA_URL
  const timeoutMs = options.timeoutMs ?? MARKET_DATA_TIMEOUT_MS
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`

  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline

  let response: Response
  try {
    response = await doFetch(url, { signal, headers: { accept: 'application/json' } })
  } catch (error) {
    if (deadline.aborted) {
      throw new MarketDataError(`market data timed out after ${timeoutMs} ms`)
    }
    if (options.signal?.aborted) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new MarketDataError(`market data is unreachable: ${reason}`)
  }

  if (!response.ok) {
    throw new MarketDataError(await readErrorMessage(response, symbol), response.status)
  }
  return readTicker(await response.json())
}
