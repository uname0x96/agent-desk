import type { PgBoss } from 'pg-boss'
import type { Database } from '@agent-desk/db'
import type { Engine } from '@agent-desk/scripts/wiring'
import type { Logger as PinoLogger } from 'pino'
import type { Logger } from '@agent-desk/core/ports'
import {
  QUEUES,
  listingVerifyJob,
  listingWriteJob,
  type ListingVerifyJob,
  type ListingWriteJob,
} from '@agent-desk/schemas'
import { env } from '../env.ts'
import { buildListingVerify, buildListingWrite } from './listing/wiring.ts'

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
 * the paid verification Call (Story 3.4), then
 * `IdentityRegistry.register(agentURI)`, then `AgentDeskRegistry.list(...)`
 * with the Stake, each step reached only because the one before it succeeded.
 * The body is `createListingVerifyJob` in `packages/core/listing`; the ports it
 * depends on are assembled by `buildListingVerify`, which the integration test
 * drives directly.
 *
 * The queue is `exclusive` with `listing_id` as its singleton key (see
 * `packages/db/queues`), so one Listing is never verified twice at once. The job
 * body is idempotent anyway, because a redelivery after a crash is the case AD-8
 * exists for.
 *
 * `listing.write` (`price:`, `stake:`, `pause:`) is the Creator's three changes
 * to a Listing that is already on the Registry (Story 3.6). Its intent keys are
 * allocated by the web handler and carried in the job payload, never computed
 * by the job (AD-8), and its queue is `exclusive` on the intent key, so one
 * transaction is queued or active per key and a redelivery finds the
 * `chain_tx` row rather than sending a second time.
 */
export async function registerListingJobs(deps: JobDeps): Promise<void> {
  const runListingVerify = buildListingVerify({
    db: deps.db,
    engine: deps.engine,
    chainId: env.CHAIN_ID,
    rpcUrls: env.RPC_URLS,
    facilitatorUrl: deps.facilitatorUrl,
    publicBaseUrl: deps.publicBaseUrl,
    platformChatId: platformChatId(),
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

  const runListingWrite = buildListingWrite({
    db: deps.db,
    engine: deps.engine,
    chainId: env.CHAIN_ID,
    rpcUrls: env.RPC_URLS,
    logger: adaptLogger(deps.logger),
  })

  await deps.boss.work<ListingWriteJob>(QUEUES.listingWrite, async (jobs) => {
    for (const job of jobs) {
      const result = await runListingWrite(listingWriteJob.parse(job.data))
      // Same rule as above: a refusal is already on the row as `last_error` and
      // re-running would write the same sentence again, so only an unfinished
      // receipt asks to be redelivered.
      if (!result.ok && result.retryable) {
        throw new Error(`listing.write is incomplete for ${result.intentKey}: ${result.reason}`)
      }
    }
  })

  deps.logger.info(
    { queues: [QUEUES.listingVerify, QUEUES.listingWrite] },
    'listing jobs registered',
  )
}

/**
 * Addendum §1 / conventions: `PLATFORM_CHAT_ID` lives only in the worker, and
 * `listing.verify` is its only reader — it replaces `recipient.address` in the
 * `notify` sample so that verifying a `notify` Agent delivers a real message to
 * the Platform chat.
 *
 * It is read here rather than through `../env.ts` because that schema belongs
 * to another story's file; a `PLATFORM_CHAT_ID` entry of optional digits is the
 * change this asks for there. Until it lands, an unset or malformed value
 * leaves the sample's own placeholder in place, which is what a `notify`
 * verification did before this story: a delivery that fails is the Agent's
 * answer, not a crash here.
 */
function platformChatId(): string | undefined {
  const value = process.env.PLATFORM_CHAT_ID?.trim()
  return value && /^-?\d+$/.test(value) ? value : undefined
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
