import { createAgent } from '@agent-desk/agent-kit'
import { createLogger } from '@agent-desk/schemas/logger'
import { createBinanceExchange } from './binance-exchange.ts'
import { exchangeOptionsFor, loadExecutorEnv } from './env.ts'
import { createExecutionHandler } from './handler.ts'
import { createInternalRoutes } from './internal-routes.ts'
import { createSettingsClient } from './settings.ts'

/**
 * FR-31 / FR-44 / AD-11: the Binance Spot Executor. Compose runs it on :4105
 * with AGENT_PRICE=0.01. It is the only process in the repository that holds
 * exchange credentials, and the only enforcer of Emergency Stop and the
 * platform order ceiling.
 *
 * The env is validated before the client is built, so a missing key pair stops
 * the process at boot with the key names rather than becoming a 500 on the
 * first paid request.
 */

const env = loadExecutorEnv()
const logger = createLogger('agent-spot-executor')

const exchange = createBinanceExchange(exchangeOptionsFor(env))

const agent = createAgent({
  type: 'execution',
  price: env.AGENT_PRICE,
  payTo: env.AGENT_PAYTO,
  facilitatorUrl: env.FACILITATOR_URL,
  internalToken: env.INTERNAL_TOKEN,
  chainId: env.CHAIN_ID,
  serviceName: 'agent-spot-executor',
  logger,
  handler: createExecutionHandler({
    exchange,
    settings: createSettingsClient({
      baseUrl: env.PLATFORM_INTERNAL_URL,
      token: env.INTERNAL_TOKEN,
    }),
  }),
  internalRoutes: createInternalRoutes({ exchange, logger }),
})

const { server } = await agent.listen(env.AGENT_PORT)
logger.info(
  { exchange_base_url: env.EXCHANGE_BASE_URL, exchange_mode: env.EXCHANGE_MODE },
  'exchange client ready',
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down')
    server.close(() => process.exit(0))
  })
}
