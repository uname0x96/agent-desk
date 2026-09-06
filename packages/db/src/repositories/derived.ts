import {
  PAID_CALL_STATUSES,
  sumBaseUnits,
  type AgentType,
  type CallKind,
  type CallStatus,
  type RunStatus,
} from '@agent-desk/schemas'

/**
 * AD-3: derived amounts are queries, never counters. The three amounts the
 * signing policy needs — Daily Fee Budget spend, Stake reservation, and the
 * Platform Wallet's verification spend — are defined here once, as pure rules
 * over rows, so a route handler and the worker can never count different
 * statuses. `repositories/spend.ts` fetches the rows with the same constants
 * and hands them straight to these functions.
 *
 * AD-3 and AD-9, as reconciled by the team: the spend and reservation rules are
 * qualified to `kind = 'run'`. A `verification` Call is never scored, so it can
 * never release a reservation, and it is paid by the Platform Wallet against
 * `platform_settings.verification_cap_daily` rather than any account's Daily
 * Fee Budget.
 */

/** AD-9 scores these two Types and no others, so only they reserve Stake. */
export const SCORED_NODE_TYPES: readonly AgentType[] = ['research', 'risk']

/** AD-3: the Platform Wallet's verification spend is measured over 24 hours. */
export const VERIFICATION_WINDOW_MS = 24 * 60 * 60 * 1000

// ------------------------------------------------- Daily Fee Budget spend

export interface BudgetSpendRow {
  kind: CallKind
  status: CallStatus
  /** Base units. */
  locked_price: string
  /**
   * `calls.started_at`, or the Run's `created_at` while the Call is still
   * `pending` and has no clock of its own. `calls` carries exactly the AD-3
   * column set, so there is no `created_at` to fall back on.
   */
  at: Date
  /** The Call's Run status; null only for a `verification` Call. */
  run_status: RunStatus | null
}

/**
 * AD-3: the window starts at the later of UTC midnight and
 * `accounts.budget_window_start`, which an Operator reset moves to now.
 */
export function budgetWindowStart(accountWindowStart: Date | null, now: Date): Date {
  const midnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  if (!accountWindowStart) return midnight
  return accountWindowStart > midnight ? accountWindowStart : midnight
}

/**
 * Paid Calls, plus `pending` Calls of Runs still `running` — the reservation
 * that stops one account starting a Run it cannot finish paying for.
 */
export function countsTowardDailyFeeSpend(row: BudgetSpendRow, windowStart: Date): boolean {
  if (row.kind !== 'run') return false
  if (row.at < windowStart) return false
  if (PAID_CALL_STATUSES.includes(row.status)) return true
  return row.status === 'pending' && row.run_status === 'running'
}

export function dailyFeeSpend(rows: readonly BudgetSpendRow[], windowStart: Date): bigint {
  return sumBaseUnits(
    rows.filter((row) => countsTowardDailyFeeSpend(row, windowStart)).map((row) => row.locked_price),
  )
}

// ----------------------------------------------------- Stake reservation

export interface StakeReservationRow {
  kind: CallKind
  node_type: AgentType
  status: CallStatus
  /** Base units. */
  locked_price: string
  /** True once the Call has a `settlements` row, which releases the reservation. */
  settled: boolean
}

/**
 * FR-25: a Listing's Stake is reserved by its unscored paid `research` and
 * `risk` Calls. The Settlement row is what releases it, whatever the result.
 */
export function countsTowardStakeReservation(row: StakeReservationRow): boolean {
  if (row.kind !== 'run') return false
  if (!SCORED_NODE_TYPES.includes(row.node_type)) return false
  if (!PAID_CALL_STATUSES.includes(row.status)) return false
  return !row.settled
}

export function stakeReservation(rows: readonly StakeReservationRow[]): bigint {
  return sumBaseUnits(
    rows.filter(countsTowardStakeReservation).map((row) => row.locked_price),
  )
}

// -------------------------------------------------- Verification spend

export interface VerificationSpendRow {
  kind: CallKind
  status: CallStatus
  /** Base units. */
  locked_price: string
  /** `calls.started_at`: a verification Call belongs to no Run. */
  at: Date
}

/**
 * FR-11: the same rule as the budget spend over `kind = 'verification'` Calls
 * in the last 24 h. The `pending` clause of the budget rule is dropped because
 * it is conditioned on a Run still `running`, and a verification Call has none.
 */
export function countsTowardVerificationSpend(row: VerificationSpendRow, since: Date): boolean {
  if (row.kind !== 'verification') return false
  if (row.at < since) return false
  return PAID_CALL_STATUSES.includes(row.status)
}

export function verificationSpend(rows: readonly VerificationSpendRow[], since: Date): bigint {
  return sumBaseUnits(
    rows
      .filter((row) => countsTowardVerificationSpend(row, since))
      .map((row) => row.locked_price),
  )
}
