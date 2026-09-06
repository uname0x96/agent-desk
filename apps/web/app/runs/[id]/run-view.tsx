"use client"

import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { isRunTerminal, type CallView, type RunResponse } from "@agent-desk/schemas"
import { AddressLink, TxHashLink } from "../../../components/chain-link.tsx"
import { JsonBlock } from "../../../components/json-block.tsx"
import { CallStatusBadge, RunStatusBadge } from "../../../components/status-badge.tsx"
import { Separator } from "../../../components/ui/separator.tsx"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table.tsx"
import { ApiError, errorMessage } from "../../../lib/api.ts"
import {
  formatDuration,
  formatRelativeTime,
  formatTimestamp,
  formatUsdt,
  formatUsdtLabelled,
  TOKEN_LABEL,
} from "../../../lib/format.ts"
import { POLL_INTERVAL_MS, runQueryOptions } from "../../../lib/run-polling.ts"

/**
 * FR-28 / AD-12. The Run is refetched every 2 s while it is `running` and the
 * poll stops the moment it is not, so a status change is on screen within two
 * seconds and a finished Run costs nothing to leave open.
 */
export function RunView({ runId }: { runId: string }) {
  const { data: run, error, isPending, dataUpdatedAt } = useQuery(runQueryOptions(runId))

  if (isPending) return <RunSkeleton runId={runId} />
  if (error) return <RunError runId={runId} error={error} />

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-8 px-6 py-8">
      <RunHeader run={run} updatedAt={dataUpdatedAt} />
      <PriceLockSection run={run} />
      <CallsSection calls={run.calls} />
    </div>
  )
}

// ------------------------------------------------------------------ header

function RunHeader({ run, updatedAt }: { run: RunResponse; updatedAt: number }) {
  const live = !isRunTerminal(run.status)

  return (
    <header className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight">{run.workflow_name}</h1>
          <p className="hash text-sm text-muted-foreground">
            {run.symbol} · {run.id}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <RunStatusBadge status={run.status} size="lg" />
          <PollIndicator live={live} updatedAt={updatedAt} />
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

      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 md:grid-cols-4">
        <Fact label={`Total cost (${TOKEN_LABEL})`}>
          <span className="text-2xl font-semibold tabular-nums">{formatUsdt(run.total_cost)}</span>
        </Fact>
        <Fact label="Paid from">
          <AddressLink address={run.wallet_address} />
        </Fact>
        <Fact label="Started">{formatTimestamp(run.started_at)}</Fact>
        <Fact label="Ended">{formatTimestamp(run.ended_at)}</Fact>
      </dl>
    </header>
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

/** Proof on a projector that the page really is following the Run. */
function PollIndicator({ live, updatedAt }: { live: boolean; updatedAt: number }) {
  const [now, setNow] = useState(() => new Date(updatedAt))

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(new Date()), 1_000)
    return () => clearInterval(timer)
  }, [live])

  if (!live) return <span className="text-sm text-muted-foreground">Final. Polling stopped.</span>

  return (
    <span className="text-sm text-muted-foreground">
      Live · every {POLL_INTERVAL_MS / 1000} s · updated{" "}
      {formatRelativeTime(new Date(updatedAt).toISOString(), now)}
    </span>
  )
}

// -------------------------------------------------------------- price lock

