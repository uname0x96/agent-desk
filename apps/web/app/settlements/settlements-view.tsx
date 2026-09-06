"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import type { SettlementResult, SettlementRow, SettlementsPage } from "@agent-desk/schemas"
import { AddressLink, TxHashLink } from "../../components/chain-link.tsx"
import { StatusBadge } from "../../components/status-badge.tsx"
import { Separator } from "../../components/ui/separator.tsx"
import { errorMessage } from "../../lib/api.ts"
import {
  formatRelativeTime,
  formatTimestamp,
  formatUsdt,
  TOKEN_LABEL,
} from "../../lib/format.ts"
import {
  SETTLEMENTS_PAGE_SIZE,
  SETTLEMENTS_POLL_MS,
  settlementsHref,
  settlementsQueryOptions,
  type SettlementsFilter,
} from "./settlements-query.ts"
import {
  SLASH_PENDING_LABEL,
  hasPendingSlash,
  isSlashPending,
  notScoredWords,
} from "./settlement-words.ts"

/**
 * FR-41 / Story 5.3. Every scored Call of the Builder's own Runs, with the rule
 * that was applied, the prices it was applied to and where they came from, the
 * result, and — when the Agent failed — the Slash that paid the Refund back.
 *
 * The page answers one question for a judge: why did this Agent pass or fail,
 * and did my money come back? So nothing here summarises or softens a row. The
 * rule label is printed exactly as AD-9 stored it, the prices are the ones the
 * rule read and no others, and a Refund is a tx hash on the explorer rather
 * than a claim that it happened.
 */
export function SettlementsView({ filter }: { filter: SettlementsFilter }) {
  const { data, error, isPending, dataUpdatedAt } = useQuery(settlementsQueryOptions(filter))

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-8 px-6 py-8">
      <SettlementsHeader
        live={error === null && (data === undefined || hasPendingSlash(data.items))}
        updatedAt={dataUpdatedAt}
      />
      <FilterBar filter={filter} />
      {error !== null ? (
        <SettlementsError error={error} />
      ) : isPending || data === undefined ? (
        <SettlementsSkeleton />
      ) : (
        <SettlementsResults filter={filter} page={data} />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ header

function SettlementsHeader({ live, updatedAt }: { live: boolean; updatedAt: number }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold tracking-tight">Settlements</h1>
        <p className="max-w-3xl text-lg text-muted-foreground">
          Every scored Call of your Runs: the rule that judged it, the prices it was judged on, and
          the Slash that sent your Refund back when the Agent was wrong.
        </p>
      </div>
      <PollIndicator live={live} updatedAt={updatedAt} />
    </header>
  )
}

/**
 * AD-12, said out loud on the projector. The beat stops once every `failed` row
 * has its Slash, so the indicator says which of the two states the page is in
 * rather than claiming to be live forever.
 */
function PollIndicator({ live, updatedAt }: { live: boolean; updatedAt: number }) {
  const [now, setNow] = useState(() => new Date(updatedAt))

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(new Date()), 1_000)
    return () => clearInterval(timer)
  }, [live])

  if (!live) {
    return <span className="text-sm text-muted-foreground">Up to date. Polling stopped.</span>
  }

  return (
    <span className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="size-2 animate-pulse rounded-full bg-status-running" aria-hidden />
      Waiting for a Slash · every {SETTLEMENTS_POLL_MS / 1000} s
      {updatedAt === 0 ? null : (
        <> · updated {formatRelativeTime(new Date(updatedAt).toISOString(), now)}</>
      )}
    </span>
  )
}

// ----------------------------------------------------------------- filters

function FilterBar({ filter }: { filter: SettlementsFilter }) {
  if (filter.runId === null && filter.listingId === null) return null

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border py-4">
      <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Filtered by
      </span>
      {filter.runId === null ? null : (
        <Chip label="Run" value={filter.runId} href={settlementsHref({ ...filter, runId: null })} />
      )}
      {filter.listingId === null ? null : (
        <Chip
          label="Agent"
          value={filter.listingId}
          href={settlementsHref({ ...filter, listingId: null })}
        />
      )}
      <Link href="/settlements" className="text-sm font-medium underline underline-offset-4">
        Clear all
      </Link>
    </div>
  )
}

