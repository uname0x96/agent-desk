import {
  PAID_CALL_STATUSES,
  baseUnitsToString,
  sumBaseUnits,
  type PaymentView,
} from "@agent-desk/schemas"
import { SCORED_TYPES } from "../../components/marketplace/listing-model.ts"

/**
 * Story 5.2: the payments read model — the grouping by Run, the per-Run
 * subtotal, and the two words a row earns when the money did not behave.
 *
 * ┌─ AD-3 / AD-13 ─────────────────────────────────────────────────────────┐
 * │ Nothing here invents an amount. Every figure is `locked_price` from a  │
 * │ Call row, in base units, summed with `sumBaseUnits` so no float ever   │
 * │ touches money; the view formats the result as decimal tUSD.            │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Pure, so the grouping, the subtotal and the labels can be tested over
 * fixture rows without a database or a browser.
 */

/** The verbatim words the page prints; the tests assert on these, not on prose. */
export const NOT_SETTLED = "not settled"
export const NO_REFUND = "no refund"

// -------------------------------------------------------------- grouping

export interface RunPayments {
  runId: string
  items: PaymentView[]
  /**
   * Base units. Story 5.1's `total_cost` for the same Run: `locked_price`
   * summed over the Calls in `paid_awaiting_result`, `succeeded` and
   * `failed_after_payment`.
   */
  subtotal: string
  /** How many of the rows that subtotal is over, for the line under it. */
  paidCount: number
}

/**
 * One group per Run, in the order the route sent them — newest Run first, Node
 * order inside it. A `Map` is what keeps that order without re-sorting: the
 * route already paginates by Run, so a Run's rows are contiguous and complete.
 */
export function groupByRun(items: readonly PaymentView[]): RunPayments[] {
  const byRun = new Map<string, PaymentView[]>()
  for (const item of items) {
    // `run_id` is nullable on the wire because a `verification` Call has no
    // Run; this page never serves one, so a null would be a broken route
    // rather than a group of its own.
    if (item.run_id === null) continue
    const group = byRun.get(item.run_id)
    if (group) group.push(item)
    else byRun.set(item.run_id, [item])
  }

  return [...byRun].map(([runId, group]) => ({
    runId,
    items: group,
    subtotal: runSubtotal(group),
    paidCount: group.filter(isPaid).length,
  }))
}

/**
 * AD-3's paid statuses, and only those. A `payment_failed` row is on the page —
 * the Builder signed an authorisation for it — but it moved no money, so
 * counting it would make this page disagree with the Run's own `total_cost`
 * and with the Daily Fee Budget spend, which are the same three statuses.
 */
export function isPaid(item: PaymentView): boolean {
  return PAID_CALL_STATUSES.includes(item.status)
}

export function runSubtotal(items: readonly PaymentView[]): string {
  return baseUnitsToString(sumBaseUnits(items.filter(isPaid).map((item) => item.amount)))
}

/** The total across every group on the page, on the same rule. */
export function pageTotal(groups: readonly RunPayments[]): string {
  return baseUnitsToString(sumBaseUnits(groups.map((group) => group.subtotal)))
}

// ------------------------------------------------------------ tx hash cell

export type PaymentProof =
  /** Settled: `payment_tx_hash` is on chain and links to the explorer. */
  | { kind: "tx"; hash: string }
  /** AD-6: both paid attempts ended with the authorisation unused. */
  | { kind: "not_settled" }
  /** Signed and sent; the receipt has not come back yet. */
  | { kind: "awaiting" }

/**
 * AD-6: when both paid attempts end without a `PAYMENT-RESPONSE`, the engine
 * reads `authorizationState` and records `payment_failed` for an authorisation
 * that was never used. That row has no hash and never will, which is a
 * different thing from a hash that has not arrived yet — so it says so.
 */
export function paymentProof(item: PaymentView): PaymentProof {
  if (item.payment_tx_hash !== null) return { kind: "tx", hash: item.payment_tx_hash }
  return item.status === "payment_failed" ? { kind: "not_settled" } : { kind: "awaiting" }
}

// ------------------------------------------------------ refund / settlement

export type RefundNote =
  /**
   * AD-9 scores this Call, so the Builder can follow it to the Settlement that
   * decided whether the price came back. `pending` while the tick has not run.
   */
  | { kind: "settlement"; href: string; pending: boolean }
  /** FR-38: `data`, `execution` and `notify` Calls are paid but never scored. */
  | { kind: "no_refund" }
  | { kind: "none" }

/**
 * Story 5.3 owns `/settlements`; this is the only link into it. The Run id is
 * the filter that page reads, so the Builder lands on the Settlements of the
 * Run whose row they clicked.
 */
export function settlementsHref(runId: string): string {
  return `/settlements?run_id=${encodeURIComponent(runId)}`
}

/**
 * What a row can still expect of its money.
 *
 * A `research` or `risk` row points at its Settlement, which is where the
 * Slash and the Refund are (FR-35, FR-41). Every other Type is FR-38's
 * unscored set: a Call of theirs that failed *after* being paid took the
 * Builder's money and gives nothing back, and the page says the quiet part out
 * loud rather than leaving an empty cell.
 */
export function refundNote(item: PaymentView): RefundNote {
  if (SCORED_TYPES.includes(item.node_type)) {
    // AD-9 settles a Call once it reaches `succeeded` or
    // `failed_after_payment`; before that there is nothing to link to.
    if (item.settlement_id === null && !isScorable(item)) return { kind: "none" }
    return {
      kind: "settlement",
      href: settlementsHref(item.run_id ?? ""),
      pending: item.settlement_id === null,
    }
  }
  return item.status === "failed_after_payment" ? { kind: "no_refund" } : { kind: "none" }
}

function isScorable(item: PaymentView): boolean {
  return item.status === "succeeded" || item.status === "failed_after_payment"
}
