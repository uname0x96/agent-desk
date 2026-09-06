import type { AgentType, ListingResponse } from "@agent-desk/schemas"

/**
 * Story 3.5: the marketplace read model — the Reputation label, the pause
 * reason, the Type filter and the two sort orders. Pure, so the ordering can
 * be tested over fixture rows without a database or a browser.
 *
 * ┌─ AD-2 / AD-9 ──────────────────────────────────────────────────────────┐
 * │ Nothing here computes a number. Price, Stake and `reputation_bps` are  │
 * │ the Registry's own values, carried by `GET /api/listings` from the     │
 * │ chain-owned columns; the scored-Call count is the AD-9 settlement      │
 * │ count. This module only decides what to call them and in what order to │
 * │ show them, so a card and the Registry can never disagree.              │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * This is deliberately the *only* implementation of the ordering. Story 3.5
 * requires `GET /api/listings?type=&sort=` to apply the same order server-side;
 * `apps/web/app/api/listings/route.ts` is owned by another story, so it is
 * expected to import `compareListings` and `filterByType` from here rather
 * than grow a second copy of the rule.
 */

export const MARKETPLACE_SORTS = ["reputation", "price"] as const
export type MarketplaceSort = (typeof MARKETPLACE_SORTS)[number]

/** Reputation is what the pitch rests on, so it is what the page opens on. */
export const DEFAULT_SORT: MarketplaceSort = "reputation"

/** AD-9 settles `research` and `risk` Calls only; no other Type has a score. */
export const SCORED_TYPES: readonly AgentType[] = ["research", "risk"]

export const NO_SCORE_YET = "no score yet"
export const NOT_SCORED_IN_MVP = "not scored in MVP"

// ------------------------------------------------------------- reputation

export type ReputationKind = "scored" | "unscored" | "not_scored_in_mvp"

export interface ReputationLabel {
  kind: ReputationKind
  /** What the card prints large: "83%", "no score yet", "not scored in MVP". */
  text: string
  /** The line under it. Always present, so cards keep one height. */
  detail: string
  /** Basis points, or null when there is no percentage to rank on. */
  bps: number | null
  scoredCallCount: number
}

/**
 * A zero would read as "this Agent failed every Call", which is a different
 * claim from "nobody has scored it yet". An Agent with no settled Call says so.
 */
export function reputationLabel(listing: ListingResponse): ReputationLabel {
  const scoredCallCount = listing.scored_call_count

  if (!SCORED_TYPES.includes(listing.type)) {
    return {
      kind: "not_scored_in_mvp",
      text: NOT_SCORED_IN_MVP,
      detail: "only research and risk Calls are settled",
      bps: null,
      scoredCallCount,
    }
  }

  if (scoredCallCount < 1 || listing.reputation_bps === null) {
    return {
      kind: "unscored",
      text: NO_SCORE_YET,
      detail: "no Call of this Agent has been settled",
      bps: null,
      scoredCallCount,
    }
  }

  return {
    kind: "scored",
    text: `${formatBps(listing.reputation_bps)}%`,
    detail: `over ${scoredCallCount} scored ${scoredCallCount === 1 ? "Call" : "Calls"}`,
    bps: listing.reputation_bps,
    scoredCallCount,
  }
}

/** 10000 bps -> "100", 6667 bps -> "67". Sorting uses the bps, never this. */
function formatBps(bps: number): string {
  return String(Math.round(bps / 100))
}

// ----------------------------------------------------------------- status

export type StatusTone = "ok" | "warn" | "idle"

export interface ListingStatusLabel {
  /** "active", "paused (creator)", "paused (stake)". */
  text: string
  tone: StatusTone
  /** A sentence for the card, or null while the Listing is `active`. */
  reason: string | null
  /**
   * FR-8: a paused Listing is visible but cannot be chosen. The Workflow
   * Builder's Provider picker reads this to disable its select action.
   */
  selectable: boolean
}

