import { createAgent, loadAgentEnv } from '@agent-desk/agent-kit'
import { createLogger } from '@agent-desk/schemas/logger'
import { createSloppyHandler } from './handler.ts'

/**
 * FR-44, Sloppy Research. Compose runs it twice off one image: as
 * `agent-sloppy-research` on :4103 and as `agent-sloppy-research-2` on :4107
 * with `AGENT_PAYTO` from `.env.seed`. Both read AGENT_PORT, AGENT_PRICE and
 * AGENT_PAYTO from the environment; everything about the 402, the validation,
 * the budget and the replay cache belongs to `createAgent` (AD-7).
 */

const env = loadAgentEnv()
const logger = createLogger('agent-sloppy-research')

const agent = createAgent({
  type: 'research',
  price: env.AGENT_PRICE,
  payTo: env.AGENT_PAYTO,
  facilitatorUrl: env.FACILITATOR_URL,
  internalToken: env.INTERNAL_TOKEN,
  chainId: env.CHAIN_ID,
  serviceName: 'agent-sloppy-research',
  logger,
  handler: createSloppyHandler(),
})

const { server } = await agent.listen(env.AGENT_PORT)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down')
    server.close(() => process.exit(0))
  })
}
