/**
 * One real MARKET order against the configured exchange, so the live half of
 * Story 2.5 can be proved the moment credentials exist.
 *
 *   corepack pnpm --filter @agent-desk/agent-spot-executor place-order
 *   corepack pnpm --filter @agent-desk/agent-spot-executor place-order BNBUSDT BUY 6
 *
 * Everything else in this agent is tested against a mocked `Exchange` port.
 * This script is the only thing that touches the exchange itself, and it
 * touches it exactly once, deliberately, from a human's keyboard — never from
 * `pnpm test`. Without `EXCHANGE_API_KEY` and `EXCHANGE_PRIVATE_KEY` it prints
 * why it is skipping and exits 0, so it is safe to run on any laptop.
 */

import { createBinanceExchange } from '../src/binance-exchange.ts'
import {
  credentialKeysFor,
  exchangeModeFor,
  exchangeOptionsFor,
  parseExchangeEnv,
} from '../src/env.ts'
import { divideDecimal } from '../src/decimal.ts'
import { ExchangeRejectionError } from '../src/exchange.ts'

const [symbol = 'BNBUSDT', side = 'BUY', sizeUsdt = '6'] = process.argv.slice(2)

if (side !== 'BUY' && side !== 'SELL') {
  process.stderr.write(`side must be BUY or SELL, got ${side}\n`)
  process.exit(1)
}

const env = parseExchangeEnv(process.env)
if (!env.ok) {
  const keys = credentialKeysFor(exchangeModeFor(process.env.EXCHANGE_BASE_URL ?? ''))
  process.stdout.write(
    'SKIPPED: no exchange credentials, so no order was placed.\n' +
      `${env.issues.map((issue) => `  ${issue}`).join('\n')}\n` +
      `Set ${keys.apiKey} and ${keys.privateKey} (an Ed25519 PEM from the Binance Spot ` +
      'Testnet key page, or the Demo Trading page) and run this again.\n',
  )
  process.exit(0)
}

const exchange = createBinanceExchange(exchangeOptionsFor(env.value))

process.stdout.write(
  `${env.value.EXCHANGE_BASE_URL} (${env.value.EXCHANGE_MODE})\n` +
    `balance before: ${(await exchange.getBalance()).balanceUsdt} USDT\n` +
    `placing ${side} ${sizeUsdt} USDT of ${symbol}\n`,
)

try {
  const order = await exchange.placeMarketOrder({ symbol, side, quoteQty: sizeUsdt })
  process.stdout.write(
    `order ${order.orderId}: ${order.status}\n` +
      `  executed ${order.executedQty} for ${order.cumulativeQuoteQty} USDT\n` +
      (order.executedQty === '0'
        ? '  no fill\n'
        : `  average price ${divideDecimal(order.cumulativeQuoteQty, order.executedQty)}\n`),
  )
  const fetched = await exchange.getOrder(symbol, order.orderId)
  process.stdout.write(`re-read order ${fetched.orderId}: ${JSON.stringify(fetched.raw)}\n`)
  process.stdout.write(`balance after: ${(await exchange.getBalance()).balanceUsdt} USDT\n`)
} catch (error) {
  if (error instanceof ExchangeRejectionError) {
    process.stderr.write(`exchange refused the order: ${error.message} (code ${error.code})\n`)
    process.exit(1)
  }
  throw error
}
