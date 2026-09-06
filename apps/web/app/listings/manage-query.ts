import type { Query } from "@tanstack/react-query"
import { intentAccepted } from "@agent-desk/schemas"
import {
  hasPendingIntent,
  type ManageHistoryRow,
} from "../api/listings/manage-history.ts"
import {
  isListingSettled,
  listingDetailResponse,
  type ListingDetailResponse,
} from "../api/listings/listing-progress.ts"
import { apiFetch } from "../../lib/api.ts"
import { POLL_INTERVAL_MS, shouldKeepPolling } from "../../lib/run-polling.ts"
import { fetchListing, listingQueryKey, type ListingFetcher } from "./listing-query.ts"

/**
 * How the manage page addresses its data (Story 3.6, AD-12).
 *
 * The same two-second beat the listing page keeps, and the same query key, so
 * the two pages share one cache entry: a Creator who submits a price change and
 * then walks to `/listings/<id>` sees the transaction they just made rather than
 * a second copy of the row fetched a moment earlier.
 *
 * The page polls while a `chain_tx` row of this Listing is `pending` — which is
 * exactly "an intent of mine is in flight" — and stops when none is.
 */

export const MANAGE_POLL_MS = POLL_INTERVAL_MS

/** 2 000 while a transaction can still move, `false` once none can. */
export function manageRefetchInterval(listing: ListingDetailResponse | undefined): number | false {
  if (listing === undefined) return MANAGE_POLL_MS
  if (!isListingSettled(listing.status)) return MANAGE_POLL_MS
  return hasPendingIntent(listing.chain_tx) ? MANAGE_POLL_MS : false
}

/** Shared by the page and its test, so both exercise the same policy. */
export function manageQueryOptions(listingId: string, fetcher: ListingFetcher = fetchListing) {
  return {
    queryKey: listingQueryKey(listingId),
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetcher(listingId, signal),
    refetchInterval: (query: Query<ListingDetailResponse>) =>
      query.state.error !== null && !shouldKeepPolling(query.state.error)
        ? (false as const)
        : manageRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
    retry: (_failureCount: number, error: unknown) => shouldKeepPolling(error),
    staleTime: 0,
  }
}

// ------------------------------------------------------------------ writes

/** The 202 body of the three manage routes: the AD-8 key of the transaction. */
export type IntentKey = string

const path = (listingId: string, action: string) =>
  `/api/listings/${encodeURIComponent(listingId)}/${action}`

/** FR-9. Decimal tUSD, exactly as the listing form sends a price. */
export function setPrice(listingId: string, price: string): Promise<IntentKey> {
  return post(path(listingId, "price"), { price })
}

/** FR-7. Decimal tUSD, the amount to add — not the new total. */
export function addStake(listingId: string, amount: string): Promise<IntentKey> {
  return post(path(listingId, "stake"), { amount })
}

/** FR-8. The Creator's own pause flag; the Stake pause is the contract's. */
export function setPaused(listingId: string, paused: boolean): Promise<IntentKey> {
  return post(path(listingId, "pause"), { paused })
}

async function post(url: string, body: unknown): Promise<IntentKey> {
  const accepted = await apiFetch(url, intentAccepted, { method: "POST", body })
  return accepted.intent_key
}

/**
 * AD-2's second caller of `refreshListingFromChain`. It answers the refreshed
 * Listing in the shape the page already holds, so the result replaces the query
 * cache entry rather than triggering another fetch.
 */
export function refreshFromChain(listingId: string): Promise<ListingDetailResponse> {
  return apiFetch(path(listingId, "refresh"), listingDetailResponse, { method: "POST" })
}

export function manageHref(listingId: string): string {
  return `/listings/${encodeURIComponent(listingId)}/manage`
}

export type { ManageHistoryRow }
