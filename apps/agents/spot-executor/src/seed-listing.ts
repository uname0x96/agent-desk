import type { AgentType } from '@agent-desk/schemas'

/**
 * Story 2.5 wants `pnpm seed` to list this agent under the Platform Account so
 * the Workflow Builder of Story 2.7 and the engine of Story 2.8 have a
 * Provider of Type `execution`. `scripts/src/seed.ts` belongs to Story 1.10,
 * so what this agent owns — its name, endpoint, price and stake — is declared
 * here and imported there rather than typed twice.
 *
 * The fields match `createListingRequest` in `@agent-desk/schemas`, plus the
 * seed-only `skip_verification` path of AD-2 that Story 3.4 replaces with a
 * real verification Call.
 */

export interface AgentSeedListing {
  name: string
  type: AgentType
  /** `http://` is allowed for compose service names by the route conventions. */
  endpoint: string
  /** Decimal tUSD (AD-13). */
  price: string
  /** Ten times the price, which is the platform minimum. */
  stake: string
  description: string
  /**
   * AD-10: `POST /api/listings` refuses `type = execution` from anyone but
   * `platform_settings.platform_account_id`, so this listing is created as the
   * Platform Account.
   */
  owner: 'platform'
  /** Accepted only from the seed script; the seed then waits for `status = 'active'`. */
  skip_verification: true
}

/** The compose port of `agent-spot-executor`. */
export const SPOT_EXECUTOR_PORT = 4105

export const SPOT_EXECUTOR_COMPOSE_URL = `http://agent-spot-executor:${SPOT_EXECUTOR_PORT}`

/** The same listing against a different host, for a seed run from the laptop. */
export function seedListingAt(endpoint: string): AgentSeedListing {
  return { ...seedListing, endpoint }
}

export const seedListing: AgentSeedListing = {
  name: 'Binance Spot Executor',
  type: 'execution',
  endpoint: SPOT_EXECUTOR_COMPOSE_URL,
  price: '0.01',
  stake: '0.1',
  description:
    'Places a MARKET order on the Platform Exchange Account and answers the fill, ' +
    'or a schema-valid refusal when the platform has stopped trading.',
  owner: 'platform',
  skip_verification: true,
}
