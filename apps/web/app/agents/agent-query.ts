import type { Query } from "@tanstack/react-query"
import {
  agentHistoryResponse,
  listingResponse,
  type AgentHistoryResponse,
  type ListingResponse,
} from "@agent-desk/schemas"
import { hasPendingHistory } from "../api/listings/listing-history.ts"
import { apiFetch } from "../../lib/api.ts"
import { POLL_INTERVAL_MS, shouldKeepPolling } from "../../lib/run-polling.ts"

/**
 * How `/agents/<listing_id>` addresses its data (Story 5.4, AD-12).
 *
 * Two queries, because the page is two contracts: `GET /api/listings/<id>` for
 * what the Agent is now, and `GET /api/listings/<id>/history` for how it got
 * there. The detail route is the same one the Creator's listing page polls; this
 * page reads it through the plain `listingResponse`, because the public Agent
 * record needs the card's fields and none of the pipeline's.
 *
 * The record is refetched every two seconds only while one of its transactions
 * is still `pending` — a price change, a pause, or the Slash landing during the
 * demo — and not at all once every row has settled, so a finished Agent costs
 * nothing to leave open on a projector.
 */

export const AGENT_POLL_MS = POLL_INTERVAL_MS

export function agentHref(listingId: string): string {
  return `/agents/${encodeURIComponent(listingId)}`
}

export function agentListingQueryKey(listingId: string): readonly unknown[] {
  return ["agent", "listing", listingId]
}

export function agentHistoryQueryKey(listingId: string): readonly unknown[] {
  return ["agent", "history", listingId]
}

export type AgentListingFetcher = (
  listingId: string,
  signal?: AbortSignal,
) => Promise<ListingResponse>

export type AgentHistoryFetcher = (
  listingId: string,
  signal?: AbortSignal,
) => Promise<AgentHistoryResponse>

export const fetchAgentListing: AgentListingFetcher = (listingId, signal) =>
  apiFetch(
    `/api/listings/${encodeURIComponent(listingId)}`,
    listingResponse,
    signal ? { signal } : {},
  )

export const fetchAgentHistory: AgentHistoryFetcher = (listingId, signal) =>
  apiFetch(
    `/api/listings/${encodeURIComponent(listingId)}/history`,
    agentHistoryResponse,
    signal ? { signal } : {},
  )

/** 2 000 while a transaction of this Agent can still move, `false` once none can. */
export function agentRefetchInterval(
  history: AgentHistoryResponse | undefined,
): number | false {
  if (history === undefined) return AGENT_POLL_MS
  return hasPendingHistory(history) ? AGENT_POLL_MS : false
}

/** Shared by the page and its test, so both exercise the same policy. */
export function agentListingQueryOptions(
  listingId: string,
  fetcher: AgentListingFetcher = fetchAgentListing,
) {
  return {
    queryKey: agentListingQueryKey(listingId),
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetcher(listingId, signal),
    retry: (_failureCount: number, error: unknown) => shouldKeepPolling(error),
    staleTime: 0,
  }
}

export function agentHistoryQueryOptions(
  listingId: string,
  fetcher: AgentHistoryFetcher = fetchAgentHistory,
) {
  return {
    queryKey: agentHistoryQueryKey(listingId),
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetcher(listingId, signal),
    refetchInterval: (query: Query<AgentHistoryResponse>) =>
      query.state.error !== null && !shouldKeepPolling(query.state.error)
        ? (false as const)
        : agentRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
    retry: (_failureCount: number, error: unknown) => shouldKeepPolling(error),
    staleTime: 0,
  }
}
