import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb, type Database } from '@agent-desk/db'

/**
 * A database of this story's own, for the two sweep integration suites.
 *
 * Most integration files in this repository truncate one shared database and
 * take a session advisory lock so they take turns, and their hooks give up
 * waiting for it after 10 s. Story 2.8's `full-chain.integration.test.ts`
 * measured what that costs: a suite slow enough to hold the lock past ten
 * seconds makes the waiters time out, and a waiter that gives up truncates on
 * its way out, failing whichever file was mid-flight. These two suites are
 * exactly that shape — one starts pg-boss and runs its migration check, the
 * other waits on a real `setTimeout` loop — so they own a database instead,
 * created and migrated on demand, and take the shared lock never.
 *
 * Measured on this machine, back to back: with these two files sharing
 * `agentdesk_story16`, two of four full-suite runs were red in files this story
 * does not own; with them on their own database, none.
 */

const DATABASE_NAME = process.env.TEST_SWEEP_DATABASE_NAME ?? 'agentdesk_story29'
const ADMIN_DATABASE_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/postgres'

export const TEST_DATABASE_URL =
  process.env.TEST_SWEEP_DATABASE_URL ??
  `postgres://agentdesk:agentdesk@localhost:5432/${DATABASE_NAME}`

const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/db/drizzle',
)

/**
 * The two suites here still share this one database with each other, and vitest
 * runs files in parallel, so they take a lock — but their own, which nothing
 * else in the repository waits on.
 */
export const SWEEP_LOCK_KEY = 1_620_000_029

/**
 * Create the database if it is not there yet, then bring it up to the head
 * migration. Both connections are closed again: this repository's tests share
 * one Postgres, and a connection held for the length of a file is a connection
 * every other file cannot have.
 */
async function ensureDatabase(): Promise<void> {
  const admin = createDb({ url: ADMIN_DATABASE_URL, max: 1 })
  try {
    const existing = await admin.execute(
      sql`select 1 from pg_database where datname = ${DATABASE_NAME}`,
    )
    // `create database` cannot run inside a transaction or take a parameter, and
    // the name is this file's own constant rather than anything from a request.
    if (existing.length === 0) await admin.execute(sql.raw(`create database "${DATABASE_NAME}"`))
  } finally {
    await admin.$client.end()
  }
  const migrator = createDb({ url: TEST_DATABASE_URL, max: 1 })
  try {
    await migrate(migrator, { migrationsFolder: MIGRATIONS })
  } finally {
    await migrator.$client.end()
  }
}

/** Null when the suite can run; otherwise the reason it is skipped. */
export async function sweepDatabasePreflight(): Promise<string | null> {
  try {
    await ensureDatabase()
    return null
  } catch (error) {
    return `no usable database at ${TEST_DATABASE_URL}: ${(error as Error).message}`
  }
}

export function sweepTestDb(max = 4): Database {
  return createDb({ url: TEST_DATABASE_URL, max })
}

/**
 * `platform_settings.platform_account_id` references `accounts`, so a cascading
 * truncate takes the AD-10 single row with it; the migration's row is put back
 * verbatim afterwards.
 */
export async function resetSweepDatabase(db: Database): Promise<void> {
  await db.execute(sql`
    truncate chain_tx, settlements, calls, runs, workflow_nodes, workflows, listings, wallets, accounts
    restart identity cascade
  `)
  await db.execute(sql`
    insert into platform_settings (id, mode, emergency_stop, order_ceiling_usdt, default_daily_fee_budget, verification_cap_daily)
    values (1, 'production', false, '1000', '1000000', '5000000')
    on conflict (id) do update set
      mode = 'production',
      emergency_stop = false,
      platform_account_id = null
  `)
}
