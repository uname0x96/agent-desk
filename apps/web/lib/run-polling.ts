import type { Query } from '@tanstack/react-query'
import { isRunTerminal, runResponse, type RunResponse } from '@agent-desk/schemas'
import { ApiError, apiFetch } from './api.ts'

/**
 * AD-12: live views poll, nothing pushes. A Run is refetched every 2 s while
 * it is `running` and not once it has finished, so a status change is on
 * screen within two seconds without a reload.
 *
 * The policy lives here rather than inline in the component so it can be
 * tested without a DOM, and so the dashboard, wallet and listing views in
 * later stories poll on exactly the same clock.
 */

export const POLL_INTERVAL_MS = 2_000

export function runQueryKey(runId: string): readonly unknown[] {
  return ['run', runId]
}

export type RunFetcher = (runId: string, signal?: AbortSignal) => Promise<RunResponse>

export const fetchRun: RunFetcher = (runId, signal) =>
  apiFetch(`/api/runs/${encodeURIComponent(runId)}`, runResponse, signal ? { signal } : {})

/** 2 000 while the Run is running, `false` once it reaches a terminal status. */
export function runRefetchInterval(run: RunResponse | undefined): number | false {
  if (run === undefined) return POLL_INTERVAL_MS
  return isRunTerminal(run.status) ? false : POLL_INTERVAL_MS
}

/**
 * An unreachable or forbidden Run will not become reachable by asking again,
 * so those stop the poll; anything else keeps trying at the same 2 s beat.
 */
export function shouldKeepPolling(error: unknown): boolean {
  return !(error instanceof ApiError && error.isTerminal)
}

/** Shared by the run page and its test, so both exercise the same policy. */
export function runQueryOptions(runId: string, fetcher: RunFetcher = fetchRun) {
  return {
    queryKey: runQueryKey(runId),
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetcher(runId, signal),
    refetchInterval: (query: Query<RunResponse>) =>
      query.state.error !== null && !shouldKeepPolling(query.state.error)
        ? (false as const)
        : runRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
    retry: (_failureCount: number, error: unknown) => shouldKeepPolling(error),
    staleTime: 0,
  }
}
