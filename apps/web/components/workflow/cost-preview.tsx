import { cn } from "cn"
import type { AgentType } from "@agent-desk/schemas"
import { formatUsdt, TOKEN_LABEL } from "../../lib/format.ts"
import type { CostPreview as Preview } from "../../app/workflows/builder-state.ts"

/**
 * FR-21: the max cost of the chain beside the remaining Daily Fee Budget.
 *
 * This is one of the two things the demo narrator points at, so both numbers
 * are set in the largest type on the page and the shortfall, when there is one,
 * takes a red band of its own rather than a footnote. Everything here is
 * derived from `costPreview`, which is recomputed on the same render as the
 * Provider swap that caused it — there is no fetch between a swap and a new
 * number.
 */

export interface CostRow {
  index: number
  type: AgentType
  provider: string | null
  /** Base units, or null when the Node has no Provider yet. */
  price: string | null
}

export function CostPreview({
  preview,
  rows,
  className,
}: {
  preview: Preview
  rows: readonly CostRow[]
  className?: string
}) {
  return (
    <section
      aria-labelledby="cost-preview"
      data-over-budget={preview.overBudget ? "true" : "false"}
      className={cn(
        "flex flex-col gap-5 rounded-xl bg-card p-6 ring-1 ring-inset",
        preview.overBudget ? "ring-2 ring-status-bad/60" : "ring-border",
        className,
      )}
    >
      <h2 id="cost-preview" className="text-xl font-semibold">
        Cost preview
      </h2>

      <div className="grid gap-6 sm:grid-cols-2">
        <Figure
          label="Max cost of one Run"
          value={formatUsdt(preview.total)}
          tone={preview.overBudget ? "bad" : "default"}
        />
        <Figure
          label="Remaining Daily Fee Budget"
          value={preview.remaining === null ? "…" : formatUsdt(preview.remaining)}
        />
      </div>

      {preview.overBudget && preview.shortfall !== null ? (
        <p
          role="alert"
          className="rounded-lg bg-status-bad/10 px-4 py-3 text-lg font-bold text-status-bad ring-1 ring-status-bad/40 ring-inset"
        >
          Short by {formatUsdt(preview.shortfall)} {TOKEN_LABEL}. Raise the Daily Fee Budget in
          Settings or swap a Node for a cheaper Provider.
        </p>
      ) : null}

      <ol className="flex flex-col gap-1">
        {rows.map((row) => (
          <li
            key={row.index}
            className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 last:border-b-0"
          >
            <span className="text-sm">
              <span className="font-semibold tracking-wide uppercase">{row.type}</span>
              <span className="text-muted-foreground"> · {row.provider ?? "no Provider"}</span>
            </span>
            <span className="text-base font-semibold tabular-nums">
              {row.price === null ? "—" : formatUsdt(row.price)}
            </span>
          </li>
        ))}
        {rows.length === 0 ? (
          <li className="py-1.5 text-sm text-muted-foreground">No Nodes yet.</li>
        ) : null}
      </ol>
    </section>
  )
}

function Figure({
  label,
  value,
  tone = "default",
}: {
  label: string
  value: string
  tone?: "default" | "bad"
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
        {label}
      </span>
      <span
        className={cn(
          "text-4xl leading-none font-bold tabular-nums",
          tone === "bad" && "text-status-bad",
        )}
      >
        {value}
        <span className="ml-2 text-lg font-semibold text-muted-foreground">{TOKEN_LABEL}</span>
      </span>
    </div>
  )
}
