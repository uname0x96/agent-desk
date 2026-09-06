import type { Query } from "@tanstack/react-query"
import {
  PAYMENTS_PAGE_RUNS_MAX,
  paymentsResponse,
  type PaymentsResponse,
} from "@agent-desk/schemas"
import { apiFetch } from "../../lib/api.ts"
import { shouldKeepPolling } from "../../lib/run-polling.ts"

/**
 * How the payments view addresses its data.
 *
 * AD-12: live views poll, nothing pushes. A payment lands mid-Run, so while any
 * row on the page is `paid_awaiting_result` — signed and sent, receipt not
 * back — the page keeps the 2 s beat of the Run view and the tx hash appears
 * within two seconds of settling. With nothing in flight it drops to a slow
 * beat, which is enough to pick up a Run somebody else's tab just started.
 */

export const PAYMENTS_LIVE_POLL_MS = 2_000
export const PAYMENTS_IDLE_POLL_MS = 10_000

/** One request covers the whole demo: fifty Runs of at most five Calls each. */
export const PAYMENTS_PAGE_SIZE = PAYMENTS_PAGE_RUNS_MAX

export interface PaymentsView {
  /** `?run_id=` — the view narrowed to one Run, or every Run of the account. */
  runId: string | null
}

export function parsePaymentsView(runId: string | null): PaymentsView {
  const trimmed = runId?.trim() ?? ""
  return { runId: trimmed.length === 0 ? null : trimmed }
}

export function paymentsPath(view: PaymentsView): string {
  const params = new URLSearchParams({ limit: String(PAYMENTS_PAGE_SIZE) })
  if (view.runId !== null) params.set("run_id", view.runId)
  return `/api/payments?${params.toString()}`
}

/** The page's own URL, so a Run's payments can be linked and reloaded. */
export function paymentsHref(runId: string | null): string {
  return runId === null ? "/payments" : `/payments?run_id=${encodeURIComponent(runId)}`
}

export function paymentsQueryKey(view: PaymentsView): readonly unknown[] {
  return ["payments", view.runId ?? "all"]
}

export type PaymentsFetcher = (
  view: PaymentsView,
  signal?: AbortSignal,
) => Promise<PaymentsResponse>

export const fetchPayments: PaymentsFetcher = (view, signal) =>
  apiFetch(paymentsPath(view), paymentsResponse, signal ? { signal } : {})

/** 2 s while a payment is in flight, 10 s otherwise. */
export function paymentsRefetchInterval(page: PaymentsResponse | undefined): number {
  if (page === undefined) return PAYMENTS_LIVE_POLL_MS
  const inFlight = page.items.some((item) => item.status === "paid_awaiting_result")
  return inFlight ? PAYMENTS_LIVE_POLL_MS : PAYMENTS_IDLE_POLL_MS
}

/** Shared by the page and its test, so both exercise the same policy. */
export function paymentsQueryOptions(
  view: PaymentsView,
  fetcher: PaymentsFetcher = fetchPayments,
) {
  return {
    queryKey: paymentsQueryKey(view),
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetcher(view, signal),
    // A database that blinked comes back; a signed-out session does not, so
    // only a terminal refusal stops the beat.
    refetchInterval: (query: Query<PaymentsResponse>) =>
      query.state.error !== null && !shouldKeepPolling(query.state.error)
        ? (false as const)
        : paymentsRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
    retry: (_failureCount: number, error: unknown) => shouldKeepPolling(error),
    staleTime: 0,
  }
}
