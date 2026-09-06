import { z } from 'zod'
import { PgBoss } from 'pg-boss'
import { db, type Database } from '@agent-desk/db'
import { QUEUES } from '@agent-desk/schemas'
import type { CreateAccountDeps, JobConnection } from './create-account.ts'

/**
 * What `POST /api/auth/sign-up` needs from the outside world: the database and
 * a pg-boss publisher. Built lazily so importing the route never dials either.
 *
 * AD-1: the web app publishes jobs and holds no key. There is no signer here
 * and there is nothing to add one to.
 */

const envSchema = z.object({ DATABASE_URL: z.string().min(1) })

let parsed: z.infer<typeof envSchema> | undefined

/**
 * Parsed on first use, never at module scope. `next build` imports every route
 * to collect its page data and does that without the runtime environment, so a
 * top-level `parse` would turn a missing variable into a build failure instead
 * of the boot failure it should be.
 */
function env(): z.infer<typeof envSchema> {
  parsed ??= envSchema.parse(process.env)
  return parsed
}

let boss: Promise<PgBoss> | undefined

/**
 * One pg-boss instance per process. `start()` is enough for a publisher: the
 * queues are created by the worker and by `startBoss` in `packages/db`, and
 * `send` to an existing queue needs nothing else.
 */
function getBoss(): Promise<PgBoss> {
  boss ??= (async () => {
    const instance = new PgBoss(env().DATABASE_URL)
    await instance.start()
    return instance
  })()
  return boss
}

export function database(): Database {
  return db()
}

export function createAccountDeps(): CreateAccountDeps {
  return {
    db: db(),
    publish: async (accountId: string, connection: JobConnection) => {
      // AD-5: `wallet.create` is an `exclusive` queue keyed by `account_id`, so
      // one account never has two provisioning jobs. `db: connection` is what
      // puts this insert in the caller's transaction — without it the job would
      // be published whether or not the account row survives the commit.
      const instance = await getBoss()
      await instance.send(
        QUEUES.walletCreate,
        { account_id: accountId },
        { singletonKey: accountId, db: connection },
      )
    },
  }
}
