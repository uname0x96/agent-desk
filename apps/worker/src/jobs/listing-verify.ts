import type { PgBoss } from 'pg-boss'
import type { Database } from '@agent-desk/db'
import type { Engine } from '@agent-desk/scripts/wiring'
import type { Logger as PinoLogger } from 'pino'
import type { Logger } from '@agent-desk/core/ports'
import { QUEUES, listingVerifyJob, type ListingVerifyJob } from '@agent-desk/schemas'
import { env } from '../env.ts'
import { buildListingVerify } from './listing/wiring.ts'

export interface JobDeps {
  db: Database
  engine: Engine
  boss: PgBoss
  logger: PinoLogger
  facilitatorUrl: string
  publicBaseUrl?: string | undefined
}

/**
 * Registers `listing.verify` and `listing.write`.
 *
 * AD-2: `listing.verify` is the one pipeline that puts a Listing on chain —
 * verification Call, then `IdentityRegistry.register(agentURI)`, then
 * `AgentDeskRegistry.list(...)` with the Stake, each step reached only because
 * the one before it succeeded. The body is `createListingVerifyJob` in
 * `packages/core/listing`; the ports it depends on are assembled by
 * `buildListingVerify`, which the integration test drives directly.
 *
 * The queue is `exclusive` with `listing_id` as its singleton key (see
 * `packages/db/queues`), so one Listing is never verified twice at once. The job
 * body is idempotent anyway, because a redelivery after a crash is the case AD-8
 * exists for.
 *
 * `listing.write` (`price:`, `stake:`, `pause:`) belongs to Story 3.6 and is
 * registered here when it lands; its intent keys are allocated by the web
 * handler and carried in the job payload, never computed by the job (AD-8).
 */
export async function registerListingJobs(deps: JobDeps): Promise<void> {
  const runListingVerify = buildListingVerify({
    db: deps.db,
    engine: deps.engine,
    chainId: env.CHAIN_ID,
    rpcUrls: env.RPC_URLS,
    publicBaseUrl: deps.publicBaseUrl,
    logger: adaptLogger(deps.logger),
  })

  await deps.boss.work<ListingVerifyJob>(QUEUES.listingVerify, async (jobs) => {
    for (const job of jobs) {
      const result = await runListingVerify(listingVerifyJob.parse(job.data))
      // A terminal refusal is already on the row as `failed` with its
      // `last_error`; re-running would only write the same thing again, so the
      // job succeeds and pg-boss stops. Only an unfinished step — a receipt that
      // has not arrived, an RPC that did not answer — asks to be redelivered.
      if (!result.ok && result.retryable) {
        throw new Error(`listing.verify is incomplete at ${result.failedAt}: ${result.reason}`)
      }
    }
  })

  deps.logger.info({ queue: QUEUES.listingVerify }, 'listing jobs registered')
}

/** Pino satisfies the port already; this narrows it to the four levels it names. */
function adaptLogger(logger: PinoLogger): Logger {
  return {
    debug: (fields, message) => logger.debug(fields, message),
    info: (fields, message) => logger.info(fields, message),
    warn: (fields, message) => logger.warn(fields, message),
    error: (fields, message) => logger.error(fields, message),
  }
}