function Chip({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm ring-1 ring-border ring-inset">
      <span className="text-muted-foreground">{label}</span>
      <span className="hash font-medium">{value}</span>
      <Link href={href} aria-label={`Remove the ${label} filter`} className="text-muted-foreground hover:text-foreground">
        ×
      </Link>
    </span>
  )
}

// ----------------------------------------------------------------- results

function SettlementsResults({
  filter,
  page,
}: {
  filter: SettlementsFilter
  page: SettlementsPage
}) {
  if (page.items.length === 0) return <SettlementsEmpty filter={filter} />

  return (
    <section className="flex flex-col gap-5" aria-label="Settlements">
      <SettlementsSummary page={page} />
      <ol className="flex flex-col gap-4">
        {page.items.map((row) => (
          <li key={row.id}>
            <SettlementCard row={row} />
          </li>
        ))}
      </ol>
    </section>
  )
}

function SettlementsSummary({ page }: { page: SettlementsPage }) {
  const count = (result: SettlementResult) =>
    page.items.filter((row) => row.result === result).length
  const waiting = page.items.filter(isSlashPending).length
  const noun = page.items.length === 1 ? "scored Call" : "scored Calls"

  return (
    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base text-muted-foreground">
      <span className="text-foreground">
        <span className="font-semibold tabular-nums">{page.items.length}</span> {noun}
      </span>
      <span aria-hidden>·</span>
      <span className="text-status-ok">{count("passed")} passed</span>
      <span aria-hidden>·</span>
      <span className="text-status-bad">{count("failed")} failed</span>
      <span aria-hidden>·</span>
      <span>{count("not_scored")} not scored</span>
      {waiting > 0 ? (
        <>
          <span aria-hidden>·</span>
          <span className="text-status-warn">{waiting} awaiting a Slash</span>
        </>
      ) : null}
      {page.next !== null ? (
        <>
          <span aria-hidden>·</span>
          <span>showing the first {SETTLEMENTS_PAGE_SIZE}</span>
        </>
      ) : null}
    </p>
  )
}

// -------------------------------------------------------------------- card

const RESULT_TONE = {
  passed: "ok",
  failed: "bad",
  not_scored: "idle",
} as const

function SettlementCard({ row }: { row: SettlementRow }) {
  return (
    <article className="flex flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-border">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 className="text-lg font-semibold">{row.node_type}</h2>
          <span className="text-base text-muted-foreground">{row.provider}</span>
          <StatusBadge status={row.result} tone={RESULT_TONE[row.result]} />
          <NotScoredReason row={row} />
        </div>
        <RunLink runId={row.run_id} />
      </div>

      {/* AD-9 stores `rule_label` verbatim so that this line can print it verbatim. */}
      <p className="text-base">
        <span className="font-medium">{row.rule_label}</span>
        <span className="ml-2 text-sm text-muted-foreground">· {row.mode} mode</span>
      </p>

      <Prices row={row} />

      <Separator />

      <Outcome row={row} />
    </article>
  )
}

function NotScoredReason({ row }: { row: SettlementRow }) {
  const words = notScoredWords(row.not_scored_reason)
  if (words === null) return null
  return <span className="text-base text-muted-foreground">{words}</span>
}

function RunLink({ runId }: { runId: string | null }) {
  if (runId === null) return null
  return (
    <Link
      href={`/runs/${runId}`}
      className="hash text-sm text-status-running underline-offset-4 hover:underline"
    >
      {runId}
    </Link>
  )
}

/**
 * "the prices used with their source". Only the prices the rule actually read
 * are on the row — `packages/core/settlement` leaves the rest null on purpose —
 * so an absent field means the rule did not use one, and printing a dash for it
 * would suggest a number went missing.
 */
