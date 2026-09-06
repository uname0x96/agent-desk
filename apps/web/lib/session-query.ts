import type { Query } from '@tanstack/react-query'
import {
  meResponse,
  publicSettings,
  type MeResponse,
  type PublicSettings,
} from '@agent-desk/schemas'
import { ApiError, apiFetch } from './api.ts'
import { POLL_INTERVAL_MS, shouldKeepPolling } from './run-polling.ts'

/**
 * The two queries every signed-in page shares: who am I, and what mode is the
 * platform in. Kept beside the Run poll so the whole app beats on one clock
 * (AD-12: live views poll, nothing pushes).
 *
 * A signed-out visitor gets 401 from both. That is a terminal answer — asking
 * again will not produce a session — so the poll and the retries stop, and the
 * header simply renders its signed-out state.
 */

/** AD-12: `GET /api/settings/public` is polled with the dashboard header. */
export const SETTINGS_POLL_INTERVAL_MS = POLL_INTERVAL_MS

export const meQueryKey = ['me'] as const
export const publicSettingsQueryKey = ['settings', 'public'] as const

export type MeFetcher = (signal?: AbortSignal) => Promise<MeResponse>
export type PublicSettingsFetcher = (signal?: AbortSignal) => Promise<PublicSettings>

export const fetchMe: MeFetcher = (signal) =>
  apiFetch('/api/me', meResponse, signal ? { signal } : {})

export const fetchPublicSettings: PublicSettingsFetcher = (signal) =>
  apiFetch('/api/settings/public', publicSettings, signal ? { signal } : {})

/** True when the error is the ordinary "you are signed out" answer. */
export function isSignedOut(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'unauthorized'
}

export function meQueryOptions(fetcher: MeFetcher = fetchMe) {
  return {
    queryKey: meQueryKey,
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetcher(signal),
    retry: (_failureCount: number, error: unknown) => shouldKeepPolling(error),
    staleTime: 0,
  }
}

/**
 * Polled every 2 s while there is a session, so an Operator flipping Emergency
 * Stop or switching mode is on every open page within two seconds.
 */
export function publicSettingsQueryOptions(
  enabled: boolean,
  fetcher: PublicSettingsFetcher = fetchPublicSettings,
) {
  return {
    queryKey: publicSettingsQueryKey,
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetcher(signal),
    enabled,
    refetchInterval: (query: Query<PublicSettings>) =>
      query.state.error !== null && !shouldKeepPolling(query.state.error)
        ? (false as const)
        : SETTINGS_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: (_failureCount: number, error: unknown) => shouldKeepPolling(error),
    staleTime: 0,
  }
}
