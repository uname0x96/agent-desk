import { PgBoss } from 'pg-boss'
import { EXCLUSIVE_QUEUES, QUEUES } from '@agent-desk/schemas'

/**
 * AD-14 owns the queue names; this module owns their policies, so web, worker,
 * and scripts cannot disagree about them.
 *
 * `run.execute`, `wallet.create`, `listing.verify`, and `listing.write` are
 * `exclusive`: at most one job queued or active per singleton key, which is how
 * "one Run per Workflow" and "one wallet creation per account" hold even when a
 * caller publishes twice. `settlement.tick` is a plain queue, because it is a
 * targeted send for one Call and several may be in flight (AD-9).
 */

const EXCLUSIVE = new Set<string>(EXCLUSIVE_QUEUES)

/** Every queue this system uses, in creation order. */
export const ALL_QUEUES: readonly string[] = Object.values(QUEUES)

/**
 * Idempotent: pg-boss creates each queue with `on conflict do nothing`, so this
 * is safe to call at every boot of every process.
 */
export async function createQueues(boss: PgBoss): Promise<void> {
  for (const name of ALL_QUEUES) {
    await boss.createQueue(name, { policy: EXCLUSIVE.has(name) ? 'exclusive' : 'standard' })
  }
}

/** Starts pg-boss against `DATABASE_URL` and creates every queue. */
export async function startBoss(connectionString?: string): Promise<PgBoss> {
  const url = connectionString ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const boss = new PgBoss(url)
  await boss.start()
  await createQueues(boss)
  return boss
}
