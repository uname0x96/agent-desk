import { z } from 'zod'
import { PgBoss } from 'pg-boss'
import { db } from '@agent-desk/db'
import { QUEUES } from '@agent-desk/schemas'
import type { CreateListingDeps } from './create-listing.ts'

/**
 * What `POST /api/listings` needs from the outside world, built once per process
 * and lazily.
 *
 * AD-1: the web app may write its own tables and publish jobs, but it holds no
 * key and signs nothing — the identity, the Stake and the verification payment
 * are all the worker's, reached through one `listing.verify` message.
 *
 * `next build` imports every route to collect its page data and does that
 * without the runtime environment, so `DATABASE_URL` is parsed on first use
 * rather than at module scope: a missing variable has to be a boot failure, not
 * a build failure.
 */

const envSchema = z.object({ DATABASE_URL: z.string().min(1) })

let parsed: z.infer<typeof envSchema> | undefined

function env(): z.infer<typeof envSchema> {
  parsed ??= envSchema.parse(process.env)
  return parsed
}

let boss: Promise<PgBoss> | undefined

/**
 * One pg-boss instance per process. `start()` is enough for a publisher: the
 * queues are created by the worker and by `startBoss` in `packages/db`.
 */
function getBoss(): Promise<PgBoss> {
  boss ??= (async () => {
    const instance = new PgBoss(env().DATABASE_URL)
    await instance.start()
    return instance
  })()
  return boss
}

export function createListingDeps(): CreateListingDeps {
  return {
    db: db(),
    publish: async (listingId) => {
      // AD-2/AD-8: `listing.verify` is an `exclusive` queue and `listing_id` is
      // its singleton key, so a Creator who double-clicks Submit — or a retry
      // from anywhere else — gets one pipeline, not two identities.
      const instance = await getBoss()
      await instance.send(QUEUES.listingVerify, { listing_id: listingId }, { singletonKey: listingId })
    },
  }
}
