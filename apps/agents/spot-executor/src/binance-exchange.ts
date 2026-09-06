import {
  ConnectorClientError,
  NetworkError,
  ServerError,
  Spot,
  SpotRestAPI,
  SPOT_REST_API_DEMO_URL,
  SPOT_REST_API_TESTNET_URL,
} from '@binance/spot'
import {
  ExchangeRejectionError,
  ExchangeUnavailableError,
  type Exchange,
  type ExchangeBalance,
  type FetchedOrder,
  type PlaceMarketOrderParams,
  type PlacedOrder,
} from './exchange.ts'
import { normalizeDecimal } from './decimal.ts'

/**
 * The only file in the repository that imports `@binance/spot` (AD-11).
 *
 * What the installed 32.0.3 actually offers, checked against its `.d.ts`
 * rather than assumed:
 *
 *   new Spot({ configurationRestAPI: { apiKey, privateKey, basePath, timeout } })
 *   spot.restAPI.newOrder({ symbol, side, type, quoteOrderQty, newOrderRespType })
 *   spot.restAPI.getOrder({ symbol, orderId })
 *   spot.restAPI.getAccount({ omitZeroBalances })
 *
 * Three details shape the code below:
 *
 *   - every call answers `RestApiResponse<T>`, whose `data` is an async
 *     function, not a property: `(await spot.restAPI.newOrder(...)).data()`
 *   - `side`, `type` and `newOrderRespType` are real string enums
 *     (`SpotRestAPI.NewOrderSideEnum` and friends), not string literal unions
 *   - `orderId`, `transactTime` and the commissions come back as
 *     `number | bigint`, while prices and quantities come back as strings
 *
 * The SDK signs with `privateKey` through `crypto.sign(null, data, key)` when
 * the PEM is an Ed25519 key, which is the key type AD-11 asks for. It retries
 * only GET and DELETE, so a `newOrder` POST is sent exactly once.
 */

export const TESTNET_BASE_URL = SPOT_REST_API_TESTNET_URL
export const DEMO_BASE_URL = SPOT_REST_API_DEMO_URL

/** AD-7 keeps external timeouts under the 10 s handler budget; 3 s of it is the settings read. */
export const EXCHANGE_TIMEOUT_MS = 5_000

/** The three calls the port needs. A test supplies its own object of this shape. */
export type SpotRestApi = Pick<Spot['restAPI'], 'newOrder' | 'getOrder' | 'getAccount'>

export interface BinanceExchangeOptions {
  apiKey: string
  /** Ed25519 private key, PEM text or a path to a PEM file. */
  privateKey: string
  /** `https://testnet.binance.vision` or, for Spot Demo Mode, `https://demo-api.binance.com`. */
  baseUrl: string
  timeoutMs?: number
  /** Swapped for a stub in the unit tests; production builds a real `Spot`. */
  restApi?: SpotRestApi
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function readEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

/** `orderId` arrives as `number | bigint`; the schemas want a string. */
function readOrderId(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(value).toString()
  if (typeof value === 'string' && value !== '') return value
  throw new ExchangeUnavailableError('exchange answered without an order id')
}

/**
 * Binance's own errors carry `msg` and `code`; `@binance/common` puts `msg`
 * into `error.message`. A 5xx or a dropped connection is a different animal:
 * Binance documents 5xx as "execution status UNKNOWN", so it must not be
 * reported as a refusal — see the handler.
 */
function toExchangeError(error: unknown, operation: string): Error {
  if (error instanceof ServerError || error instanceof NetworkError) {
    return new ExchangeUnavailableError(`exchange ${operation} failed: ${error.message}`)
  }
  if (error instanceof ExchangeRejectionError || error instanceof ExchangeUnavailableError) {
    return error
  }
  if (error instanceof Error) {
    const code = (error as ConnectorClientError).code
    return new ExchangeRejectionError(error.message, code)
  }
  return new ExchangeUnavailableError(`exchange ${operation} failed: ${String(error)}`)
}

export function createBinanceExchange(options: BinanceExchangeOptions): Exchange {
  const restApi =
    options.restApi ??
    new Spot({
      configurationRestAPI: {
        apiKey: options.apiKey,
        privateKey: options.privateKey,
        basePath: options.baseUrl,
        timeout: options.timeoutMs ?? EXCHANGE_TIMEOUT_MS,
      },
    }).restAPI

  return {
    async placeMarketOrder({ symbol, side, quoteQty }: PlaceMarketOrderParams): Promise<PlacedOrder> {
      // `quoteOrderQty` is typed `number` by the SDK. Every size that reaches
      // here is between the 5 USDT minimum notional and the platform ceiling
      // with at most 8 decimals, so the double round-trips exactly.
      const quoteOrderQty = Number(quoteQty)
      if (!Number.isFinite(quoteOrderQty) || quoteOrderQty <= 0) {
        throw new ExchangeRejectionError(`order size is not a positive amount: ${quoteQty}`)
      }

      let response
      try {
        response = await restApi.newOrder({
          symbol,
          side: side as SpotRestAPI.NewOrderSideEnum,
          type: SpotRestAPI.NewOrderTypeEnum.MARKET,
          quoteOrderQty,
          // FULL carries `fills`, so the raw order the Run view links to is complete.
          newOrderRespType: SpotRestAPI.NewOrderNewOrderRespTypeEnum.FULL,
        })
      } catch (error) {
        throw toExchangeError(error, 'newOrder')
      }

      const raw = await response.data()
      return {
        orderId: readOrderId(raw.orderId),
        status: readString(raw.status) ?? 'UNKNOWN',
        executedQty: normalizeDecimal(readString(raw.executedQty) ?? '0'),
        cumulativeQuoteQty: normalizeDecimal(readString(raw.cummulativeQuoteQty) ?? '0'),
        transactTime: readEpochMs(raw.transactTime),
        raw,
      }
    },

    async getOrder(symbol: string, orderId: string): Promise<FetchedOrder> {
      let parsedId: bigint
      try {
        parsedId = BigInt(orderId)
      } catch {
        throw new ExchangeRejectionError(`order id is not an integer: ${orderId}`)
      }

      let response
      try {
        response = await restApi.getOrder({ symbol, orderId: parsedId })
      } catch (error) {
        throw toExchangeError(error, 'getOrder')
      }

      const raw = await response.data()
      return { orderId: readOrderId(raw.orderId ?? orderId), raw }
    },

    async getBalance(): Promise<ExchangeBalance> {
      let response
      try {
        response = await restApi.getAccount({ omitZeroBalances: false })
      } catch (error) {
        throw toExchangeError(error, 'getAccount')
      }

      const account = await response.data()
      const usdt = account.balances?.find((balance) => balance.asset === 'USDT')
      // An account that has never held USDT reports no row rather than a zero
      // one; "0" is the truthful free balance either way.
      return { balanceUsdt: normalizeDecimal(readString(usdt?.free) ?? '0') }
    },
  }
}
