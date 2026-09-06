import {
  PAID_CALL_STATUSES,
  TERMINAL_CALL_STATUSES,
  isRunTerminal,
  baseUnitsToString,
  sumBaseUnits,
  type CallStatus,
  type CallView,
  type RunResponse,
  type SkipReason,
} from '@agent-desk/schemas'
import { formatDuration } from '../../lib/format.ts'

/**
 * FR-43, the demo split view: the agent log on the left, the money flow on the
 * right, both derived from the one `GET /api/runs/<id>` body the page polls
 * every 2 s (AD-12).
 *
 * Every decision the two panes make lives here as a pure function of that body
 * and a clock: which Calls appear and in what order, how long each one took,
 * which arrows are drawn and in which direction, what they are labelled with,
 * and what the running totals are. The components below `split/` only render
 * what this module returns, so the rules are testable without a browser and
 * the view that a judge watches cannot disagree with them.
 *
 * Amounts stay base-unit integer strings all the way through (AD-13); the
 * decimal `tUSD` rendering happens once, in the components, through
 * `lib/format.ts`.
 */

const PAID = new Set<CallStatus>(PAID_CALL_STATUSES)
const TERMINAL = new Set<CallStatus>(TERMINAL_CALL_STATUSES)

/** What the Builder's own wallet is called on both panes. */
export const BUILDER_LABEL = 'Builder wallet'

// ------------------------------------------------------------------ ordering

/**
 * Node order, not arrival order. `GET /api/runs/<id>` already sorts by
 * `node_index`, but the pane must not depend on that: a Call the engine has
 * not reached yet still has its place in the chain, and the demo reads the
 * left pane top to bottom as the pipeline.
 *
 * A Call without a `node_index` (a `verification` Call, AD-3) has no place in
 * the chain, so it sorts last. Ties break on the id, which is a ULID and so
 * already in creation order.
 */
