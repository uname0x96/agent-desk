import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm'
import { PAID_CALL_STATUSES } from '@agent-desk/schemas'
import type { Database } from '../client.ts'
import { accounts, calls, runs, settlements } from '../schema.ts'
import {
  SCORED_NODE_TYPES,
  VERIFICATION_WINDOW_MS,
  budgetWindowStart,
  dailyFeeSpend,
  stakeReservation,
  verificationSpend,
  type BudgetSpendRow,
  type StakeReservationRow,
  type VerificationSpendRow,
} from './derived.ts'

/**
 * The three AD-3 derived amounts, as queries. Every one of them narrows in SQL
 * with the very constants the pure rules in `derived.ts` use, then re-applies
 * the rule in TypeScript, so the amount a caller gets is always the one the
 * unit tests pin down and there is no second definition to drift.
 *
 * Every function takes a `Queryable`, so the signing policy can run them inside
 * the same transaction that holds `SELECT ... FOR UPDATE` on the account row.
 */

/** A `Database` or a transaction handle from `db.transaction(...)`. */
export type Queryable = Pick<Database, 'select'>

const PAID = [...PAID_CALL_STATUSES]

/**
 * AD-3: `locked_price` of the account's `kind = 'run'` Calls in
 * `paid_awaiting_result`, `succeeded`, `failed_after_payment`, plus `pending`
 * Calls of Runs still `running`, since the later of UTC midnight and
 * `accounts.budget_window_start`. Returns base units.
 */
export async function dailyFeeSpendForAccount(
  conn: Queryable,
  accountId: string,
  now: Date = new Date(),
): Promise<bigint> {
  const [account] = await conn
    .select({ budgetWindowStart: accounts.budgetWindowStart })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)
  const windowStart = budgetWindowStart(account?.budgetWindowStart ?? null, now)

  const rows = await conn
    .select({
      kind: calls.kind,
      status: calls.status,
      locked_price: calls.lockedPrice,
      at: sql<Date>`coalesce(${calls.startedAt}, ${runs.createdAt})`.as('at'),
      run_status: runs.status,
    })
    .from(calls)
    .innerJoin(runs, eq(calls.runId, runs.id))
    .where(
      and(
        eq(calls.kind, 'run'),
        eq(runs.accountId, accountId),
        // A bare Date bound into a raw `sql` fragment misses Drizzle's column
        // encoder, so the bound value is an ISO string with an explicit cast.
        sql`coalesce(${calls.startedAt}, ${runs.createdAt}) >= ${windowStart.toISOString()}::timestamptz`,
        or(
          inArray(calls.status, PAID),
          and(eq(calls.status, 'pending'), eq(runs.status, 'running')),
        ),
      ),
    )

  return dailyFeeSpend(rows satisfies BudgetSpendRow[], windowStart)
}

/**
 * FR-25 / AD-3: `locked_price` of the Listing's `kind = 'run'` `research` and
 * `risk` Calls in `paid_awaiting_result`, `succeeded`, `failed_after_payment`
 * with no `settlements` row. Returns base units. The Listing's Stake itself
 * comes from the chain-owned `listings.stake` cache.
 */
export async function stakeReservationForListing(
  conn: Queryable,
  listingId: string,
): Promise<bigint> {
  const rows = await conn
    .select({
      kind: calls.kind,
      node_type: calls.nodeType,
      status: calls.status,
      locked_price: calls.lockedPrice,
      settled: sql<boolean>`${settlements.id} is not null`.as('settled'),
    })
    .from(calls)
    .leftJoin(settlements, eq(settlements.callId, calls.id))
    .where(
      and(
        eq(calls.listingId, listingId),
        eq(calls.kind, 'run'),
        inArray(calls.nodeType, [...SCORED_NODE_TYPES]),
        inArray(calls.status, PAID),
        isNull(settlements.id),
      ),
    )

  return stakeReservation(rows satisfies StakeReservationRow[])
}

/**
 * AD-3 / FR-11: the same rule over `kind = 'verification'` Calls in the last
 * 24 h, checked against `platform_settings.verification_cap_daily` before the
 * Platform Wallet signs. Returns base units.
 */
export async function verificationSpendLast24h(
  conn: Queryable,
  now: Date = new Date(),
): Promise<bigint> {
  const since = new Date(now.getTime() - VERIFICATION_WINDOW_MS)

  const rows = await conn
    .select({
      kind: calls.kind,
      status: calls.status,
      locked_price: calls.lockedPrice,
      at: calls.startedAt,
    })
    .from(calls)
    .where(
      and(
        eq(calls.kind, 'verification'),
        inArray(calls.status, PAID),
        gte(calls.startedAt, since),
      ),
    )

  // `started_at >= since` is NULL for a Call that never started, so Postgres has
  // already dropped those rows; the filter is what convinces TypeScript of it.
  const started = rows.filter(
    (row): row is typeof row & { at: Date } => row.at !== null,
  ) satisfies VerificationSpendRow[]

  return verificationSpend(started, since)
}
