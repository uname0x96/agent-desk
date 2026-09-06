import { z } from 'zod'
import { PgBoss } from 'pg-boss'
import { db, type Database } from '@agent-desk/db'
import { addressesFor, createChainReader, createPublicChainClient } from '@agent-desk/adapters/chain'
import { QUEUES, getDeployment } from '@agent-desk/schemas'
import type { CreateRunDeps } from './create-run.ts'

/**
 * What the two `/api/runs` routes need from the outside world, built once per
 * process and lazily, so importing a route never dials Postgres, an RPC node or
 * pg-boss.
 *
 * AD-1: the web app may read the chain and publish jobs, but it holds no key
 * and signs nothing — `createChainReader` is the read half of the chain adapter
 * and there is deliberately no writer here.
 *
 * AD-10: the tUSD address comes from `deployments/<chain id>.json`, never from
 * an env var; only the RPC endpoints and the database URL are environment.
 */

const envSchema = z.object({
  CHAIN_ID: z.coerce.number().int().positive().default(97),
  RPC_URLS: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((url) => url.trim()).filter(Boolean)),
  DATABASE_URL: z.string().min(1),
})

let parsed: z.infer<typeof envSchema> | undefined

/**
 * Parsed on first use, never at module scope. `next build` imports every route
 * to collect its page data, and it does that without the runtime environment,
 * so a top-level `parse` turns a missing variable into a build failure instead
 * of the boot failure it should be.
 */
function env(): z.infer<typeof envSchema> {
  parsed ??= envSchema.parse(process.env)
  return parsed
}

let boss: Promise<PgBoss> | undefined

/**
 * One pg-boss instance per process. `start()` is enough for a publisher: the
 * queues themselves are created by the worker and by `startBoss` in
 * `packages/db`, and `send` to an existing queue needs nothing else.
 */
function getBoss(): Promise<PgBoss> {
  boss ??= (async () => {
    const instance = new PgBoss(env().DATABASE_URL)
    await instance.start()
    return instance
  })()
  return boss
}

let reader: ReturnType<typeof createChainReader> | undefined

function getChainReader() {
  reader ??= createChainReader({
    publicClient: createPublicChainClient({ chainId: env().CHAIN_ID, rpcUrls: env().RPC_URLS }),
    addresses: addressesFor(env().CHAIN_ID),
  })
  return reader
}

export function database(): Database {
  return db()
}

export function createRunDeps(): CreateRunDeps {
  return {
    db: db(),
    chainId: env().CHAIN_ID,
    asset: getDeployment(env().CHAIN_ID).tusd.address.toLowerCase(),
    tokenBalance: (address) => getChainReader().tokenBalance(address),
    publish: async (runId, workflowId) => {
      // AD-4: `exclusive` policy plus `workflow_id` as the singleton key is what
      // makes "one Run of a Workflow at a time" true in the queue as well as in
      // the table.
      const instance = await getBoss()
      await instance.send(QUEUES.runExecute, { run_id: runId }, { singletonKey: workflowId })
    },
  }
}
