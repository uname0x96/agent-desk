"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import type { PaymentsResponse, PaymentView } from "@agent-desk/schemas"
import { AddressLink, TxHashLink } from "../../components/chain-link.tsx"
import { CallStatusBadge } from "../../components/status-badge.tsx"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx"
import { errorMessage } from "../../lib/api.ts"
import {
  formatDuration,
  formatRelativeTime,
  formatTimestamp,
  formatUsdt,
  TOKEN_LABEL,
} from "../../lib/format.ts"
import {
  NOT_SETTLED,
  NO_REFUND,
  groupByRun,
  pageTotal,
  paymentProof,
  refundNote,
  type RunPayments,
} from "./payment-groups.ts"
import {
  PAYMENTS_PAGE_SIZE,
  paymentsHref,
  paymentsQueryOptions,
  paymentsRefetchInterval,
  parsePaymentsView,
} from "./payments-query.ts"

/**
 * FR-40 / Story 5.2. Every payment the Builder made, grouped by the Run that
 * made it, with a per-Run subtotal that is the same number the Run's own
 * `total_cost` shows.
 *
 * AD-13 all the way down: amounts arrive as base units and are rendered as
 * decimal tUSD, addresses arrive lower-case and are rendered checksummed as
 * explorer links. Nothing on this page is computed from a float.
 */
