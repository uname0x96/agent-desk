import { createAgent, loadAgentEnv } from '@agent-desk/agent-kit'
import { createLogger } from '@agent-desk/schemas/logger'
import { riskHandler } from './handler.ts'

/**
 * Story 2.4 / FR-44: the Guardrail Risk seed agent. Compose runs it on :4104
 * with AGENT_PRICE=0.02; everything else about the 402, the validation, the
 * budget and the replay cache belongs to `createAgent` (AD-7).
 */

const env = loadAgentEnv()
const logger = createLogger('agent-guardrail-risk')

const agent = createAgent({
  type: 'risk',
  price: env.AGENT_PRICE,
  payTo: env.AGENT_PAYTO,
  facilitatorUrl: env.FACILITATOR_URL,
  internalToken: env.INTERNAL_TOKEN,
  chainId: env.CHAIN_ID,
  serviceName: 'agent-guardrail-risk',
  logger,
  handler: riskHandler,
})

const { server } = await agent.listen(env.AGENT_PORT)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down')
    server.close(() => process.exit(0))
  })
}
