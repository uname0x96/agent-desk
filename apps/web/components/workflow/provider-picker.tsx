"use client"

import { cn } from "cn"
import type { AgentType, ListingResponse } from "@agent-desk/schemas"
import { formatUsdt, TOKEN_LABEL } from "../../lib/format.ts"
import { isProviderSelectable } from "../../app/workflows/builder-state.ts"

/**
 * FR-20: the Provider swap.
 *
 * Every Provider of the Node's Type is on screen at once, cheapest first, with
 * its price in large type — a dropdown would hide exactly the comparison the
 * demo is about. Picking one rewrites a single Node, so the chain re-validates
 * and re-prices on the same render.
 *
 * FR-8: a paused Listing is shown rather than hidden, marked, and not
 * selectable, so a Builder can see that a Provider exists and why it cannot be
 * used right now.
 */
export function ProviderPicker({
  type,
  providers,
  selectedId,
  onPick,
}: {
  type: AgentType
  providers: readonly ListingResponse[]
  selectedId: string
  onPick: (listingId: string) => void
}) {
  if (providers.length === 0) {
    return (
      <p role="alert" className="text-base text-muted-foreground">
        No {type} Agent is listed on the marketplace yet.
      </p>
    )
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {providers.map((provider) => {
        const selectable = isProviderSelectable(provider)
        const chosen = provider.id === selectedId
        return (
          <li key={provider.id}>
            <button
              type="button"
              aria-pressed={chosen}
              disabled={!selectable}
              onClick={() => onPick(provider.id)}
              data-listing-id={provider.id}
              className={cn(
                "flex w-full flex-col gap-1 rounded-xl bg-background px-4 py-3 text-left ring-1 ring-inset transition-colors",
                chosen ? "ring-2 ring-primary" : "ring-border hover:bg-muted",
                !selectable && "cursor-not-allowed opacity-60 hover:bg-background",
              )}
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-lg font-bold">{provider.name}</span>
                <span className="text-lg font-bold tabular-nums">
                  {formatUsdt(provider.price)}
                  <span className="ml-1 text-sm font-semibold text-muted-foreground">
                    {TOKEN_LABEL}
                  </span>
                </span>
              </span>
              <span className="text-sm text-muted-foreground">
                {selectable ? (
                  provider.scored_call_count > 0 && provider.reputation_bps !== null ? (
                    `${(provider.reputation_bps / 100).toFixed(0)}% over ${provider.scored_call_count} scored Calls`
                  ) : (
                    "no score yet"
                  )
                ) : (
                  <span className="font-semibold text-status-bad">
                    {pauseReason(provider)} · not selectable (FR-8)
                  </span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function pauseReason(provider: ListingResponse): string {
  if (provider.paused_by_stake) return "paused at zero Stake"
  if (provider.paused_by_creator) return "paused by its Creator"
  return provider.status
}
