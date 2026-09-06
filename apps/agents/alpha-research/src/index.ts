import { createAgent, loadAgentEnv } from '@agent-desk/agent-kit'
import { createLogger } from '@agent-desk/schemas/logger'
import { loadAlphaEnv } from './env.ts'
import { createAlphaHandler } from './handler.ts'
import { createAnthropicModel } from './model.ts'

/**
 * FR-44, Alpha Research. Compose runs it on :4102 with AGENT_PRICE=0.05.
 * `loadAlphaEnv` runs before the server binds, so a missing ANTHROPIC_API_KEY
 * refuses the boot instead of turning every paid request into a HOLD.
 */

const env = loadAgentEnv()
const alphaEnv = loadAlphaEnv()
const logger = createLogger('agent-alpha-research')

const agent = createAgent({
  type: 'research',
  price: env.AGENT_PRICE,
  payTo: env.AGENT_PAYTO,
  facilitatorUrl: env.FACILITATOR_URL,
  internalToken: env.INTERNAL_TOKEN,
  chainId: env.CHAIN_ID,
  serviceName: 'agent-alpha-research',
  logger,
  handler: createAlphaHandler({
    model: createAnthropicModel({
      apiKey: alphaEnv.ANTHROPIC_API_KEY,
      model: alphaEnv.ANTHROPIC_MODEL,
    }),
  }),
})

const { server } = await agent.listen(env.AGENT_PORT)
logger.info({ model: alphaEnv.ANTHROPIC_MODEL }, 'alpha research model configured')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down')
    server.close(() => process.exit(0))
  })
}
