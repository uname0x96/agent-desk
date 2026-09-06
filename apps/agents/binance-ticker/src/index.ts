import { createAgent, loadAgentEnv } from '@agent-desk/agent-kit'
import { createLogger } from '@agent-desk/schemas/logger'
import { createTickerHandler } from './handler.ts'

/**
 * Story 1.5 / FR-44: the Binance Ticker seed agent. Compose runs it on :4101
 * with AGENT_PRICE=0.01; everything else about the 402, the validation, the
 * budget and the replay cache belongs to `createAgent` (AD-7).
 */

const env = loadAgentEnv()
const logger = createLogger('agent-binance-ticker')

const agent = createAgent({
  type: 'data',
  price: env.AGENT_PRICE,
  payTo: env.AGENT_PAYTO,
  facilitatorUrl: env.FACILITATOR_URL,
  internalToken: env.INTERNAL_TOKEN,
  chainId: env.CHAIN_ID,
  serviceName: 'agent-binance-ticker',
  logger,
  handler: createTickerHandler({ baseUrl: env.MARKET_DATA_URL }),
})

const { server } = await agent.listen(env.AGENT_PORT)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down')
    server.close(() => process.exit(0))
  })
}