function PriceLockSection({ run }: { run: RunResponse }) {
  const lock = run.price_lock

  return (
    <section className="flex flex-col gap-4" aria-labelledby="price-lock">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="price-lock" className="text-xl font-semibold">
          Price Lock
        </h2>
        <p className="text-sm text-muted-foreground">
          Locked {formatTimestamp(lock.locked_at)} · total{" "}
          <span className="font-semibold text-foreground tabular-nums">
            {formatUsdtLabelled(lock.total)}
          </span>
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl ring-1 ring-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Node</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead className="text-right">Locked price ({TOKEN_LABEL})</TableHead>
              <TableHead>Pay to</TableHead>
              <TableHead>Network</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lock.nodes.map((node) => (
              <TableRow key={node.node_index}>
                <TableCell className="font-medium">
                  {node.node_index + 1}. {node.node_type}
                </TableCell>
                <TableCell>{node.provider}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {formatUsdt(node.price)}
                </TableCell>
                <TableCell>
                  <AddressLink address={node.pay_to} />
                </TableCell>
                <TableCell className="hash text-sm text-muted-foreground">{node.network}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

// ------------------------------------------------------------------- calls

function CallsSection({ calls }: { calls: readonly CallView[] }) {
  return (
    <section className="flex flex-col gap-4" aria-labelledby="calls">
      <h2 id="calls" className="text-xl font-semibold">
        Calls
      </h2>
      {calls.length === 0 ? (
        <p className="text-muted-foreground">No Calls yet.</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {calls.map((call) => (
            <li key={call.id}>
              <CallCard call={call} />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function CallCard({ call }: { call: CallView }) {
  return (
    <article className="flex flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-border">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h3 className="text-lg font-semibold">
            {call.node_index === null ? call.node_type : `${call.node_index + 1}. ${call.node_type}`}
          </h3>
          <span className="text-base text-muted-foreground">{call.provider}</span>
          <CallStatusBadge status={call.status} />
          {call.kind === "verification" ? (
            <span className="text-sm text-muted-foreground">verification call</span>
          ) : null}
        </div>
        <div className="text-right">
          <span className="text-xl font-semibold tabular-nums">
            {formatUsdt(call.locked_price)}
          </span>{" "}
          <span className="text-sm text-muted-foreground">{TOKEN_LABEL}</span>
        </div>
      </div>

      {call.failure_reason ? (
        <p className="rounded-lg bg-status-bad/10 px-3 py-2 text-sm text-status-bad">
          {call.failure_reason}
        </p>
      ) : null}
      {call.skip_reason ? (
        <p className="text-sm text-muted-foreground">Skipped: {call.skip_reason}</p>
      ) : null}

      <Separator />

      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 md:grid-cols-4">
        <Fact label="Payment tx">
          <TxHashLink hash={call.payment_tx_hash} />
        </Fact>
        <Fact label="Pay to">
          <AddressLink address={call.locked_pay_to} />
        </Fact>
        <Fact label="Started">{formatTimestamp(call.started_at)}</Fact>
        <Fact label="Ended">
          {formatTimestamp(call.ended_at)}
          {call.started_at && call.ended_at ? (
            <span className="ml-2 text-sm text-muted-foreground">
              ({formatDuration(call.started_at, call.ended_at)})
            </span>
          ) : null}
        </Fact>
      </dl>

      {call.settlement ? <SettlementLine call={call} /> : null}

      <div className="grid gap-4 md:grid-cols-2">
        <JsonBlock title="Request" value={call.request} emptyLabel="not sent yet" />
        <JsonBlock title="Response" value={call.response} emptyLabel="no response yet" />
      </div>
    </article>
  )
}

function SettlementLine({ call }: { call: CallView }) {
  const settlement = call.settlement
  if (!settlement) return null

  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-lg bg-muted/60 px-4 py-3 md:grid-cols-4">
      <Fact label="Settlement">
        <span className="font-medium">{settlement.result}</span>
        {settlement.not_scored_reason ? (
          <span className="ml-2 text-sm text-muted-foreground">
            ({settlement.not_scored_reason})
          </span>
        ) : null}
      </Fact>
      <Fact label="Rule">{settlement.rule_label}</Fact>
      <Fact label={`Slash (${TOKEN_LABEL})`}>
        {settlement.slash_amount ? formatUsdt(settlement.slash_amount) : "—"}
      </Fact>
      <Fact label="Slash tx">
        <TxHashLink hash={settlement.slash_tx_hash} />
      </Fact>
    </dl>
  )
}

// ------------------------------------------------------------ empty states

function RunSkeleton({ runId }: { runId: string }) {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-6 py-8">
      <h1 className="text-3xl font-bold tracking-tight">Loading Run</h1>
      <p className="hash text-sm text-muted-foreground">{runId}</p>
      <div className="h-40 animate-pulse rounded-xl bg-muted" />
      <div className="h-64 animate-pulse rounded-xl bg-muted" />
    </div>
  )
}

function RunError({ runId, error }: { runId: string; error: unknown }) {
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
