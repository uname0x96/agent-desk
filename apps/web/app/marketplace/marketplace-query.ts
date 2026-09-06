import { keepPreviousData, type Query } from "@tanstack/react-query"
import { listingsResponse, type ListingResponse } from "@agent-desk/schemas"
import { apiFetch } from "../../lib/api.ts"
import { shouldKeepPolling } from "../../lib/run-polling.ts"
import {
  DEFAULT_SORT,
  parseSort,
  parseType,
  type MarketplaceView,
} from "../../components/marketplace/listing-model.ts"

/**
 * How the marketplace addresses its data and itself.
 *
 * AD-12: live views poll, nothing pushes. Story 3.5 asks for five seconds, so
 * a Listing that turns `active`, or a Reputation `refreshListingFromChain`
 * just wrote, is on the projector within five seconds of the receipt without
 * anyone touching the page.
 */

export const MARKETPLACE_POLL_MS = 5_000

/** `MAX_PAGE_SIZE` of `GET /api/listings`: one request covers the whole demo. */
export const MARKETPLACE_PAGE_SIZE = 100

export interface ListingsPage {
  items: ListingResponse[]
  next: string | null
}

/**
 * `?type=&sort=` are sent even though the route ignores them today, so the
 * page is already asking for the server-side order Story 3.5 requires; the
 * client applies the same comparator to whatever comes back, which makes the
 * two orders agree either way.
 */
export function listingsPath(view: MarketplaceView): string {
  const params = new URLSearchParams({ limit: String(MARKETPLACE_PAGE_SIZE), sort: view.sort })
  if (view.type !== null) params.set("type", view.type)
  return `/api/listings?${params.toString()}`
}

/** The `?type=&sort=` of the page URL, defaulted. An unknown value is ignored. */
export function parseView(type: string | null, sort: string | null): MarketplaceView {
  return { type: parseType(type), sort: parseSort(sort) }
}

/** The page's own URL, so a filtered marketplace can be linked and reloaded. */
export function marketplaceHref(view: MarketplaceView): string {
  const params = new URLSearchParams()
  if (view.type !== null) params.set("type", view.type)
  if (view.sort !== DEFAULT_SORT) params.set("sort", view.sort)
  const query = params.toString()
  return query.length === 0 ? "/marketplace" : `/marketplace?${query}`
}

export function marketplaceQueryKey(view: MarketplaceView): readonly unknown[] {
  return ["marketplace", view.type ?? "all", view.sort]
}

export type ListingsFetcher = (view: MarketplaceView, signal?: AbortSignal) => Promise<ListingsPage>

export const fetchListings: ListingsFetcher = (view, signal) =>
  apiFetch(listingsPath(view), listingsResponse, signal ? { signal } : {})

/** Shared by the page and its test, so both exercise the same policy. */
export function marketplaceQueryOptions(
  view: MarketplaceView,
  fetcher: ListingsFetcher = fetchListings,
) {
  return {
    queryKey: marketplaceQueryKey(view),
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetcher(view, signal),
    // An unreachable marketplace becomes reachable again when the worker or the
    // database comes back, so only a terminal refusal stops the beat.
    refetchInterval: (query: Query<ListingsPage>) =>
      query.state.error !== null && !shouldKeepPolling(query.state.error)
        ? (false as const)
        : MARKETPLACE_POLL_MS,
    refetchIntervalInBackground: false,
    // The 5 s beat is the retry. Stacking React Query's backoff on top of it
    // would only make the recovery from a blip slower and less predictable.
    retry: false as const,
    // Changing the filter keeps the current cards on screen instead of
    // flashing the skeleton, which on a projector reads as the page breaking.
    placeholderData: keepPreviousData,
    staleTime: 0,
  }
}
