import { describe, expect, it, vi } from 'vitest'
import { BadRequestError, NetworkError, ServerError, SpotRestAPI } from '@binance/spot'
import {
  createBinanceExchange,
  DEMO_BASE_URL,
  TESTNET_BASE_URL,
  type SpotRestApi,
} from './binance-exchange.ts'
import { ExchangeRejectionError, ExchangeUnavailableError } from './exchange.ts'

/**
 * The `@binance/spot` mapping, against a stub of the three REST calls this
 * agent uses. `SpotRestApi` is `Pick<Spot['restAPI'], ...>`, so the stub below
 * is checked against the SDK's real signatures: a wrong field name or a
 * `string` where the SDK sends `number | bigint` fails the typecheck rather
 * than the test.
 *
 * The live exchange is unreachable from here — no Spot Testnet credentials
 * exist — so `scripts/place-order.ts` is what proves the real call.
 */

/** Every call answers `RestApiResponse<T>`, whose `data` is an async function. */
function restResponse<T>(data: T) {
  return { data: () => Promise.resolve(data), status: 200, headers: {}, rateLimits: [] }
}

/** A real FULL response to a 6 USDT BNBUSDT market buy, field for field. */
const FILLED_ORDER = {
  symbol: 'BNBUSDT',
  orderId: 6789012,
  orderListId: -1,
  clientOrderId: 'x-AGENTDESK-1',
  transactTime: 1788674230047,
  price: '0.00000000',
  origQty: '0.00000000',
  executedQty: '0.00788000',
  origQuoteOrderQty: '6.00000000',
  cummulativeQuoteQty: '5.99999520',
  status: 'FILLED',
  timeInForce: 'GTC',
  type: 'MARKET',
  side: 'BUY',
}

const ACCOUNT = {
  accountType: 'SPOT',
  balances: [
    { asset: 'BNB', free: '0.10000000', locked: '0.00000000' },
    { asset: 'USDT', free: '9412.51000000', locked: '0.00000000' },
  ],
}

function stubRestApi(overrides: Partial<SpotRestApi> = {}): SpotRestApi {
  return {
    newOrder: () => Promise.resolve(restResponse(FILLED_ORDER)),
    getOrder: () => Promise.resolve(restResponse({ ...FILLED_ORDER, isWorking: true })),
    getAccount: () => Promise.resolve(restResponse(ACCOUNT)),
    ...overrides,
  }
}

function exchangeWith(restApi: SpotRestApi, baseUrl = TESTNET_BASE_URL) {
  return createBinanceExchange({ apiKey: 'k', privateKey: 'pem', baseUrl, restApi })
}

