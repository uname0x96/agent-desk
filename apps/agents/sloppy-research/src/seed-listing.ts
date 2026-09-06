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
  name: 'Sloppy Research',
  type: 'research',
  price: '0.03',
  port: 4103,
  endpointEnv: 'SLOPPY_RESEARCH_URL',
  defaultEndpoint: 'http://agent-sloppy-research:4103',
  description:
    'Fades the 24 h move: LONG when the market fell, SHORT when it rose, always at confidence 0.9.',
}

/**
 * The second instance of this same image, `agent-sloppy-research-2` on :4107.
 * It differs only in `AGENT_PAYTO`, which compose reads from the `.env.seed`
 * file the seed writes, so it is paid to a different wallet than the :4103
 * instance. Story 2.10 decides whether it gets a Listing of its own.
 */
export const secondInstance = {
  service: 'agent-sloppy-research-2',
  port: 4107,
  endpointEnv: 'SLOPPY_RESEARCH_2_URL',
  defaultEndpoint: 'http://agent-sloppy-research-2:4107',
  /** Read from the compose `env_file` `.env.seed`, not from `.env`. */
  payToEnvFile: '.env.seed',
} as const
