import type { AgentHandler, AgentHandlerContext } from '@agent-desk/agent-kit'
import type { ExecutionOutput } from '@agent-desk/schemas'
import { compareDecimal, divideDecimal, isZero, normalizeDecimal } from './decimal.ts'
import { ExchangeRejectionError, type Exchange } from './exchange.ts'
import { SettingsUnavailableError, type SettingsSource } from './settings.ts'

/**
 * FR-31 / AD-10 / AD-11. The `execution` Type over one MARKET order on the
 * Platform Exchange Account.
 *
 * Three refusals are answered before the exchange is touched at all, and every
 * one of them is a paid, schema-valid 200 rather than an error: the buyer paid
 * for the check, and got it. AD-11 makes this agent the only enforcer of both
 * switches, so a refusal here is the platform's answer, not a failure.
 */

/** The exact `reason` strings of Story 2.5; the Run view and the tests match on them. */
export const REASON_EMERGENCY_STOP = 'emergency stop'
export const REASON_ABOVE_CEILING = 'above platform order ceiling'
export const REASON_SETTINGS_UNAVAILABLE = 'settings unavailable'

export interface ExecutionHandlerOptions {
  exchange: Exchange
  settings: SettingsSource
  /** Overridden in the tests so a fill carries a fixed timestamp. */
  now?: () => Date
}

function rejected(reason: string, ts: string): ExecutionOutput {
  return { status: 'REJECTED', reason, ts }
}

export function createExecutionHandler(options: ExecutionHandlerOptions): AgentHandler<'execution'> {
  const now = options.now ?? (() => new Date())

  return async (input, context: AgentHandlerContext): Promise<ExecutionOutput> => {
    const ts = now().toISOString()

    let settings
    try {
      settings = await options.settings(context.signal)
    } catch (error) {
      if (error instanceof SettingsUnavailableError) {
        context.logger.warn({ reason: error.message }, 'platform settings unavailable')
        return rejected(REASON_SETTINGS_UNAVAILABLE, ts)
      }
      // The handler budget expired: that is the kit's 500, not a refusal.
      throw error
    }

    if (settings.emergency_stop) {
      context.logger.warn({ symbol: input.symbol }, 'refused by emergency stop')
      return rejected(REASON_EMERGENCY_STOP, ts)
    }

    if (compareDecimal(input.size_usdt, settings.order_ceiling_usdt) > 0) {
      context.logger.warn(
        { symbol: input.symbol, size_usdt: input.size_usdt, ceiling: settings.order_ceiling_usdt },
        'refused above the platform order ceiling',
      )
      return rejected(REASON_ABOVE_CEILING, ts)
    }

    let order
    try {
      order = await options.exchange.placeMarketOrder({
        symbol: input.symbol,
        side: input.side,
        quoteQty: input.size_usdt,
      })
    } catch (error) {
      // A refusal by the exchange is still an answer, so it is a paid
      // REJECTED carrying the exchange's own message. Anything else —
      // unreachable, or a Binance 5xx, which Binance documents as "execution
      // status UNKNOWN" — is not an answer, so it goes on as the kit's 500 and
      // the payment never settles. Claiming REJECTED there could deny an order
      // that in fact reached the book.
      if (error instanceof ExchangeRejectionError) {
        context.logger.warn(
          { symbol: input.symbol, code: error.code, reason: error.message },
          'exchange rejected the order',
        )
        return rejected(error.message, ts)
      }
      throw error
    }

    // A MARKET order that expired or was killed leaves nothing to divide by;
    // reporting FILLED with no fill would be a lie, and dividing by zero would
    // be a 500. The exchange's status is the reason.
    if (isZero(order.executedQty)) {
      context.logger.warn(
        { symbol: input.symbol, order_id: order.orderId, status: order.status },
        'exchange returned an order without a fill',
      )
      return rejected(`order ${order.status} with no fill`, ts)
    }

    const filledAt = order.transactTime === null ? ts : new Date(order.transactTime).toISOString()
    return {
      status: 'FILLED',
      order_id: order.orderId,
      // The average fill price: cumulative quote over executed quantity, as a
      // decimal string. Exact BigInt division, never a float.
      filled_price: divideDecimal(order.cumulativeQuoteQty, order.executedQty),
      filled_qty: normalizeDecimal(order.executedQty),
      ts: filledAt,
    }
  }
}
