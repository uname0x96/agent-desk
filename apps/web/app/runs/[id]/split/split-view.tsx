"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { isRunTerminal, type RunResponse } from "@agent-desk/schemas"
import { PlatformStatus } from "../../../../components/platform-status.tsx"
import { RunStatusBadge } from "../../../../components/status-badge.tsx"
import { ApiError, errorMessage } from "../../../../lib/api.ts"
import { POLL_INTERVAL_MS, runQueryOptions } from "../../../../lib/run-polling.ts"
import {
  NO_ROWS_EXPANDED,
  buildSplitViewModel,
  toggleRow,
  type SplitViewModel,
} from "../../split-model.ts"
import { CallLog } from "./call-log.tsx"
import { MoneyFlow, MoneyTotalsStrip } from "./money-flow.tsx"

/**
 * FR-43, Story 5.5. The demo split view: the agent request and response log on
 * the left, the money flow on the right, one header across the top.
 *
 * AD-12: both panes are one `useQuery` over `GET /api/runs/<id>`, refetched
 * every 2 s while the Run is `running` and never afterwards. It is literally
 * the same query options object the live Run view uses, so the two views share
 * a cache entry and a clock — open both and they step together, and neither
 * needs a reload.
 */

/**
 * The split view is a fixed frame, not a scrolling document: the panes scroll
 * inside their own boxes so that both are on screen at once at the 1280 x 720
 * the demo is recorded at. The 65 px is the sticky `SiteHeader` above it, which
 * measures 61 px — `py-4` either side of a 28 px control, plus its 1 px border —
 * rounded up so that the frame still fits if that bar ever grows a few pixels.
 * `min-h` keeps the view usable on a shorter window by letting the page itself
 * scroll instead of squeezing the panes to nothing.
 */
const FRAME = "h-[calc(100dvh-65px)] min-h-[520px]"

export function SplitView({ runId }: { runId: string }) {
  const { data: run, error, isPending, dataUpdatedAt } = useQuery(runQueryOptions(runId))

  if (isPending) return <SplitSkeleton runId={runId} />
  if (error) return <SplitError runId={runId} error={error} />

  return <SplitPanes run={run} updatedAt={dataUpdatedAt} />
}

function SplitPanes({ run, updatedAt }: { run: RunResponse; updatedAt: number }) {
  const live = !isRunTerminal(run.status)
  const now = useTickingClock(updatedAt, live)
  const model = useMemo(() => buildSplitViewModel(run, now), [run, now])

  // Collapsed by default (`split-model.ts`), and a row the Builder opened stays
  // open as the poll appends the next Call.
  const [expanded, setExpanded] = useState(NO_ROWS_EXPANDED)

  return (
    <div className={`mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-3 ${FRAME}`}>
      <SplitHeader model={model} updatedAt={updatedAt} />

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
        <Pane title="Agent log" caption={`${model.calls.length} Calls in Node order`}>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-3">
            <CallLog
              rows={model.calls}
              expanded={expanded}
              onToggle={(callId) => setExpanded((current) => toggleRow(current, callId))}
            />
          </div>
        </Pane>

        <Pane title="Money flow" caption={`${model.arrows.length} on-chain movements`}>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-3">
            <MoneyFlow arrows={model.arrows} />
          </div>
          <MoneyTotalsStrip totals={model.totals} />
        </Pane>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------- header

/** FR-43: the Run status, the mode and the Emergency Stop badge (AD-10). */
function SplitHeader({ model, updatedAt }: { model: SplitViewModel; updatedAt: number }) {
  return (
    <header className="flex shrink-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <RunStatusBadge status={model.status} size="lg" />
        <h1 className="text-xl font-bold tracking-tight">{model.workflow_name}</h1>
        <p className="hash text-xs text-muted-foreground">
          {model.symbol} · {model.run_id}
        </p>

        <div className="ml-auto flex items-center gap-3">
          <PlatformStatus signedIn />
          <span className="text-xs text-muted-foreground">
            {model.live ? `live · every ${POLL_INTERVAL_MS / 1000} s` : "final · polling stopped"}
            {" · "}
            <span className="tabular-nums">{clockLabel(updatedAt)}</span>
          </span>
          <Link
            href={`/runs/${model.run_id}`}
            className="text-xs font-medium text-link underline-offset-4 hover:underline"
          >
            Full Run view
          </Link>
        </div>
      </div>

      {model.failure_reason ? (
        <p
          role="alert"
          className="rounded-lg bg-status-bad/10 px-3 py-1.5 text-sm font-medium text-status-bad ring-1 ring-status-bad/40 ring-inset"
        >
          {model.failure_reason}
        </p>
      ) : null}
    </header>
  )
}

function clockLabel(updatedAt: number): string {
  return new Date(updatedAt).toISOString().slice(11, 19)
}

// -------------------------------------------------------------------- panes

function Pane({
  title,
  caption,
  children,
}: {
  title: string
  caption: string
  children: React.ReactNode
}) {
  return (
    <section
      aria-label={title}
      className="flex min-h-0 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-border"
    >
      <div className="flex shrink-0 items-baseline justify-between gap-3 border-b border-border px-4 py-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{caption}</p>
      </div>
      {children}
    </section>
  )
}

// -------------------------------------------------------------------- clock

/**
 * The elapsed time of a Call in flight is measured against this clock, so it
 * has to move between polls. It starts at the moment the data arrived rather
 * than at `Date.now()`, so the server and client markup agree on first paint,
 * and it stops entirely once the Run is no longer running.
 */
function useTickingClock(updatedAt: number, live: boolean): Date {
  const [now, setNow] = useState(() => new Date(updatedAt))

  useEffect(() => {
    // A finished Run needs no clock: every Call it holds has its own
    // `ended_at`, so `now` is never read again.
    if (!live) return
    setNow(new Date())
    const timer = setInterval(() => setNow(new Date()), 1_000)
    return () => clearInterval(timer)
  }, [live, updatedAt])

  return now
}

// ------------------------------------------------------------- empty states

function SplitSkeleton({ runId }: { runId: string }) {
  return (
    <div className={`mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-3 ${FRAME}`}>
      <h1 className="text-xl font-bold tracking-tight">Loading Run</h1>
      <p className="hash text-xs text-muted-foreground">{runId}</p>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
        <div className="animate-pulse rounded-xl bg-muted" />
        <div className="animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  )
}

function SplitError({ runId, error }: { runId: string; error: unknown }) {
  const notFound = error instanceof ApiError && error.code === "not_found"

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight">
        {notFound ? "No such Run" : "Could not load the Run"}
      </h1>
      <p className="hash text-sm text-muted-foreground">{runId}</p>
      <p className="text-base text-status-bad">{errorMessage(error)}</p>
    </div>
  )
}