export function listingStatusLabel(listing: ListingResponse): ListingStatusLabel {
  if (listing.status === "active") {
    return { text: "active", tone: "ok", reason: null, selectable: true }
  }

  const reasons: string[] = []
  if (listing.paused_by_creator) reasons.push("creator")
  if (listing.paused_by_stake) reasons.push("stake")

  return {
    text: reasons.length === 0 ? "paused" : `paused (${reasons.join(" and ")})`,
    tone: "warn",
    reason: pauseSentence(listing),
    selectable: false,
  }
}

function pauseSentence(listing: ListingResponse): string {
  if (listing.paused_by_stake && listing.paused_by_creator) {
    return "Paused by its creator, and its Stake is below ten times its price."
  }
  if (listing.paused_by_stake) {
    return "Paused: its Stake fell below ten times its price. Cannot be selected until it is topped up."
  }
  if (listing.paused_by_creator) {
    return "Paused by its creator. Cannot be selected for a new Run."
  }
  return "Paused. Cannot be selected for a new Run."
}

// ------------------------------------------------------- filter and order

export function parseSort(value: string | null | undefined): MarketplaceSort {
  return (MARKETPLACE_SORTS as readonly string[]).includes(value ?? "")
    ? (value as MarketplaceSort)
    : DEFAULT_SORT
}

/** null means "every Type"; an unknown value is treated the same way. */
export function parseType(value: string | null | undefined): AgentType | null {
  return AGENT_TYPE_VALUES.includes(value ?? "") ? (value as AgentType) : null
}

const AGENT_TYPE_VALUES: readonly string[] = ["data", "research", "risk", "execution", "notify"]

export function filterByType(
  items: readonly ListingResponse[],
  type: AgentType | null,
): ListingResponse[] {
  return type === null ? [...items] : items.filter((listing) => listing.type === type)
}

const KIND_RANK: Record<ReputationKind, number> = {
  scored: 0,
  unscored: 1,
  not_scored_in_mvp: 2,
}

/**
 * Percentage descending, then "no score yet", then "not scored in MVP", with
 * the scored-Call count descending inside a tie. Price is not consulted here,
 * so this composes both ways round without recursing.
 */
function byReputation(a: ListingResponse, b: ListingResponse): number {
  const left = reputationLabel(a)
  const right = reputationLabel(b)

  const rank = KIND_RANK[left.kind] - KIND_RANK[right.kind]
  if (rank !== 0) return rank

  const bps = (right.bps ?? 0) - (left.bps ?? 0)
  if (bps !== 0) return bps

  return right.scoredCallCount - left.scoredCallCount
}

/** AD-13: prices are base-unit integer strings, so they compare as bigints. */
function byPrice(a: ListingResponse, b: ListingResponse): number {
  const left = BigInt(a.price)
  const right = BigInt(b.price)
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The last resort, so two identical Listings never swap places between polls.
 * Ids are ULIDs (AD-13), so descending is newest first — the order
 * `GET /api/listings` already returns.
 */
function byNewest(a: ListingResponse, b: ListingResponse): number {
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

export function compareListings(
  sort: MarketplaceSort,
): (a: ListingResponse, b: ListingResponse) => number {
  if (sort === "price") {
    return (a, b) => byPrice(a, b) || byReputation(a, b) || byNewest(a, b)
  }
  return (a, b) => byReputation(a, b) || byPrice(a, b) || byNewest(a, b)
}

export interface MarketplaceView {
  type: AgentType | null
  sort: MarketplaceSort
}

/** Filter then sort. `items` is never mutated. */
export function arrangeListings(
  items: readonly ListingResponse[],
  view: MarketplaceView,
): ListingResponse[] {
  return filterByType(items, view.type).sort(compareListings(view.sort))
}

// -------------------------------------------------------------- summaries

export function countByType(items: readonly ListingResponse[]): Record<AgentType, number> {
  const counts = { data: 0, research: 0, risk: 0, execution: 0, notify: 0 }
  for (const listing of items) counts[listing.type] += 1
  return counts
}

/** AD-13: base units never leave integer arithmetic. */
export function sumBaseUnits(values: readonly string[]): string {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString()
}
