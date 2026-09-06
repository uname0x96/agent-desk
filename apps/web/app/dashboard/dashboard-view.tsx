"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { isRunTerminal, type RunSummary } from "@agent-desk/schemas"
import { PlatformStatus } from "../../components/platform-status.tsx"
import { CallStatusBadge, RunStatusBadge } from "../../components/status-badge.tsx"
import { errorMessage } from "../../lib/api.ts"
import {
  formatRelativeTime,
  formatTimestamp,
  formatUsdt,
  TOKEN_LABEL,
} from "../../lib/format.ts"
import { runFeedQueryOptions, runFeedRefetchInterval } from "./run-feed.ts"

/**
 * FR-39 / Story 5.1. The one place a Builder follows every Run from: what ran,
 * what it is doing, what it cost, and where to open it.
 *
 * AD-12: the feed polls — every 2 s while any listed Run is `running`, every
 * 10 s otherwise — so a Run started from the Workflow list is at the top of
 * this page within two seconds without anyone reloading it.
 *
 * AD-13: `total_cost` arrives as a base-unit integer string and is rendered as
 * a decimal labelled tUSD through `lib/format.ts`, which is the only place in
 * the web app that formats an amount.
 *
 * The status text is never rewritten here. `components/status-badge.tsx` prints
 * whatever the API says, which is the PRD vocabulary verbatim — including
 * `completed, no order` and the `failed at <Node>` template.
 */
export function DashboardView({ isOperator }: { isOperator: boolean }) {
  const { data, error, isPending, dataUpdatedAt } = useQuery(runFeedQueryOptions())

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-8 px-6 py-8">
      <DashboardHeader
        intervalMs={runFeedRefetchInterval(data)}
        live={error === null}
        updatedAt={dataUpdatedAt}
      />
      <DashboardNav isOperator={isOperator} />

      {error !== null ? (
        <FeedError error={error} />
      ) : isPending || data === undefined ? (
        <p className="text-lg text-muted-foreground">Loading…</p>
      ) : (
        <RunFeed items={data.items} truncated={data.next !== null} />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ header

function DashboardHeader({
  intervalMs,
  live,
  updatedAt,
}: {
  intervalMs: number
  live: boolean
  updatedAt: number
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold tracking-tight">Dashboard</h1>
        <p className="max-w-3xl text-lg text-muted-foreground">
          Every Run of this Account, newest first, with what each Node cost and what it is doing
          right now.
        </p>
      </div>
      <div className="flex flex-col items-end gap-2">
        {/*
          AD-10 and Story 2.2: the mode and the Emergency Stop badge, from
          `GET /api/settings/public`. The site header carries the same pair
          app-wide; the dashboard carries its own because this is the page a
          demo is driven from, and the badge has to be beside the feed it
          explains. Both read one query key, so there is no second request.
        */}
        <PlatformStatus signedIn />
        <PollIndicator intervalMs={intervalMs} live={live} updatedAt={updatedAt} />
      </div>
    </header>
  )
}

/** Proof on a projector that the page really is following the Runs. */
function PollIndicator({
  intervalMs,
  live,
  updatedAt,
}: {
  intervalMs: number
  live: boolean
  updatedAt: number
}) {
  const [now, setNow] = useState(() => new Date(updatedAt))

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(new Date()), 1_000)
    return () => clearInterval(timer)
  }, [live])

  if (!live) return <span className="text-sm text-muted-foreground">Not updating.</span>

  return (
    <span className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="size-2 animate-pulse rounded-full bg-status-running" aria-hidden />
      Live · every {intervalMs / 1000} s
      {updatedAt === 0 ? null : (
        <> · updated {formatRelativeTime(new Date(updatedAt).toISOString(), now)}</>
      )}
    </span>
  )
}

// --------------------------------------------------------------------- nav

/**
 * Story 5.1 requires the dashboard itself to reach every surface, not only the
 * site header. `/operator` is rendered from the session's `is_operator`, which
 * the server component read from the cookie — a non-operator is never shown a
 * link to a page `/api/operator/*` would refuse anyway (AD-10).
 */
const DESTINATIONS = [
  { href: "/marketplace", label: "Marketplace", hint: "Every Agent on the Registry" },
  { href: "/workflows", label: "Workflows", hint: "Build a chain and run it" },
  { href: "/payments", label: "Payments", hint: "Every Call this Account paid for" },
  { href: "/settlements", label: "Settlements", hint: "Every scored Call and its slash" },
  { href: "/settings", label: "Settings", hint: "Wallet, budget and Telegram" },
] as const

