import type { InternalRouter } from '@agent-desk/agent-kit'
import { apiError, internalBalance, internalOrder } from '@agent-desk/schemas'
import type { Logger } from '@agent-desk/schemas/logger'
import {
  ExchangeRejectionError,
  ORDER_DOES_NOT_EXIST,
  type Exchange,
} from './exchange.ts'

/**
 * AD-11 / AD-14: the two internal routes of this agent, in the
 * `InternalBalance` and `InternalOrder` shapes. `createAgent` mounts them
 * under `/internal/*` behind `Authorization: Bearer INTERNAL_TOKEN` and
 * answers 401 for every path there without it, including these, so the guard
 * is not written again here.
 *
 * The engine calls `GET /internal/balance` before the `risk` Node to fill
 * `balance_usdt`; `GET /api/runs/<id>/order` proxies `GET /internal/orders/<id>`
 * for the Run view's "verify on Binance" action.
 */

export interface InternalRoutesOptions {
  exchange: Exchange
  logger: Logger
}

export function createInternalRoutes(options: InternalRoutesOptions) {
  const { exchange, logger } = options

  return (router: InternalRouter): void => {
    router.get('/balance', async (_req, res) => {
      try {
        const balance = await exchange.getBalance()
        const body = internalBalance.safeParse({ balance_usdt: balance.balanceUsdt })
        if (!body.success) {
          logger.error({ balance: balance.balanceUsdt }, 'exchange balance is off-schema')
          res
            .status(500)
            .json(apiError('internal_error', 'exchange returned an unusable balance'))
          return
        }
        res.status(200).json(body.data)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error({ reason: message }, 'internal balance failed')
        res.status(500).json(apiError('internal_error', `exchange balance failed: ${message}`))
      }
    })

    router.get('/orders/:orderId', async (req, res) => {
      const orderId = req.params.orderId
      const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : ''
      if (symbol === '') {
        res
          .status(400)
          .json(apiError('validation_failed', 'symbol is a required query parameter'))
        return
      }

      try {
        const order = await exchange.getOrder(symbol, orderId)
        const body = internalOrder.safeParse({ order_id: order.orderId, raw: order.raw })
        if (!body.success) {
          logger.error({ order_id: orderId }, 'exchange order is off-schema')
          res.status(500).json(apiError('internal_error', 'exchange returned an unusable order'))
          return
        }
        res.status(200).json(body.data)
      } catch (error) {
        if (error instanceof ExchangeRejectionError && error.code === ORDER_DOES_NOT_EXIST) {
          res
            .status(404)
            .json(apiError('not_found', `no order ${orderId} on ${symbol}`))
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        logger.error({ order_id: orderId, symbol, reason: message }, 'internal order lookup failed')
        res.status(500).json(apiError('internal_error', `exchange order lookup failed: ${message}`))
      }
    })
  }
}