export function PaymentsView() {
  const params = useSearchParams()
  const view = parsePaymentsView(params.get("run_id"))
  const { data, error, isPending, dataUpdatedAt } = useQuery(paymentsQueryOptions(view))
  // Grouped once, here: the header's total and the tables below it are the
  // same numbers, so they are the same computation.
  const groups = data === undefined ? undefined : groupByRun(data.items)

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-8 px-6 py-8">
      <PaymentsHeader
        page={data}
        groups={groups}
        live={error === null}
        updatedAt={dataUpdatedAt}
      />
      {view.runId === null ? null : <RunFilterNotice runId={view.runId} />}
      {error !== null ? (
        <PaymentsError error={error} />
      ) : isPending || data === undefined || groups === undefined ? (
        <PaymentsSkeleton />
      ) : (
        <PaymentsResults page={data} groups={groups} />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ header

function PaymentsHeader({
  page,
  groups,
  live,
  updatedAt,
}: {
  page: PaymentsResponse | undefined
  groups: RunPayments[] | undefined
  live: boolean
  updatedAt: number
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold tracking-tight">Payments</h1>
        <p className="max-w-3xl text-lg text-muted-foreground">
          Every x402 payment your Runs made, from your System Wallet to the Agent that earned it.
          Each row is a Call; each hash is on BSC testnet, so the whole page can be reconciled
          against the chain.
        </p>
      </div>
      <div className="flex flex-col items-end gap-2">
        {groups === undefined ? null : (
          <p className="text-base text-muted-foreground">
            <span className="text-2xl font-semibold text-foreground tabular-nums">
              {formatUsdt(pageTotal(groups))}
            </span>{" "}
            {TOKEN_LABEL} paid across {groups.length} {groups.length === 1 ? "Run" : "Runs"}
          </p>
        )}
        <PollIndicator page={page} live={live} updatedAt={updatedAt} />
      </div>
    </header>
  )
}

/** Proof on a projector that the page really is following the chain. */
function PollIndicator({
  page,
  live,
  updatedAt,
}: {
  page: PaymentsResponse | undefined
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
      Live · every {paymentsRefetchInterval(page) / 1000} s
      {updatedAt === 0 ? null : (
        <> · updated {formatRelativeTime(new Date(updatedAt).toISOString(), now)}</>
      )}
    </span>
  )
}

function RunFilterNotice({ runId }: { runId: string }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-border py-4 text-base">
      <span className="text-muted-foreground">Showing one Run:</span>
      <span className="hash">{runId}</span>
      <Link href={paymentsHref(null)} className="text-link underline-offset-4 hover:underline">
        Show every Run
      </Link>
    </p>
  )
}

// ----------------------------------------------------------------- results

function PaymentsResults({
  page,
  groups,
}: {
  page: PaymentsResponse
  groups: RunPayments[]
}) {
  if (groups.length === 0) {
    return (
      <p className="rounded-xl bg-card px-6 py-12 text-center text-lg text-muted-foreground ring-1 ring-border">
        No payment yet. A row appears here the moment a Run signs its first x402 authorisation.
      </p>
    )
  }

  return (
    <section className="flex flex-col gap-8" aria-label="Payments by Run">
      {groups.map((group) => (
        <RunPaymentsTable key={group.runId} group={group} />
      ))}
      {page.next === null ? null : (
        <p className="text-sm text-muted-foreground">
          Showing the {PAYMENTS_PAGE_SIZE} most recent Runs.
        </p>
      )}
    </section>
  )
}

function RunPaymentsTable({ group }: { group: RunPayments }) {
  return (
    <article className="flex flex-col gap-3" aria-label={`Payments of Run ${group.runId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        {/* The route answers a Call projection, which carries no Workflow name;
            the Run view one click away is where that lives. */}
        <h2 className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            href={`/runs/${encodeURIComponent(group.runId)}`}
            className="text-lg font-semibold underline-offset-4 hover:underline"
          >
            Run
          </Link>
          <span className="hash text-sm text-muted-foreground">{group.runId}</span>
        </h2>
        <p className="text-base text-muted-foreground">
          Subtotal{" "}
          <span className="text-lg font-semibold text-foreground tabular-nums">
            {formatUsdt(group.subtotal)}
          </span>{" "}
          {TOKEN_LABEL}
          <span className="ml-2 text-sm">
            over {group.paidCount} paid {group.paidCount === 1 ? "Call" : "Calls"}
          </span>
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl ring-1 ring-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Node</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead className="text-right">Amount ({TOKEN_LABEL})</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Transaction</TableHead>
              <TableHead>Refund</TableHead>
              <TableHead>Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {group.items.map((item) => (
              <PaymentRow key={item.call_id} item={item} />
            ))}
          </TableBody>
        </Table>
      </div>
    </article>
  )
}

function PaymentRow({ item }: { item: PaymentView }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{item.node_type}</TableCell>
      <TableCell>{item.provider}</TableCell>
      <TableCell className="text-right font-semibold tabular-nums">
        {formatUsdt(item.amount)}
      </TableCell>
      <TableCell>
        <AddressLink address={item.from} />
      </TableCell>
      <TableCell>
        <AddressLink address={item.to} />
      </TableCell>
      <TableCell>
        <CallStatusBadge status={item.status} />
      </TableCell>
      <TableCell>
        <ProofCell item={item} />
      </TableCell>
      <TableCell>
        <RefundCell item={item} />
      </TableCell>
      {/* Both timestamps, in one column: when the Call started, and how long
          the Agent took to answer it. */}
      <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
        {formatTimestamp(item.started_at)}
        {item.started_at && item.ended_at ? (
          <span className="ml-2">({formatDuration(item.started_at, item.ended_at)})</span>
        ) : null}
      </TableCell>
    </TableRow>
  )
}

/**
 * AD-6: an authorisation the chain never used has no hash and never will, so
 * the cell says `not settled` rather than showing the em dash that means
 * "not yet".
 */
function ProofCell({ item }: { item: PaymentView }) {
  const proof = paymentProof(item)
  if (proof.kind === "tx") return <TxHashLink hash={proof.hash} />
  if (proof.kind === "not_settled") {
    return <span className="font-medium text-status-bad">{NOT_SETTLED}</span>
  }
  return <span className="text-muted-foreground">settling…</span>
}

/** FR-38 in one column: who can still get their money back, and who cannot. */
function RefundCell({ item }: { item: PaymentView }) {
  const note = refundNote(item)

  if (note.kind === "settlement") {
    return (
      <Link href={note.href} className="text-link underline-offset-4 hover:underline">
        {note.pending ? "Settlement pending" : "Settlement"}
      </Link>
    )
  }
  if (note.kind === "no_refund") {
    return <span className="font-medium text-status-warn">{NO_REFUND}</span>
  }
  return <span className="text-muted-foreground">—</span>
}

// -------------------------------------------------------- pending / error

function PaymentsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      {[0, 1].map((index) => (
        <div key={index} className="h-40 animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  )
}

function PaymentsError({ error }: { error: unknown }) {
  return (
    <p
      role="alert"
      className="rounded-lg bg-status-bad/10 px-4 py-3 text-base font-medium text-status-bad ring-1 ring-status-bad/40 ring-inset"
    >
      The payments could not be loaded: {errorMessage(error)}
    </p>
  )
}
