import type { AgentType } from '@agent-desk/schemas'

/**
 * What the seed needs to list this agent under the Platform Account (Story 2.4
 * AC, FR-44). It lives with the agent so the price, the port, and the compose
 * service name have one source; `scripts/seed.ts` imports it instead of
 * repeating them.
 */
export interface SeedListing {
  name: string
  type: AgentType
  /** Decimal tUSD, the same string compose passes as `AGENT_PRICE` (AD-13). */
  price: string
  /** The port the compose service publishes. */
  port: number
  /** The env var the seed reads the endpoint from. */
  endpointEnv: string
  /**
   * Used when that env var is unset. The engine calls this endpoint from the
   * worker container, so the default is the compose service on the shared
   * network; a seed run from the host sets `endpointEnv` to
   * `http://localhost:4104` instead.
   */
  defaultEndpoint: string
  description: string
}

export const seedListing = {
  name: 'Guardrail Risk',
  type: 'risk',
  price: '0.02',
  port: 4104,
  endpointEnv: 'GUARDRAIL_RISK_URL',
  defaultEndpoint: 'http://agent-guardrail-risk:4104',
  description:
    'Rejects a confident counter-trend signal, rejects above 6% 24h volatility, ' +
    'reduces to 60% of the proposed size above 3%, and never sizes above the balance.',
} as const satisfies SeedListing
