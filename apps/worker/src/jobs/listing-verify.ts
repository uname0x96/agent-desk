import type { PgBoss } from 'pg-boss'
import type { Database } from '@agent-desk/db'
import type { Engine } from '@agent-desk/scripts/wiring'
import type { Logger } from 'pino'

export interface JobDeps {
  db: Database
  engine: Engine
  boss: PgBoss
  logger: Logger
  facilitatorUrl: string
  publicBaseUrl?: string | undefined
}

/**
 * Registers `listing.verify` and `listing.write`.
 *
 * Story 1.7 implements the body: skip the verification Call only when
 * `skip_verification` is set, then `identity:<listing_id>`, then
 * `list:<listing_id>`, each through `chainWrite`, and let
 * `refreshListingFromChain` flip the listing to `active`.
 */
export async function registerListingJobs(deps: JobDeps): Promise<void> {
  deps.logger.warn('listing.verify is not registered yet (Story 1.7)')
  await Promise.resolve()
}
