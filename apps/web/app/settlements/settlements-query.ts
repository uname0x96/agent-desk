import { keepPreviousData, type Query } from "@tanstack/react-query"
import { settlementsResponse, type SettlementsPage } from "@agent-desk/schemas"
import { apiFetch } from "../../lib/api.ts"
import { shouldKeepPolling } from "../../lib/run-polling.ts"
import { hasPendingSlash } from "./settlement-words.ts"

/**
 * How `/settlements` addresses its data and itself.
 *
 * AD-12: live views poll, nothing pushes. Story 5.3 fixes both the beat and the
 * reason for it — 2 s "until every visible `failed` row has a `slash_tx_hash`".
 * A slash is one chain transaction the worker sends after it writes the row, so
 * the only thing on this page that changes by itself is a pending slash landing
 * with its Refund; once none is pending there is nothing left to wait for and
 * the page stops asking. That is the whole stop condition, and it is
 * `hasPendingSlash` over the rows actually on screen.
 */

export const SETTLEMENTS_POLL_MS = 2_000

/** One page covers the whole demo, so the cursor is only ever a safety net. */
export const SETTLEMENTS_PAGE_SIZE = 100

/** `?run_id=&listing_id=` — the two filters the route takes, as the page holds them. */
export interface SettlementsFilter {
  runId: string | null
  listingId: string | null
}

export const NO_FILTER: SettlementsFilter = { runId: null, listingId: null }

export function settlementsPath(filter: SettlementsFilter, cursor: string | null = null): string {
  const params = new URLSearchParams({ limit: String(SETTLEMENTS_PAGE_SIZE) })
  if (filter.runId !== null) params.set("run_id", filter.runId)
  if (filter.listingId !== null) params.set("listing_id", filter.listingId)
  if (cursor !== null) params.set("cursor", cursor)
  return `/api/settlements?${params.toString()}`
}

/** The `?run_id=&listing_id=` of the page URL. An empty value is no filter. */
export function parseFilter(runId: string | null, listingId: string | null): SettlementsFilter {
  return { runId: trimmed(runId), listingId: trimmed(listingId) }
}

/** The page's own URL, so a filtered settlement list can be linked and reloaded. */
export function settlementsHref(filter: SettlementsFilter): string {
  const params = new URLSearchParams()
  if (filter.runId !== null) params.set("run_id", filter.runId)
  if (filter.listingId !== null) params.set("listing_id", filter.listingId)
  const query = params.toString()
  return query.length === 0 ? "/settlements" : `/settlements?${query}`
}

export function settlementsQueryKey(filter: SettlementsFilter): readonly unknown[] {
  return ["settlements", filter.runId ?? "all", filter.listingId ?? "all"]
}

export type SettlementsFetcher = (
  filter: SettlementsFilter,
  signal?: AbortSignal,
) => Promise<SettlementsPage>

export const fetchSettlements: SettlementsFetcher = (filter, signal) =>
  apiFetch(settlementsPath(filter), settlementsResponse, signal ? { signal } : {})

/**
 * Story 5.3's stop condition, as a function of the page on screen: 2 000 while
 * a visible `failed` row is still without its `slash_tx_hash`, `false` once
 * every one of them has landed. An answer that has not arrived yet keeps the
 * beat, so a first load that is slow does not silently become a page that never
 * polls.
 */
export function settlementsRefetchInterval(page: SettlementsPage | undefined): number | false {
  if (page === undefined) return SETTLEMENTS_POLL_MS
  return hasPendingSlash(page.items) ? SETTLEMENTS_POLL_MS : false
}

/** Shared by the page and its test, so both exercise the same policy. */
export function settlementsQueryOptions(
  filter: SettlementsFilter,
  fetcher: SettlementsFetcher = fetchSettlements,
) {
  return {
    queryKey: settlementsQueryKey(filter),
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetcher(filter, signal),
    // A settlements list that could not be read will be readable again when the
    // database comes back, so only a terminal refusal stops the beat.
    refetchInterval: (query: Query<SettlementsPage>) =>
      query.state.error !== null && !shouldKeepPolling(query.state.error)
        ? (false as const)
        : settlementsRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
    // The 2 s beat is the retry. Stacking React Query's backoff on top of it
    // would only make the recovery from a blip slower and less predictable.
    retry: false as const,
    // Changing the filter keeps the current rows on screen instead of flashing
    // the skeleton, which on a projector reads as the page breaking.
    placeholderData: keepPreviousData,
    staleTime: 0,
  }
}

function trimmed(value: string | null): string | null {
  const text = value?.trim() ?? ""
  return text.length === 0 ? null : text
}
