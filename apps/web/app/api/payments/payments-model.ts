import {
  PAYMENTS_PAGE_RUNS_DEFAULT,
  PAYMENTS_PAGE_RUNS_MAX,
  paymentsQuery,
  type AgentType,
  type CallStatus,
  type PaymentView,
  type PaymentsQuery,
  type PaymentsResponse,
} from '@agent-desk/schemas'

/**
 * The read model behind `GET /api/payments` (FR-40, Story 5.2).
 *
 * ┌─ AD-3 ─────────────────────────────────────────────────────────────────┐
 * │ There is no `payments` table, so nothing here is a counter or a new    │
 * │ record: a payment row *is* a Call row, projected. A Call belongs on    │
 * │ this page when it carries a `payment_payload`, because AD-5 writes     │
 * │ that column in the same transaction that signs the authorisation —     │
 * │ so "the engine signed money away for this Call" and "this column is    │
 * │ not null" are the same statement. A `price_mismatch` Call never got    │
 * │ that far and never appears; a `payment_failed` one did, and appears    │
 * │ without a tx hash.                                                     │
 * │                                                                        │
 * │ `kind = 'run'` only: a `verification` Call belongs to a Listing and is │
 * │ paid by the Platform Wallet, never by the Builder reading this page.   │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Everything in this module is pure, so the page shape and the cursor can be
 * tested over fixture rows without a database.
 */

/**
 * One Call, with the three values the join supplies: the Listing's name, the
 * Run's wallet address, and the id of the Settlement that scored it, if any.
 */
export interface PaymentRow {
  callId: string
  runId: string
  nodeIndex: number
  nodeType: AgentType
  status: CallStatus
  /** Base units, from the Price Lock (AD-13). */
  lockedPrice: string
  /** Lower-case, from the Price Lock. */
  lockedPayTo: string
  paymentTxHash: string | null
  startedAt: Date | null
  endedAt: Date | null
  /** `listings.name`. */
  provider: string
  /** `wallets.address` of the Run's wallet, lower-case. */
  from: string | null
  /** AD-9 scores a Call at most once, so this is one id at most. */
  settlementId: string | null
}

export function toPaymentView(row: PaymentRow): PaymentView {
  return {
    call_id: row.callId,
    run_id: row.runId,
    node_type: row.nodeType,
    provider: row.provider,
    amount: row.lockedPrice,
    from: row.from,
    to: row.lockedPayTo,
    status: row.status,
    payment_tx_hash: row.paymentTxHash,
    started_at: iso(row.startedAt),
    ended_at: iso(row.endedAt),
    settlement_id: row.settlementId,
  }
}

/**
 * Keyset pagination over the Run id, newest Run first.
 *
 * `runIds` is `limit + 1` ids so the caller can tell whether a next page exists
 * without a second count; the extra one is not served, and `rows` may safely
 * contain its Calls — they are dropped here. Inside a Run the order is Node
 * order, which is the order the money actually moved in.
 *
 * A page of Runs can legitimately produce no rows at all — a Run refused at its
 * first 402 paid nothing — while still having a `next`. A caller follows
 * `next`, not `items.length`.
 */
export function toPaymentsPage(
  runIds: readonly string[],
  rows: readonly PaymentRow[],
  limit: number,
): PaymentsResponse {
  const page = runIds.slice(0, limit)
  const rank = new Map(page.map((id, index) => [id, index]))

  const items = rows
    .filter((row) => rank.has(row.runId))
    .sort((left, right) => {
      const byRun = rank.get(left.runId)! - rank.get(right.runId)!
      return byRun !== 0 ? byRun : left.nodeIndex - right.nodeIndex
    })
    .map(toPaymentView)

  const hasMore = runIds.length > limit
  return { items, next: hasMore ? (page.at(-1) ?? null) : null }
}

/**
 * The query string, as values. Every `URLSearchParams` entry is `string | null`
 * and an absent one is indistinguishable from an empty one, so the defaulting
 * happens here and `paymentsQuery` checks the result — an out-of-range `limit`
 * is clamped rather than refused, because a page size is not something a
 * Builder can get wrong in a way worth a 400.
 */
export function parsePaymentsQuery(params: URLSearchParams): PaymentsQuery {
  return paymentsQuery.parse({
    run_id: blankToNull(params.get('run_id')),
    cursor: blankToNull(params.get('cursor')),
    limit: parsePageSize(params.get('limit')),
  })
}

export function parsePageSize(value: string | null): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return PAYMENTS_PAGE_RUNS_DEFAULT
  return Math.min(parsed, PAYMENTS_PAGE_RUNS_MAX)
}

function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length === 0 ? null : trimmed
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}
