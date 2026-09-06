"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { cn } from "cn"
import { AGENT_TYPES, type AgentType, type ListingResponse } from "@agent-desk/schemas"
import {
  ListingGrid,
  ListingGridEmpty,
  ListingGridSkeleton,
} from "../../components/marketplace/listing-grid.tsx"
import {
  MARKETPLACE_SORTS,
  arrangeListings,
  sumBaseUnits,
  type MarketplaceSort,
  type MarketplaceView as MarketplaceViewState,
} from "../../components/marketplace/listing-model.ts"
import { errorMessage } from "../../lib/api.ts"
import { formatRelativeTime, formatUsdt, TOKEN_LABEL } from "../../lib/format.ts"
import {
  MARKETPLACE_POLL_MS,
  MARKETPLACE_PAGE_SIZE,
  marketplaceHref,
  marketplaceQueryOptions,
  parseView,
} from "./marketplace-query.ts"

/**
 * FR-13 / Story 3.5. The first screen a judge sees: every Listing on the
 * Registry, ranked by the evidence a Builder is supposed to choose on.
 *
 * The Type filter and the sort live in the URL, so a filtered marketplace can
 * be linked, reloaded, and put on a projector as-is. The same comparator that
 * `GET /api/listings?type=&sort=` is required to apply server-side is applied
 * here to whatever the route returns, so the two can never disagree.
 */
export function MarketplaceView() {
  const params = useSearchParams()
  const view = parseView(params.get("type"), params.get("sort"))
  const { data, error, isPending, dataUpdatedAt } = useQuery(marketplaceQueryOptions(view))

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-8 px-6 py-8">
      <MarketplaceHeader live={error === null} updatedAt={dataUpdatedAt} />
      <MarketplaceFilters view={view} />
      {error !== null ? (
        <MarketplaceError error={error} />
      ) : isPending || data === undefined ? (
        <ListingGridSkeleton />
      ) : (
        <MarketplaceResults view={view} page={data} />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ header

function MarketplaceHeader({ live, updatedAt }: { live: boolean; updatedAt: number }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold tracking-tight">Marketplace</h1>
        <p className="max-w-3xl text-lg text-muted-foreground">
          Every Agent on the Registry, with the Stake it has locked and the Reputation its settled
          Calls earned it. Pick a Provider for each Node on the evidence, not on the description.
        </p>
      </div>
      <PollIndicator live={live} updatedAt={updatedAt} />
    </header>
  )
}

/** Proof on a projector that the page really is following the chain. */
function PollIndicator({ live, updatedAt }: { live: boolean; updatedAt: number }) {
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
      Live · every {MARKETPLACE_POLL_MS / 1000} s
      {updatedAt === 0 ? null : (
        <> · updated {formatRelativeTime(new Date(updatedAt).toISOString(), now)}</>
      )}
    </span>
  )
}

// ----------------------------------------------------------------- filters

const SORT_LABEL: Record<MarketplaceSort, string> = {
  reputation: "Reputation",
  price: "Price",
}

function MarketplaceFilters({ view }: { view: MarketplaceViewState }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 border-y border-border py-4">
      <nav aria-label="Filter by Type" className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Type
        </span>
        <Pill href={marketplaceHref({ ...view, type: null })} active={view.type === null}>
          All
        </Pill>
        {AGENT_TYPES.map((type: AgentType) => (
          <Pill
            key={type}
            href={marketplaceHref({ ...view, type })}
            active={view.type === type}
          >
            {type}
          </Pill>
        ))}
      </nav>

      <nav aria-label="Sort listings" className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Sort by
        </span>
        {MARKETPLACE_SORTS.map((sort) => (
          <Pill
            key={sort}
            href={marketplaceHref({ ...view, sort })}
            active={view.sort === sort}
          >
            {SORT_LABEL[sort]}
          </Pill>
        ))}
      </nav>
    </div>
  )
}

function Pill({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-lg px-4 py-2 text-base font-semibold ring-1 ring-inset transition-colors",
        active
          ? "bg-primary text-primary-foreground ring-primary"
          : "text-muted-foreground ring-border hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </Link>
  )
}

// ----------------------------------------------------------------- results

function MarketplaceResults({
  view,
  page,
}: {
  view: MarketplaceViewState
  page: { items: ListingResponse[]; next: string | null }
}) {
  const listings = arrangeListings(page.items, view)

  if (listings.length === 0) {
    return (
      <ListingGridEmpty
        title={
          view.type === null
            ? "No Agent is listed yet."
            : `No ${view.type} Agent is listed yet.`
        }
        hint={
          view.type === null
            ? "A Listing appears here within five seconds of its Registry entry being confirmed."
            : "Clear the Type filter to see every Agent on the Registry."
        }
      />
    )
  }

  return (
    <section className="flex flex-col gap-5" aria-label="Listings">
      <MarketplaceSummary view={view} listings={listings} truncated={page.next !== null} />
      <ListingGrid listings={listings} />
    </section>
  )
}

function MarketplaceSummary({
  view,
  listings,
  truncated,
}: {
  view: MarketplaceViewState
  listings: readonly ListingResponse[]
  truncated: boolean
}) {
  const active = listings.filter((listing) => listing.status === "active").length
  const paused = listings.length - active
  const staked = sumBaseUnits(listings.map((listing) => listing.stake))
  const noun = listings.length === 1 ? "Agent" : "Agents"

  return (
    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base text-muted-foreground">
      <span className="text-foreground">
        <span className="font-semibold tabular-nums">{listings.length}</span>{" "}
        {view.type === null ? noun : `${view.type} ${noun}`}
      </span>
      <span aria-hidden>·</span>
      <span className="text-foreground">
        <span className="font-semibold tabular-nums">{formatUsdt(staked)}</span> {TOKEN_LABEL} staked
      </span>
      <span aria-hidden>·</span>
      <span>{active} active</span>
      {paused > 0 ? (
        <>
          <span aria-hidden>·</span>
          <span className="text-status-warn">{paused} paused, not selectable</span>
        </>
      ) : null}
      {truncated ? (
        <>
          <span aria-hidden>·</span>
          <span>showing the first {MARKETPLACE_PAGE_SIZE}</span>
        </>
      ) : null}
    </p>
  )
}

function MarketplaceError({ error }: { error: unknown }) {
  return (
    <p
      role="alert"
      className="rounded-lg bg-status-bad/10 px-4 py-3 text-base font-medium text-status-bad ring-1 ring-status-bad/40 ring-inset"
    >
      The marketplace could not be loaded: {errorMessage(error)}
    </p>
  )
}
