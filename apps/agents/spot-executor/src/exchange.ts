/**
 * AD-11: the `Exchange` port. It is declared here, in the one agent allowed to
 * reach an exchange at all, and nothing outside `apps/agents/spot-executor`
 * imports it. The handler, the internal routes, the doctor check and the tests
 * all speak this interface; `binance-exchange.ts` is the only implementation
 * that knows `@binance/spot` exists.
 */

export type OrderSide = 'BUY' | 'SELL'

export interface PlaceMarketOrderParams {
  symbol: string
  side: OrderSide
  /** Decimal USDT to spend (BUY) or receive (SELL); becomes `quoteOrderQty`. */
  quoteQty: string
}

/** What the handler needs off a placed order, as decimal strings. */
export interface PlacedOrder {
  orderId: string
  /** The exchange's order status verbatim, e.g. `FILLED`, `EXPIRED`. */
  status: string
  /** Base asset actually bought or sold. */
  executedQty: string
  /** Quote asset actually spent or received. */
  cumulativeQuoteQty: string
  /** Epoch milliseconds the exchange stamped the fill with, when it sent one. */
  transactTime: number | null
  /** The exchange's response, forwarded untouched by `GET /internal/orders/<id>`. */
  raw: unknown
}

export interface FetchedOrder {
  orderId: string
  raw: unknown
}

export interface ExchangeBalance {
  /** Free USDT of the Platform Exchange Account, as a decimal string. */
  balanceUsdt: string
}

export interface Exchange {
  placeMarketOrder(params: PlaceMarketOrderParams): Promise<PlacedOrder>
  getOrder(symbol: string, orderId: string): Promise<FetchedOrder>
  getBalance(): Promise<ExchangeBalance>
}

/**
 * The exchange refused the order: below the minimum notional, insufficient
 * balance, unknown symbol, a bad key. `message` is the exchange's own text,
 * which the handler puts straight into `reason` — a refusal is a paid,
 * schema-valid `REJECTED`, never a 5xx.
 */
export class ExchangeRejectionError extends Error {
  /** Binance's `code`, e.g. -1013 below minimum notional, -2010 insufficient balance. */
  readonly code: number | undefined
  readonly status: number | undefined

  constructor(message: string, code?: number, status?: number) {
    super(message)
    this.name = 'ExchangeRejectionError'
    this.code = code
    this.status = status
  }
}

/**
 * The exchange could not be reached or answered 5xx. Distinct from a refusal:
 * nothing was decided, so the handler reports it as the reason rather than
 * claiming the exchange rejected the order.
 */
export class ExchangeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExchangeUnavailableError'
  }
}

/** Binance's "Order does not exist"; `GET /internal/orders/<id>` answers 404 on it. */
export const ORDER_DOES_NOT_EXIST = -2013
