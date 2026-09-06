import type { ReactNode } from "react"
import Link from "next/link"
import { cn } from "cn"
import type { AgentType, ListingResponse } from "@agent-desk/schemas"
import { AddressLink } from "../chain-link.tsx"
import { StatusBadge } from "../status-badge.tsx"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../ui/card.tsx"
import { agentHref } from "../../app/agents/agent-query.ts"
import { formatUsdt, TOKEN_LABEL } from "../../lib/format.ts"
import {
  listingStatusLabel,
  reputationLabel,
  type ReputationLabel,
} from "./listing-model.ts"

/**
 * FR-13: one marketplace card. Everything on it comes from
 * `GET /api/listings`, which carries the Registry's own values (AD-2).
 *
 * The layout answers the question the whole pitch rests on — is this Agent
 * good, and what is it risking — so Reputation and Stake are the two large
 * numbers in the middle of the card rather than two more rows of metadata.
 * Price sits beside the name as a price tag; owner, ERC-8004 id and the pause
 * reason sit below, where a judge looks second.
 *
 * `action` is the slot the Workflow Builder's Provider picker fills with its
 * select control; the picker reads `listingStatusLabel(listing).selectable`
 * for whether to disable it (FR-8).
 *
 * Story 5.4: the name is the link to `/agents/<listing_id>`, the Agent's full
 * on-chain record — price history, Reputation history, Stake and the paid
 * verification Call. A card is the summary; that page is the evidence behind it.
 */
export function ListingCard({
  listing,
  action,
}: {
  listing: ListingResponse
  action?: ReactNode
}) {
  const reputation = reputationLabel(listing)
  const status = listingStatusLabel(listing)

  return (
    <Card
      data-listing-id={listing.id}
      data-listing-type={listing.type}
      data-selectable={status.selectable}
      className={cn(
        "h-full gap-5",
        status.selectable ? "ring-foreground/10" : "bg-muted/40 ring-status-warn/40",
      )}
    >
      <CardHeader className="gap-3">
        <div className="flex items-center justify-between gap-3">
          <TypeChip type={listing.type} />
          <StatusBadge status={status.text} tone={status.tone} />
        </div>

        <div className="flex items-baseline justify-between gap-x-4">
          <CardTitle className="min-w-0 text-2xl leading-tight font-bold tracking-tight">
            <Link
              href={agentHref(listing.id)}
              className="underline-offset-4 hover:underline focus-visible:underline"
            >
              {listing.name}
            </Link>
          </CardTitle>
          <p className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap">
            <span className="text-2xl font-semibold tabular-nums">{formatUsdt(listing.price)}</span>
            <span className="text-sm text-muted-foreground">{TOKEN_LABEL} per call</span>
          </p>
        </div>

        <p className="line-clamp-2 min-h-13 text-base text-muted-foreground">
          {listing.description ?? "No description."}
        </p>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        <dl className="mt-auto grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border ring-1 ring-border">
          <Metric label="Reputation" detail={reputation.detail}>
            <span
              className={cn(
                "font-bold",
                reputation.kind === "scored"
                  ? cn("text-4xl tabular-nums", scoreToneClass(reputation.bps))
                  : "text-lg text-muted-foreground",
              )}
            >
              {reputation.text}
            </span>
          </Metric>

          <Metric label="Stake at risk" detail={`${TOKEN_LABEL} locked behind every Call`}>
            <span className="text-4xl font-bold tabular-nums">{formatUsdt(listing.stake)}</span>
          </Metric>
        </dl>

        {status.reason ? (
          <p className="rounded-lg bg-status-warn/10 px-3 py-2 text-sm font-medium text-status-warn ring-1 ring-status-warn/40 ring-inset">
            {status.reason}
          </p>
        ) : null}

        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Owner</dt>
          <dd className="justify-self-end">
            <AddressLink address={listing.owner_address} />
          </dd>
          <dt className="text-muted-foreground">ERC-8004 agent</dt>
          <dd className="hash justify-self-end">
            {listing.agent_id === null ? "—" : `#${listing.agent_id}`}
          </dd>
        </dl>
      </CardContent>

      {action ? <CardFooter>{action}</CardFooter> : null}
    </Card>
  )
}

function Metric({
  label,
  detail,
  children,
}: {
  label: string
  detail: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1 bg-card px-4 py-3">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="flex min-h-10 items-end leading-none">{children}</dd>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

/**
 * Reputation is `passed / (passed + failed)` (AD-9), so the colour is about
 * how often this Agent was right, on the same scale as every other status in
 * the app.
 */
function scoreToneClass(bps: number | null): string {
  if (bps === null) return "text-muted-foreground"
  if (bps >= 8000) return "text-status-ok"
  if (bps >= 5000) return "text-status-warn"
  return "text-status-bad"
}

/**
 * The five Types stay neutral on purpose: colour in this app means status, and
 * a red `execution` chip would read as a failure.
 */
function TypeChip({ type }: { type: AgentType }) {
  return (
    <span className="inline-flex w-fit items-center rounded-md bg-muted px-2.5 py-1 text-sm font-bold tracking-widest text-foreground uppercase ring-1 ring-border ring-inset">
      {type}
    </span>
  )
}

export type { ReputationLabel }