function DashboardNav({ isOperator }: { isOperator: boolean }) {
  return (
    <nav
      aria-label="Sections"
      className="grid grid-cols-1 gap-3 border-y border-border py-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {DESTINATIONS.map((destination) => (
        <DestinationLink key={destination.href} {...destination} />
      ))}
      {isOperator ? (
        <DestinationLink
          href="/operator"
          label="Operator"
          hint="Mode, Emergency Stop and budgets"
        />
      ) : null}
    </nav>
  )
}

function DestinationLink({
  href,
  label,
  hint,
}: {
  href: string
  label: string
  hint: string
}) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-1 rounded-lg px-4 py-3 ring-1 ring-border ring-inset transition-colors hover:bg-muted"
    >
      <span className="text-base font-semibold">{label}</span>
      <span className="text-sm text-muted-foreground">{hint}</span>
    </Link>
  )
}

// -------------------------------------------------------------------- feed

function RunFeed({ items, truncated }: { items: readonly RunSummary[]; truncated: boolean }) {
  if (items.length === 0) {
    return (
      <p className="rounded-xl border-2 border-dashed border-border px-6 py-12 text-center text-lg text-muted-foreground">
        No Runs yet.{" "}
        <Link href="/workflows" className="font-semibold text-foreground underline">
          Build a Workflow
        </Link>{" "}
        and run it; it appears here within two seconds of starting.
      </p>
    )
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Runs">
      <ul className="flex flex-col gap-4">
        {items.map((run) => (
          <RunRow key={run.id} run={run} />
        ))}
      </ul>
      {truncated ? (
        <p className="text-sm text-muted-foreground">
          Showing the {items.length} newest Runs of this Account.
        </p>
      ) : null}
    </section>
  )
}

function RunRow({ run }: { run: RunSummary }) {
  return (
    <li
      data-run-id={run.id}
      className="flex flex-col gap-4 rounded-xl bg-card px-6 py-5 ring-1 ring-border ring-inset"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="flex min-w-0 flex-col gap-2">
          <Link
            href={`/runs/${run.id}`}
            className="text-2xl font-bold tracking-tight hover:underline"
          >
            {run.workflow_name}
          </Link>
          <p className="hash text-sm text-muted-foreground">{run.id}</p>
          <NodeChain nodes={run.nodes} />
        </div>

        <div className="flex flex-col items-end gap-3">
          <RunStatusBadge status={run.status} />
          <div className="flex flex-col items-end gap-1">
            <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
              Total cost
            </span>
            <span className="text-2xl font-bold tabular-nums">
              {formatUsdt(run.total_cost)}
              <span className="ml-1 text-base font-semibold text-muted-foreground">
                {TOKEN_LABEL}
              </span>
            </span>
          </div>
        </div>
      </div>

      {run.failure_reason ? (
        <p
          role="alert"
          className="rounded-lg bg-status-bad/10 px-4 py-3 text-base font-medium text-status-bad ring-1 ring-status-bad/40 ring-inset"
        >
          {run.failure_reason}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 border-t border-border pt-4">
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <Fact label="Created">{formatTimestamp(run.created_at)}</Fact>
          <Fact label="Started">{formatTimestamp(run.started_at)}</Fact>
          <Fact label="Ended">
            {run.ended_at === null && !isRunTerminal(run.status)
              ? "still running"
              : formatTimestamp(run.ended_at)}
          </Fact>
        </dl>
        <div className="flex flex-wrap gap-4 text-base font-semibold">
          <Link href={`/runs/${run.id}`} className="hover:underline">
            Open Run
          </Link>
          <Link href={`/runs/${run.id}/split`} className="hover:underline">
            Cost split
          </Link>
        </div>
      </div>
    </li>
  )
}

/** The ordered Node Types of the Run, each with the status of its Call. */
function NodeChain({ nodes }: { nodes: RunSummary["nodes"] }) {
  if (nodes.length === 0) {
    return <p className="text-sm text-muted-foreground">No Calls on this Run.</p>
  }

  return (
    <ol className="flex flex-wrap items-center gap-2">
      {nodes.map((node, index) => (
        <li
          key={`${index}-${node.node_type}`}
          data-node-type={node.node_type}
          className="flex items-center gap-2 rounded-lg bg-muted px-3 py-1"
        >
          <span className="text-xs font-bold tracking-widest uppercase">
            {index + 1}. {node.node_type}
          </span>
          <CallStatusBadge status={node.status} />
        </li>
      ))}
    </ol>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  )
}

function FeedError({ error }: { error: unknown }) {
  return (
    <p
      role="alert"
      className="rounded-lg bg-status-bad/10 px-4 py-3 text-base font-medium text-status-bad ring-1 ring-status-bad/40 ring-inset"
    >
      The Run feed could not be loaded: {errorMessage(error)}
    </p>
  )
}
