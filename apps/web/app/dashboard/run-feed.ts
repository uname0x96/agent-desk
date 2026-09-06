import type { Query } from '@tanstack/react-query'
import {
  RUN_FEED_DEFAULT_LIMIT,
  isRunTerminal,
  runsResponse,
  type RunSummary,
} from '@agent-desk/schemas'
import { apiFetch } from '../../lib/api.ts'
import { shouldKeepPolling } from '../../lib/run-polling.ts'

/**
 * How the dashboard addresses its data and how often it asks for it.
 *
 * AD-12: live views poll, nothing pushes. Story 5.1 asks for two beats rather
 * than one — 2 s while any listed Run is `running`, 10 s otherwise — so a Run
 * that has just started is at the top of the feed within two seconds, and a
 * dashboard left open on a quiet day costs a fifth of the requests.
 *
 * The policy lives here rather than inline in the component so it can be tested
 * without a DOM, and so the feed and the Run view beat on the same clock module
 * (`lib/run-polling.ts` owns the single-Run half of it).
 */

/** AD-12: at least one Run is still moving, so the feed follows it. */
export const RUNNING_POLL_MS = 2_000

/** Nothing is running; the feed only has to notice a Run that starts elsewhere. */
export const IDLE_POLL_MS = 10_000

export interface RunFeedPage {
  items: RunSummary[]
  next: string | null
}

export const runFeedQueryKey = ['runs', 'feed'] as const

export function runFeedPath(
  limit: number = RUN_FEED_DEFAULT_LIMIT,
  cursor: string | null = null,
): string {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor !== null) params.set('cursor', cursor)
  return `/api/runs?${params.toString()}`
}

/**
 * 2 000 while any listed Run is `running`, 10 000 once none is.
 *
 * Before the first page arrives the fast beat is used: the common way to reach
 * this page is straight after starting a Run, and the story requires that Run
 * to appear within two seconds. Unlike the single-Run view the poll never
 * stops, because the Run that has to appear here has not been fetched yet.
 */
export function runFeedRefetchInterval(page: RunFeedPage | undefined): number {
  if (page === undefined) return RUNNING_POLL_MS
  return page.items.some((run) => !isRunTerminal(run.status)) ? RUNNING_POLL_MS : IDLE_POLL_MS
}

export type RunFeedFetcher = (signal?: AbortSignal) => Promise<RunFeedPage>

export const fetchRunFeed: RunFeedFetcher = (signal) =>
  apiFetch(runFeedPath(), runsResponse, signal ? { signal } : {})

/** Shared by the page and its test, so both exercise the same policy. */
export function runFeedQueryOptions(fetcher: RunFeedFetcher = fetchRunFeed) {
  return {
    queryKey: runFeedQueryKey,
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetcher(signal),
    // A feed that is unreachable becomes reachable again when the database
    // comes back, so only a terminal refusal — signed out, forbidden — stops
    // the beat.
    refetchInterval: (query: Query<RunFeedPage>) =>
      query.state.error !== null && !shouldKeepPolling(query.state.error)
        ? (false as const)
        : runFeedRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
    retry: (_failureCount: number, error: unknown) => shouldKeepPolling(error),
    staleTime: 0,
  }
}
