"use client"

import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { cn } from "cn"
import { TxHashLink } from "../../../../components/chain-link.tsx"
import { JsonBlock } from "../../../../components/json-block.tsx"
import { CallStatusBadge } from "../../../../components/status-badge.tsx"
import { formatUsdt, TOKEN_LABEL } from "../../../../lib/format.ts"
import { isRowExpanded, type CallLogRow } from "../../split-model.ts"

/**
 * FR-43, the left pane: each Call in Node order with Provider, status, elapsed
 * time, and the request and response JSON collapsed by default. Rows append as
 * the poll advances the Run — every Call is inserted `pending` when the Run
 * starts (AD-4), so a Node the engine has not reached yet is already a row here
 * and simply fills in.
 *
 * Nothing is decided in this file: the rows, their order, their labels and
 * their elapsed times all arrive from `split-model.ts`.
 */

/**
 * The JSON is wrapped rather than scrolled sideways. The whole point of the
 * view is that both panes are readable at 1280 x 720 without a horizontal
 * scrollbar, and `JsonBlock`'s default `whitespace-pre` would give the payload
 * one of its own.
 */
const WRAPPED_JSON = "[&>pre]:max-h-56 [&>pre]:whitespace-pre-wrap [&>pre]:break-all"

export function CallLog({
  rows,
  expanded,
  onToggle,
}: {
  rows: readonly CallLogRow[]
  expanded: ReadonlySet<string>
  onToggle: (callId: string) => void
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No Calls yet.</p>
  }

  return (
    <ol className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.call_id}>
          <CallRow row={row} open={isRowExpanded(expanded, row.call_id)} onToggle={onToggle} />
        </li>
      ))}
    </ol>
  )
}

function CallRow({
  row,
  open,
  onToggle,
}: {
  row: CallLogRow
  open: boolean
  onToggle: (callId: string) => void
}) {
  const panelId = `call-json-${row.call_id}`

  return (
    <article
      data-call-status={row.status}
      className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-2 ring-1 ring-border"
    >
      <div className="flex items-baseline gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {row.node_label}
          <span className="ml-2 font-normal text-muted-foreground">{row.provider}</span>
        </h3>
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            row.elapsed.live ? "text-status-running" : "text-muted-foreground",
          )}
          title={row.elapsed.live ? "still running" : "elapsed"}
        >
          {row.elapsed.label}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <CallStatusBadge status={row.status} />
        <span className="text-xs tabular-nums">
          {/*
            Muted, not struck through: an unpaid Node still carries the price
            the Run locked for it (AD-4 inserts every Call up front), and a
            line through it would read as cancelled rather than not yet due.
          */}
          <span className={cn("font-semibold", !row.paid && "text-muted-foreground")}>
            {formatUsdt(row.amount)}
          </span>{" "}
          <span className="text-muted-foreground">{TOKEN_LABEL}</span>
        </span>
        <span className="min-w-0 shrink text-[11px]">
          <TxHashLink hash={row.payment_tx_hash} />
        </span>
        <button
          type="button"
          onClick={() => onToggle(row.call_id)}
          disabled={!row.expandable}
          aria-expanded={open}
          aria-controls={panelId}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          {open ? (
            <ChevronDownIcon className="size-3.5" aria-hidden />
          ) : (
            <ChevronRightIcon className="size-3.5" aria-hidden />
          )}
          JSON
        </button>
      </div>

      {row.failure_reason ? (
        <p className="rounded bg-status-bad/10 px-2 py-1 text-xs break-words text-status-bad">
          {row.failure_reason}
        </p>
      ) : null}
      {row.skip_reason ? (
        <p className="text-xs text-muted-foreground">Skipped: {row.skip_reason}</p>
      ) : null}

      {/*
        Collapsed by default: the panel is not in the tree until the Builder
        opens it, so a Run of five Nodes is one screen of rows rather than five
        screens of payloads.
      */}
      {open ? (
        <div id={panelId} className="flex flex-col gap-3 pt-1">
          <JsonBlock
            title="Request"
            value={row.request}
            emptyLabel="not sent yet"
            className={WRAPPED_JSON}
          />
          <JsonBlock
            title="Response"
            value={row.response}
            emptyLabel="no response yet"
            className={WRAPPED_JSON}
          />
        </div>
      ) : null}
    </article>
  )
}