function Prices({ row }: { row: SettlementRow }) {
  const prices: [label: string, value: string][] = []
  if (row.start_price !== null) prices.push(["Start price", row.start_price])
  if (row.end_price !== null) prices.push(["End price", row.end_price])
  if (row.change_24h_pct !== null) prices.push(["24 h change", `${row.change_24h_pct} %`])
  if (row.p_fill !== null) prices.push(["Fill price", row.p_fill])
  if (row.window_min !== null) prices.push(["Window min", row.window_min])
  if (row.window_max !== null) prices.push(["Window max", row.window_max])

  return (
    <div className="flex flex-col gap-2">
      {prices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No price was read for this row.</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 md:grid-cols-4">
          {prices.map(([label, value]) => (
            <Fact key={label} label={label}>
              <span className="font-semibold tabular-nums">{value}</span>
            </Fact>
          ))}
        </dl>
      )}
      <p className="text-sm text-muted-foreground">
        Prices from <span className="hash">{row.price_source}</span> · scored{" "}
        {formatTimestamp(row.scored_at)}
      </p>
    </div>
  )
}

/**
 * What the Settlement did with money. A `failed` row owes the Builder a Refund,
 * which AD-9 pays as the Slash itself — one transaction that moves the Agent's
 * Stake to the Builder's own wallet — so the Refund, the wallet and the tx hash
 * are three views of one event and are shown together or not at all.
 */
function Outcome({ row }: { row: SettlementRow }) {
  if (row.result !== "failed") {
    return (
      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 md:grid-cols-4">
        <Fact label="Slash">
          <span className="text-muted-foreground">
            {row.result === "passed" ? "none, the Agent passed" : "none, the Call was not scored"}
          </span>
        </Fact>
        <Fact label="Reputation tx">
          <TxHashLink hash={row.reputation_tx_hash} />
        </Fact>
      </dl>
    )
  }

  if (isSlashPending(row)) {
    return (
      <p className="flex items-center gap-2 text-base font-medium text-status-warn">
        <span className="size-2 animate-pulse rounded-full bg-current" aria-hidden />
        {SLASH_PENDING_LABEL}
      </p>
    )
  }

  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-3 md:grid-cols-4">
      <Fact label={`Refund (${TOKEN_LABEL})`}>
        <span className="text-xl font-semibold tabular-nums">
          {row.slash_amount === null ? "—" : formatUsdt(row.slash_amount)}
        </span>
      </Fact>
      <Fact label="Refunded to">
        <AddressLink address={row.refund_to} />
      </Fact>
      <Fact label="Slash tx">
        <TxHashLink hash={row.slash_tx_hash} />
      </Fact>
      <Fact label="Reputation tx">
        <TxHashLink hash={row.reputation_tx_hash} />
      </Fact>
    </dl>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="text-base">{children}</dd>
    </div>
  )
}

// ------------------------------------------------------------ empty states

function SettlementsEmpty({ filter }: { filter: SettlementsFilter }) {
  const filtered = filter.runId !== null || filter.listingId !== null

  return (
    <div className="flex flex-col items-start gap-2 rounded-xl bg-card px-6 py-12 ring-1 ring-border">
      <h2 className="text-xl font-semibold">
        {filtered ? "Nothing scored under this filter." : "No Call has been scored yet."}
      </h2>
      <p className="max-w-2xl text-base text-muted-foreground">
        A row appears here once a <code>research</code> or <code>risk</code> Call has been paid for
        and its Settlement Window has closed. A <code>data</code>, <code>execution</code> or{" "}
        <code>notify</code> Call is never scored.
      </p>
      {filtered ? (
        <Link href="/settlements" className="text-base font-medium underline underline-offset-4">
          Show every Settlement
        </Link>
      ) : null}
    </div>
  )
}

function SettlementsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="h-40 animate-pulse rounded-xl bg-muted" />
      <div className="h-40 animate-pulse rounded-xl bg-muted" />
      <div className="h-40 animate-pulse rounded-xl bg-muted" />
    </div>
  )
}

function SettlementsError({ error }: { error: unknown }) {
  return (
    <p
      role="alert"
      className="rounded-lg bg-status-bad/10 px-4 py-3 text-base font-medium text-status-bad ring-1 ring-status-bad/40 ring-inset"
    >
      The Settlements could not be loaded: {errorMessage(error)}
    </p>
  )
}