export function orderCalls(calls: readonly CallView[]): CallView[] {
  return [...calls].sort((left, right) => {
    const leftIndex = left.node_index ?? Number.MAX_SAFE_INTEGER
    const rightIndex = right.node_index ?? Number.MAX_SAFE_INTEGER
    if (leftIndex !== rightIndex) return leftIndex - rightIndex
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/** 1-based position in the chain: `node_index + 1`, or the row's own ordinal. */
export function callPosition(call: CallView, ordinal: number): number {
  return call.node_index === null ? ordinal + 1 : call.node_index + 1
}

// ------------------------------------------------------------------- elapsed

export interface Elapsed {
  /** "1.8 s", "412 ms", or "—" when the Call has not started. */
  label: string
  /** True while the clock is still running, so the view keeps re-rendering it. */
  live: boolean
}

/**
 * How long a Call took, or how long it has been taking. A Call that has
 * started and not yet ended is measured against `now`, which is why the clock
 * is an argument: the pane ticks it once a second and the test passes a fixed
 * instant.
 *
 * A terminal Call with no `ended_at` is never shown as still running — that is
 * a Call the engine resolved without a timestamp, not a Call in flight.
 */
export function callElapsed(call: CallView, now: Date): Elapsed {
  if (call.started_at === null) return { label: '—', live: false }
  if (call.ended_at !== null) {
    return { label: formatDuration(call.started_at, call.ended_at), live: false }
  }
  if (TERMINAL.has(call.status)) return { label: '—', live: false }
  return { label: formatDuration(call.started_at, now.toISOString()), live: true }
}

// ------------------------------------------------------------------ left pane

export interface CallLogRow {
  call_id: string
  /** 1-based position in the chain. */
  position: number
  /** "2. research", the same label the live Run view uses. */
  node_label: string
  node_type: string
  provider: string
  status: CallStatus
  /** `locked_price` in base units (AD-13). */
  amount: string
  elapsed: Elapsed
  request: unknown
  response: unknown
  has_request: boolean
  has_response: boolean
  /** False while both payloads are still empty, so there is nothing to expand. */
  expandable: boolean
  failure_reason: string | null
  skip_reason: SkipReason | null
  paid: boolean
  payment_tx_hash: string | null
}

/**
 * One row per Call, in Node order. Rows append as the engine advances because
 * `POST /api/runs` inserts every Call up front (AD-4): a Node the engine has
 * not reached is already here as `pending`, and the poll fills it in.
 */
export function buildCallLog(run: RunResponse, now: Date): CallLogRow[] {
  return orderCalls(run.calls).map((call, ordinal) => {
    const position = callPosition(call, ordinal)
    const hasRequest = call.request !== null && call.request !== undefined
    const hasResponse = call.response !== null && call.response !== undefined
    return {
      call_id: call.id,
      position,
      node_label: `${position}. ${call.node_type}`,
      node_type: call.node_type,
      provider: call.provider,
      status: call.status,
      amount: call.locked_price,
      elapsed: callElapsed(call, now),
      request: call.request ?? null,
      response: call.response ?? null,
      has_request: hasRequest,
      has_response: hasResponse,
      expandable: hasRequest || hasResponse,
      failure_reason: call.failure_reason,
      skip_reason: call.skip_reason,
      paid: isPaidCall(call),
      payment_tx_hash: call.payment_tx_hash,
    }
  })
}

/** AD-3: these three statuses are the ones whose money has left the wallet. */
export function isPaidCall(call: CallView): boolean {
  return PAID.has(call.status)
}

// ----------------------------------------------------------------- right pane

export type ArrowKind = 'payment' | 'refund'

export interface ArrowEndpoint {
  label: string
  /** Null when the party is not a wallet — see the Refund note below. */
  address: string | null
}

export interface MoneyArrow {
  id: string
  kind: ArrowKind
  call_id: string
  position: number
  node_label: string
  provider: string
  from: ArrowEndpoint
  to: ArrowEndpoint
  /** Base units (AD-13). */
  amount: string
  /**
   * False when the amount is what the platform intends to move rather than
   * what the chain has confirmed: a Refund before its `Slashed` event is read.
   */
  amount_confirmed: boolean
  tx_hash: string | null
  /** True while the transaction has not produced a hash yet. */
  pending: boolean
}

/**
 * The money flow of the Run, in Node order: one outward arrow per paid Call,
 * and, for a scored Call whose Settlement failed, one arrow back.
 *
 * A Call in `paid_awaiting_result` already has its arrow. The authorisation is
 * signed and persisted before the paid request goes out (AD-5), so the money
 * is committed at that moment; waiting for `succeeded` would hide the payment
 * for exactly the seconds the demo is watching it.
 */
export function moneyArrows(run: RunResponse): MoneyArrow[] {
  return orderCalls(run.calls).flatMap((call, ordinal) => {
    const position = callPosition(call, ordinal)
    const arrows: MoneyArrow[] = []
    const payment = paymentArrow(run, call, position)
    if (payment) arrows.push(payment)
    const refund = refundArrow(run, call, position)
    if (refund) arrows.push(refund)
    return arrows
  })
}

/** Builder System Wallet → the Listing's payout wallet, for the locked price. */
export function paymentArrow(
  run: RunResponse,
  call: CallView,
  position: number,
): MoneyArrow | null {
  if (!isPaidCall(call)) return null
  return {
    id: `payment:${call.id}`,
    kind: 'payment',
    call_id: call.id,
    position,
    node_label: `${position}. ${call.node_type}`,
    provider: call.provider,
    from: { label: BUILDER_LABEL, address: run.wallet_address },
    to: { label: call.provider, address: call.locked_pay_to },
    amount: call.locked_price,
    amount_confirmed: true,
    tx_hash: call.payment_tx_hash,
    pending: call.payment_tx_hash === null,
  }
}

/**
 * The Refund, drawn only for a scored Call whose Settlement failed (FR-35).
 * `passed`, `not_scored`, and an unscored Type move no money back, so they get
 * no second arrow.
 *
 * The tUSD comes out of the Agent's Stake held by `AgentDeskRegistry`, not out
 * of its payout wallet, so the source endpoint carries no address; naming the
 * payout wallet there would claim a transfer that never happened. Until the
 * `Slashed` event is read the amount shown is the Call's locked price, which
 * is what FR-35 slashes, flagged as not yet confirmed because the contract
 * clamps it to the remaining Stake.
 */
export function refundArrow(
  run: RunResponse,
  call: CallView,
  position: number,
): MoneyArrow | null {
  const settlement = call.settlement
  if (!settlement || settlement.result !== 'failed') return null
  return {
    id: `refund:${call.id}`,
    kind: 'refund',
    call_id: call.id,
    position,
    node_label: `${position}. ${call.node_type}`,
    provider: call.provider,
    from: { label: `${call.provider} Stake`, address: null },
    to: { label: BUILDER_LABEL, address: settlement.refund_to ?? run.wallet_address },
    amount: settlement.slash_amount ?? call.locked_price,
    amount_confirmed: settlement.slash_amount !== null,
    tx_hash: settlement.slash_tx_hash,
    pending: settlement.slash_tx_hash === null,
  }
}

export interface MoneyTotals {
  /** Base units (AD-13). */
  paid: string
  refunded: string
  /** What the Run has cost the Builder so far: paid minus refunded. */
  net: string
  payment_count: number
  refund_count: number
}

/**
 * The running totals under the arrows. `paid` is the same sum as the Run's
 * `total_cost` — both are `locked_price` over the AD-3 paid statuses — so the
 * split view and the live Run view never show two different numbers.
 */
export function moneyTotals(arrows: readonly MoneyArrow[]): MoneyTotals {
  const payments = arrows.filter((arrow) => arrow.kind === 'payment')
  const refunds = arrows.filter((arrow) => arrow.kind === 'refund')
  const paid = sumBaseUnits(payments.map((arrow) => arrow.amount))
  const refunded = sumBaseUnits(refunds.map((arrow) => arrow.amount))
  return {
    paid: baseUnitsToString(paid),
    refunded: baseUnitsToString(refunded),
    // A Slash is clamped to the Call's locked price, so this cannot go
    // negative; the guard is here so a surprise renders as zero rather than
    // throwing the pane away mid-demo.
    net: baseUnitsToString(paid > refunded ? paid - refunded : 0n),
    payment_count: payments.length,
    refund_count: refunds.length,
  }
}

// ------------------------------------------------------------- expanded rows

/**
 * FR-43: the request and response JSON is collapsed by default and expandable.
 * The set of open rows is held by the pane and moved through these two
 * functions, so a row the poll has just appended is never open by accident and
 * a row the Builder opened stays open across polls.
 */
export const NO_ROWS_EXPANDED: ReadonlySet<string> = new Set<string>()

export function isRowExpanded(expanded: ReadonlySet<string>, callId: string): boolean {
  return expanded.has(callId)
}

export function toggleRow(expanded: ReadonlySet<string>, callId: string): ReadonlySet<string> {
  const next = new Set(expanded)
  if (!next.delete(callId)) next.add(callId)
  return next
}

// ------------------------------------------------------------- the whole view

export interface SplitViewModel {
  run_id: string
  workflow_name: string
  symbol: string
  status: string
  failure_reason: string | null
  builder_wallet: string | null
  /** True while the Run is `running`, which is also what keeps the poll alive. */
  live: boolean
  calls: CallLogRow[]
  arrows: MoneyArrow[]
  totals: MoneyTotals
}

export function buildSplitViewModel(run: RunResponse, now: Date): SplitViewModel {
  const arrows = moneyArrows(run)
  return {
    run_id: run.id,
    workflow_name: run.workflow_name,
    symbol: run.symbol,
    status: run.status,
    failure_reason: run.failure_reason,
    builder_wallet: run.wallet_address,
    live: !isRunTerminal(run.status),
    calls: buildCallLog(run, now),
    arrows,
    totals: moneyTotals(arrows),
  }
}
