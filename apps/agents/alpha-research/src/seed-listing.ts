import type { AgentType } from '@agent-desk/schemas'

/**
 * What `pnpm seed` needs to list this agent (Story 2.10). Kept in the agent so
 * the price, the port and the endpoint stay in one place with the code that
 * serves them; the seed imports the descriptor rather than repeating them.
 *
 * `endpointEnv` is the variable the seed reads the endpoint from;
 * `defaultEndpoint` is the compose service, which is what the demo laptop uses.
 */
export interface SeedListing {
  name: string
  type: AgentType
  /** Decimal USDT, the same string the compose service passes as AGENT_PRICE. */
  price: string
  port: number
  endpointEnv: string
  defaultEndpoint: string
  description: string
}

export const seedListing: SeedListing = {
  name: 'Alpha Research',
  type: 'research',
  price: '0.05',
  port: 4102,
  endpointEnv: 'ALPHA_RESEARCH_URL',
  defaultEndpoint: 'http://agent-alpha-research:4102',
  description:
    'Sends the market snapshot to an LLM with a fixed prompt and answers a trend-following signal with a one-sentence reason.',
}
