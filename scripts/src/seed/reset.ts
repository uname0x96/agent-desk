import { createInterface } from 'node:readline/promises'
import { eq } from 'drizzle-orm'
import { platformSettings, type Database } from '@agent-desk/db'
import { message } from '../checks.ts'
import { SEED_TABLES } from './fixtures.ts'

/**
 * `pnpm seed --reset` — Story 1.10: "truncates every table including
 * `chain_tx`, after an explicit confirmation".
 *
 * `chain_tx` is called out because it is the one table whose rows stand for
 * something outside the database: dropping an intent key does not undo the
 * transaction it names, so a reset means the next seed sends a *new* identity,
 * a *new* listing and new mints. That is the point — a reset is for starting
 * the demo over, not for repairing one — but it is also why this asks first.
 *
 * `platform_settings` is truncated with the rest, because `platform_account_id`
 * references `accounts`, and then row 1 is put back exactly as it was apart
 * from the two columns the seed and the worker own. An Operator's `mode`,
 * `emergency_stop`, ceiling and budgets survive a reset; there is no migration
 * to re-run to get them back.
 */

export const RESET_CONFIRMATION = 'reset'

export async function confirmReset(databaseUrl: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    process.stdout.write(
      `\nThis truncates every table in ${redact(databaseUrl)}, including chain_tx.\n` +
        'Transactions already on chain are not undone; the next seed sends new ones.\n',
    )
    const answer = await rl.question(`Type "${RESET_CONFIRMATION}" to continue: `)
    return answer.trim() === RESET_CONFIRMATION
  } finally {
    rl.close()
  }
}

export async function resetDatabase(db: Database, log: (line: string) => void): Promise<void> {
  const [before] = await db.select().from(platformSettings).where(eq(platformSettings.id, 1)).limit(1)
  if (!before) throw new Error('platform_settings row 1 is missing; run the migrations')

  await db.execute(`truncate table ${[...SEED_TABLES, 'platform_settings'].join(', ')} cascade`)
  await db.insert(platformSettings).values({
    id: 1,
    mode: before.mode,
    emergencyStop: before.emergencyStop,
    orderCeilingUsdt: before.orderCeilingUsdt,
    defaultDailyFeeBudget: before.defaultDailyFeeBudget,
    verificationCapDaily: before.verificationCapDaily,
    // The two the seed and the worker own; everything else is the Operator's.
    platformAccountId: null,
    workerSeenAt: null,
  })
  log(`reset              truncated ${SEED_TABLES.length + 1} tables, platform_settings row 1 restored`)

  // A queued `listing.verify` for a Listing that no longer exists would fail on
  // every delivery until pg-boss gave up. Dropping the jobs with the rows keeps
  // the two halves of the reset consistent. `pgboss.job` is partitioned per
  // queue and `job_dependency` points at it, so this is `cascade`; pg-boss
  // recreates the queues at the next `startBoss`.
  try {
    await db.execute('truncate table pgboss.job cascade')
    log('reset              pgboss.job truncated')
  } catch (error) {
    // pg-boss may not have been started against this database yet, which is not
    // a reason to abandon a reset that has already emptied every domain table.
    log(`reset              pgboss.job was not truncated: ${message(error)}`)
  }

  // `apps/worker` resolves the Platform Wallet's id once, at boot. A reset gives
  // it a new one, so the worker is holding an id that no longer exists.
  log('reset              restart the worker: it caches the Platform Wallet id at boot')
}

/** A connection string is printed back to the operator; the password is not. */
function redact(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl)
    if (url.password) url.password = '***'
    return url.toString()
  } catch {
    return databaseUrl
  }
}