describe('createBinanceExchange', () => {
  it('places a MARKET order with quoteOrderQty and asks for the full response', async () => {
    const newOrder = vi.fn(() => Promise.resolve(restResponse(FILLED_ORDER)))
    const exchange = exchangeWith(stubRestApi({ newOrder }))

    const order = await exchange.placeMarketOrder({
      symbol: 'BNBUSDT',
      side: 'BUY',
      quoteQty: '6',
    })

    expect(newOrder).toHaveBeenCalledWith({
      symbol: 'BNBUSDT',
      side: SpotRestAPI.NewOrderSideEnum.BUY,
      type: SpotRestAPI.NewOrderTypeEnum.MARKET,
      quoteOrderQty: 6,
      newOrderRespType: SpotRestAPI.NewOrderNewOrderRespTypeEnum.FULL,
    })
    expect(order).toMatchObject({
      orderId: '6789012',
      status: 'FILLED',
      executedQty: '0.00788',
      cumulativeQuoteQty: '5.9999952',
      transactTime: 1788674230047,
    })
    expect(order.raw).toBe(FILLED_ORDER)
  })

  it('carries a bigint order id through as a string', async () => {
    const exchange = exchangeWith(
      stubRestApi({
        newOrder: () =>
          Promise.resolve(restResponse({ ...FILLED_ORDER, orderId: 9007199254740993n })),
      }),
    )
    const order = await exchange.placeMarketOrder({
      symbol: 'BNBUSDT',
      side: 'BUY',
      quoteQty: '6',
    })
    expect(order.orderId).toBe('9007199254740993')
  })

  it('turns an exchange refusal into ExchangeRejectionError carrying its message and code', async () => {
    const exchange = exchangeWith(
      stubRestApi({
        newOrder: () =>
          Promise.reject(new BadRequestError('Filter failure: NOTIONAL', -1013)),
      }),
    )

    await expect(
      exchange.placeMarketOrder({ symbol: 'BNBUSDT', side: 'BUY', quoteQty: '1' }),
    ).rejects.toMatchObject({
      name: 'ExchangeRejectionError',
      message: 'Filter failure: NOTIONAL',
      code: -1013,
    })
  })

  it('keeps a 5xx and a dropped connection apart from a refusal', async () => {
    const serverError = exchangeWith(
      stubRestApi({ newOrder: () => Promise.reject(new ServerError('Server error: 503', 503)) }),
    )
    await expect(
      serverError.placeMarketOrder({ symbol: 'BNBUSDT', side: 'BUY', quoteQty: '6' }),
    ).rejects.toBeInstanceOf(ExchangeUnavailableError)

    const networkError = exchangeWith(
      stubRestApi({ newOrder: () => Promise.reject(new NetworkError('timeout')) }),
    )
    await expect(
      networkError.placeMarketOrder({ symbol: 'BNBUSDT', side: 'BUY', quoteQty: '6' }),
    ).rejects.toBeInstanceOf(ExchangeUnavailableError)
  })

  it('refuses a size that is not a positive amount before calling the exchange', async () => {
    const newOrder = vi.fn(() => Promise.resolve(restResponse(FILLED_ORDER)))
    const exchange = exchangeWith(stubRestApi({ newOrder }))

    await expect(
      exchange.placeMarketOrder({ symbol: 'BNBUSDT', side: 'BUY', quoteQty: '0' }),
    ).rejects.toBeInstanceOf(ExchangeRejectionError)
    expect(newOrder).not.toHaveBeenCalled()
  })

  it('reads an order back by symbol and id, forwarding the raw response', async () => {
    const getOrder = vi.fn(() => Promise.resolve(restResponse(FILLED_ORDER)))
    const exchange = exchangeWith(stubRestApi({ getOrder }))

    const fetched = await exchange.getOrder('BNBUSDT', '6789012')

    expect(getOrder).toHaveBeenCalledWith({ symbol: 'BNBUSDT', orderId: 6789012n })
    expect(fetched).toEqual({ orderId: '6789012', raw: FILLED_ORDER })
  })

  it('refuses an order id that is not an integer', async () => {
    const exchange = exchangeWith(stubRestApi())
    await expect(exchange.getOrder('BNBUSDT', 'not-an-id')).rejects.toBeInstanceOf(
      ExchangeRejectionError,
    )
  })

  it('reads the free USDT of the Platform Exchange Account', async () => {
    const getAccount = vi.fn(() => Promise.resolve(restResponse(ACCOUNT)))
    const exchange = exchangeWith(stubRestApi({ getAccount }))

    expect(await exchange.getBalance()).toEqual({ balanceUsdt: '9412.51' })
    expect(getAccount).toHaveBeenCalledWith({ omitZeroBalances: false })
  })

  it('answers zero for an account that has never held USDT', async () => {
    const exchange = exchangeWith(
      stubRestApi({
        getAccount: () => Promise.resolve(restResponse({ accountType: 'SPOT', balances: [] })),
      }),
    )
    expect(await exchange.getBalance()).toEqual({ balanceUsdt: '0' })
  })

  it('exposes both hosts of AD-11 from the SDK rather than as typed constants', () => {
    expect(TESTNET_BASE_URL).toBe('https://testnet.binance.vision')
    expect(DEMO_BASE_URL).toBe('https://demo-api.binance.com')
  })
})
