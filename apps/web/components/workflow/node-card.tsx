import { cn } from "cn"
import type { AgentType } from "@agent-desk/schemas"
import { formatUsdt, TOKEN_LABEL } from "../../lib/format.ts"

/**
 * One Node of the chain, drawn the same way inside the graph and in the
 * inspector below it. Story 2.7 is shown on a projector, so the Provider name
 * is the largest thing on the card and a violation is a full-width red band
 * rather than an icon someone has to hover.
 */

export interface NodeCardProps {
  index: number
  type: AgentType
  /** Null while the Node is still waiting for a Provider. */
  provider: string | null
  /** Base units, or null when no Provider is bound yet. */
  price: string | null
  /** The messages `validateChain` reported for this Node, in rule order. */
  violations: readonly string[]
  selected?: boolean
  className?: string
}

export function NodeCard({
  index,
  type,
  provider,
  price,
  violations,
  selected = false,
  className,
}: NodeCardProps) {
  const invalid = violations.length > 0

  return (
    <div
      data-node-index={index}
      data-node-type={type}
      data-invalid={invalid ? "true" : "false"}
      className={cn(
        "flex w-[260px] flex-col gap-2 rounded-xl bg-card px-4 py-3 text-left ring-1 ring-inset transition-colors",
        invalid ? "bg-status-bad/10 ring-2 ring-status-bad/60" : "ring-border",
        selected && !invalid && "ring-2 ring-primary",
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
          {index + 1} · {type}
        </span>
        <span className="text-base font-semibold tabular-nums">
          {price === null ? "—" : `${formatUsdt(price)} ${TOKEN_LABEL}`}
        </span>
      </div>

      <p
        className={cn(
          "text-xl leading-tight font-bold",
          provider === null && "text-muted-foreground italic",
        )}
      >
        {provider ?? "no Provider"}
      </p>

      {invalid ? (
        <ul role="alert" className="flex flex-col gap-1">
          {violations.map((message) => (
            <li key={message} className="text-sm font-semibold text-status-bad">
              {message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
