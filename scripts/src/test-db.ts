import { sql } from 'drizzle-orm'
import { createDb, type Database } from '@agent-desk/db'

/**
 * Shared setup for the integration tests in this package.
 *
 * Vitest runs test files in parallel, and every one of these truncates the same
 * tables, so they take a session-level advisory lock and run one after another.
 * The lock is held on a connection of its own because a pooled query could
 * release it from a different backend than the one that took it.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/agentdesk_story16'

/** Any constant; it only has to be the same in every file that truncates. */
const LOCK_KEY = 1_620_000_016

export async function databaseReachable(): Promise<boolean> {
  try {
    const probe = createDb({ url: TEST_DATABASE_URL, max: 1 })
    await probe.execute(sql`select 1`)
    return true
  } catch {
    return false
  }
}

export function testDb(): Database {
  return createDb({ url: TEST_DATABASE_URL, max: 4 })
}

/** Held for the length of one test file. */
export function databaseLock() {
  const holder = createDb({ url: TEST_DATABASE_URL, max: 1 })
  return {
    acquire: async () => {
      await holder.execute(sql`select pg_advisory_lock(${LOCK_KEY})`)
    },
    release: async () => {
      await holder.execute(sql`select pg_advisory_unlock(${LOCK_KEY})`)
    },
  }
}

/**
 * `platform_settings.platform_account_id` references `accounts`, so a cascading
 * truncate takes the AD-10 single row with it; the migration's row is put back
 * verbatim afterwards.
 */
export async function resetDatabase(db: Database): Promise<void> {
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
      order_ceiling_usdt = '1000',
      default_daily_fee_budget = '1000000',
      verification_cap_daily = '5000000',
      platform_account_id = null
  `)
}
