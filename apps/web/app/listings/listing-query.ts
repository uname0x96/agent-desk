import type { Query } from "@tanstack/react-query"
import type { CreateListingRequest } from "@agent-desk/schemas"
import {
  createListingResponse,
  isListingSettled,
  listingDetailResponse,
  type ListingDetailResponse,
} from "../api/listings/listing-progress.ts"
import { apiFetch } from "../../lib/api.ts"
import { POLL_INTERVAL_MS, shouldKeepPolling } from "../../lib/run-polling.ts"

/**
 * How the listing page addresses its data (AD-12).
 *
 * A Listing is refetched every two seconds while it is `verifying` and not once
 * it is not, so each step of the pipeline is on screen within two seconds of
 * landing and a finished Listing costs nothing to leave open on a projector.
 * Two seconds is the same beat the live Run view keeps, and the constant is
 * imported from it rather than repeated.
 */

export const LISTING_POLL_MS = POLL_INTERVAL_MS

export function listingQueryKey(listingId: string): readonly unknown[] {
  return ["listing", listingId]
}

export type ListingFetcher = (
  listingId: string,
  signal?: AbortSignal,
) => Promise<ListingDetailResponse>

export const fetchListing: ListingFetcher = (listingId, signal) =>
  apiFetch(
    `/api/listings/${encodeURIComponent(listingId)}`,
    listingDetailResponse,
    signal ? { signal } : {},
  )

/** 2 000 while the pipeline can still move it, `false` once it cannot. */
export function listingRefetchInterval(
  listing: ListingDetailResponse | undefined,
): number | false {
  if (listing === undefined) return LISTING_POLL_MS
  return isListingSettled(listing.status) ? false : LISTING_POLL_MS
}

/** Shared by the page and its test, so both exercise the same policy. */
export function listingQueryOptions(listingId: string, fetcher: ListingFetcher = fetchListing) {
  return {
    queryKey: listingQueryKey(listingId),
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetcher(listingId, signal),
    refetchInterval: (query: Query<ListingDetailResponse>) =>
      query.state.error !== null && !shouldKeepPolling(query.state.error)
        ? (false as const)
        : listingRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
    retry: (_failureCount: number, error: unknown) => shouldKeepPolling(error),
    staleTime: 0,
  }
}

/** `POST /api/listings`. The 201 carries the id the Creator is about to watch. */
export async function submitListing(body: CreateListingRequest): Promise<string> {
  const created = await apiFetch("/api/listings", createListingResponse, {
    method: "POST",
    body,
  })
  return created.listing_id
}

/** FR-12: the failed Listing this form is a second attempt at. */
export function resubmitHref(listingId: string): string {
  return `/listings/new?from=${encodeURIComponent(listingId)}`
}
