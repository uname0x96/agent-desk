import type {
  AgentType,
  NotScoredReason,
  PlatformMode,
  SettlementResult,
  SettlementRow,
  SettlementsPage,
} from '@agent-desk/schemas'

/**
 * The read model behind `GET /api/settlements` (FR-41, Story 5.3), as pure
 * functions over rows.
 *
 * ┌─ AD-9 ─────────────────────────────────────────────────────────────────┐
 * │ One `settlements` row exists per scored Call, and a Call is scored only │
 * │ when it is `kind = 'run'` and its Node is `research` or `risk`. So this │
 * │ page is the settlements table itself; nothing here decides what was     │
 * │ scored or how — `packages/core/settlement` did that and the worker      │
 * │ wrote it down. This file only carries the row to the wire in the shapes │
 * │ AD-13 fixes: base-unit integer strings for money, lower-case addresses  │
 * │ and hashes, ISO 8601 UTC timestamps.                                    │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * The SQL lives next door in `query.ts`; keeping the mapping and the paging
 * here is what lets both be tested without a database.
 */

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 100

/**
 * One `settlements` row with the three fields its joins supply. The names are
 * drizzle's camelCase, because that is how the row arrives; `toSettlementRow`
 * is the single place it becomes the snake_case of the API (AD-14).
 */
export interface SettlementRecord {
  id: string
  callId: string
  listingId: string
  result: SettlementResult
  notScoredReason: NotScoredReason | null
  mode: PlatformMode
  ruleLabel: string
  priceSource: string
  startPrice: string | null
  endPrice: string | null
  change24hPct: number | null
  pFill: string | null
  windowMin: string | null
  windowMax: string | null
  scoredAt: Date
  slashAmount: string | null
  slashTxHash: string | null
  refundTo: string | null
  reputationTxHash: string | null
  // -- joined ---------------------------------------------------------------
  /** `calls.run_id`. Never null in practice: an unscorable Call has no row. */
  runId: string | null
  /** `calls.node_type`, so the page can say which Node this scored. */
  nodeType: AgentType
  /** `listings.name`, the Provider that served the Call. */
  provider: string
}

/**
 * AD-9 writes `rule_label` verbatim and the settlement view prints it verbatim,
 * so nothing on this path rewrites, shortens or re-cases it. The same holds for
 * `price_source`: AD-9 allows exactly one source and the row names it.
 */
export function toSettlementRow(record: SettlementRecord): SettlementRow {
  return {
    id: record.id,
    call_id: record.callId,
    listing_id: record.listingId,
    run_id: record.runId,
    node_type: record.nodeType,
    provider: record.provider,
    result: record.result,
    not_scored_reason: record.notScoredReason,
    mode: record.mode,
    rule_label: record.ruleLabel,
    price_source: record.priceSource,
    start_price: record.startPrice,
    end_price: record.endPrice,
    change_24h_pct: record.change24hPct,
    p_fill: record.pFill,
    window_min: record.windowMin,
    window_max: record.windowMax,
    scored_at: record.scoredAt.toISOString(),
    slash_amount: record.slashAmount,
    slash_tx_hash: lowerCase(record.slashTxHash),
    refund_to: lowerCase(record.refundTo),
    reputation_tx_hash: lowerCase(record.reputationTxHash),
  }
}

/**
 * Keyset pagination over the id, exactly as `GET /api/listings` does it.
 * Settlement ids are ULIDs (AD-13), whose first ten characters are the creation
 * time in base 32, so ordering by id descending is newest-scored first and a
 * cursor needs no second column.
 *
 * The caller fetches `limit + 1` rows; the extra one is what says whether a
 * next page exists, and it is not returned.
 */
export function toSettlementsPage(
  records: readonly SettlementRecord[],
  limit: number,
): SettlementsPage {
  const page = records.slice(0, limit)
  const hasMore = records.length > limit
  const last = page.at(-1)
  return {
    items: page.map(toSettlementRow),
    next: hasMore && last ? last.id : null,
  }
}

export function parsePageSize(value: string | null): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE
  return Math.min(parsed, MAX_PAGE_SIZE)
}

/** An empty `?run_id=` is no filter at all, not a filter on the empty string. */
export function parseFilterValue(value: string | null): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length === 0 ? null : trimmed
}

/** AD-13: addresses and hashes leave this system lower-case; the UI checksums them. */
function lowerCase(value: string | null): string | null {
  return value === null ? null : value.toLowerCase()
}
