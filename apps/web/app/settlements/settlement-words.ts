import type { NotScoredReason, SettlementRow } from "@agent-desk/schemas"

/**
 * The three decisions `/settlements` makes about a row, kept out of the
 * component so a test can enumerate them without a DOM.
 *
 * Two of them are wording. AD-9 stores `not_scored_reason` as one of three
 * machine values, and Story 5.3 requires the page to show the reason "in
 * words", so this file is the one place that translation happens — and it is
 * keyed by the reason type, which means a fourth reason added in
 * `packages/core/settlement` fails to compile here rather than rendering as a
 * blank cell.
 *
 * `rule_label` is deliberately absent: AD-9 stores it verbatim ("demo
 * settlement rule: 24h trend") precisely so that the view can print it without
 * a lookup, and a mapping here would be a second vocabulary that could drift
 * from the worker's.
 */

/** Story 5.3, verbatim: the three reasons AD-9 allows, in words. */
export const NOT_SCORED_WORDS: Readonly<Record<NotScoredReason, string>> = {
  reject_decision: "REJECT decision",
  no_fill: "no fill",
  no_reference_price: "no reference price",
}

/** Null for a scored row, which carries no reason (`settlements_not_scored_reason_present`). */
export function notScoredWords(reason: NotScoredReason | null): string | null {
  return reason === null ? null : NOT_SCORED_WORDS[reason]
}

/** Story 5.3, verbatim: what a `failed` row shows while its slash is in flight. */
export const SLASH_PENDING_LABEL = "slash pending"

/**
 * A `failed` row whose slash has not landed yet. This is the same condition the
 * worker's own tick uses to decide whether a row still needs slashing
 * (`apps/worker/src/jobs/settlement/tick.ts`: `result !== 'failed' ||
 * slashTxHash !== null` means "nothing to do"), so the page says "slash
 * pending" for exactly the rows the worker is still working on.
 *
 * `slash_amount`, `refund_to` and the tx hash are written in the same statement
 * from the `Slashed` event (AD-9), so the hash alone decides: there is no state
 * where the amount is known and the hash is not.
 */
export function isSlashPending(row: Pick<SettlementRow, "result" | "slash_tx_hash">): boolean {
  return row.result === "failed" && row.slash_tx_hash === null
}

/** Whether any row on the page is still waiting for its slash — the poll's reason to live. */
export function hasPendingSlash(
  rows: readonly Pick<SettlementRow, "result" | "slash_tx_hash">[],
): boolean {
  return rows.some(isSlashPending)
}
