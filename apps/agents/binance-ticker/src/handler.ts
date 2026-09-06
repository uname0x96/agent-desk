import type { AgentHandler } from '@agent-desk/agent-kit'
import type { DataOutput } from '@agent-desk/schemas'
import { fetchTicker24h, type MarketDataOptions, MarketDataError } from './market-data.ts'

/**
 * FR-44, Binance Ticker: the `data` Type over the public 24 h ticker.
 * `volatility_24h_pct` is (high - low) / low in percent (PRD addendum §1).
 */

/** Enough precision for the risk agent's 3 % and 6 % thresholds, without float noise. */
const PERCENT_DECIMALS = 4

function round(value: number): number {
  const factor = 10 ** PERCENT_DECIMALS
  return Math.round(value * factor) / factor
}

export function volatility24hPct(highPrice: string, lowPrice: string): number {
  const high = Number(highPrice)
  const low = Number(lowPrice)
  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    throw new MarketDataError(`market data has a non-numeric range: ${highPrice}/${lowPrice}`)
  }
  if (low <= 0) {
    throw new MarketDataError(`market data has a non-positive 24 h low: ${lowPrice}`)
  }
  // The output schema refuses a negative volatility; a feed with high < low is
  // a bad feed, not a negative number to pass on.
  return round(Math.max(0, ((high - low) / low) * 100))
}

/** "612.40000000" -> "612.40" is still a decimal string; the trailing zeros are noise. */
export function normalizeDecimal(value: string): string {
  if (!value.includes('.')) return value
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '')
  return trimmed === '' ? '0' : trimmed
}

export function changePct(priceChangePercent: string): number {
  const change = Number(priceChangePercent)
  if (!Number.isFinite(change)) {
    throw new MarketDataError(`market data has a non-numeric change: ${priceChangePercent}`)
  }
  return round(change)
}

export function createTickerHandler(options: MarketDataOptions = {}): AgentHandler<'data'> {
  return async (input, context): Promise<DataOutput> => {
    const ticker = await fetchTicker24h(input.symbol, { ...options, signal: context.signal })
    return {
      symbol: ticker.symbol,
      price: normalizeDecimal(ticker.lastPrice),
      change_24h_pct: changePct(ticker.priceChangePercent),
      volatility_24h_pct: volatility24hPct(ticker.highPrice, ticker.lowPrice),
      ts: new Date(ticker.closeTime).toISOString(),
    }
  }
}
