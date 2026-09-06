"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { cn } from "cn"
import {
  CheckIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  MinusIcon,
  XIcon,
} from "lucide-react"
import type { ListingStatus } from "@agent-desk/schemas"
import type {
  ListingDetailResponse,
  ListingStep,
  ListingStepState,
  ListingStepView,
} from "../../api/listings/listing-progress.ts"
import { AddressLink, TxHashLink } from "../../../components/chain-link.tsx"
import { StatusBadge } from "../../../components/status-badge.tsx"
import { buttonVariants } from "../../../components/ui/button.tsx"
import { Separator } from "../../../components/ui/separator.tsx"
import { errorMessage } from "../../../lib/api.ts"
import { formatRelativeTime, formatUsdt, TOKEN_LABEL } from "../../../lib/format.ts"
import { LISTING_POLL_MS, listingQueryOptions, resubmitHref } from "../listing-query.ts"
import { manageHref } from "../manage-query.ts"

/**
 * FR-12 / AD-12: the Creator watching their Agent go on chain.
 *
 * The Listing is refetched every two seconds while it is `verifying` and not
 * once it is not, so each of the three steps lands on screen within two seconds
 * of happening. That is the whole design of this page: a stranger who pasted a
 * URL thirty seconds ago should be able to point at which step is running,
 * which one refused, and why — which is why every step carries its own sentence
 * and its own transaction rather than sharing one spinner.
 */

const STEP_TITLE: Record<ListingStep, string> = {
  verification: "Verification Call",
  identity: "ERC-8004 identity",
  list: "Registry entry",
}

const STEP_SUBTITLE: Record<ListingStep, string> = {
  verification: "One real paid Call to your endpoint, at the price you declared.",
  identity: "An identity token minted around this Listing’s agentURI.",
  list: "The Registry entry that locks your Stake and makes the card visible.",
}

export function ListingView({ listingId }: { listingId: string }) {
  const { data: listing, error, isPending, dataUpdatedAt } = useQuery(listingQueryOptions(listingId))

  if (isPending) return <Skeleton />
  if (error) return <LoadError error={error} />

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-8">
      <Header listing={listing} updatedAt={dataUpdatedAt} />
      <Steps listing={listing} />
      <Outcome listing={listing} />
    </div>
  )
}

// ------------------------------------------------------------------ header

const STATUS_TONE: Record<ListingStatus, "running" | "ok" | "warn" | "bad"> = {
  verifying: "running",
  active: "ok",
  paused: "warn",
  failed: "bad",
}

function Header({ listing, updatedAt }: { listing: ListingDetailResponse; updatedAt: number }) {
  return (
    <header className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight">{listing.name}</h1>
          <p className="hash text-sm break-all text-muted-foreground">
            {listing.type} · {listing.endpoint}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusBadge status={listing.status} tone={STATUS_TONE[listing.status]} size="lg" />
          <PollIndicator live={listing.status === "verifying"} updatedAt={updatedAt} />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 md:grid-cols-4">
        <Fact label={`Price per call (${TOKEN_LABEL})`}>
          <span className="text-2xl font-semibold tabular-nums">
            {formatUsdt(listing.declared_price)}
          </span>
        </Fact>
        <Fact label={`Stake (${TOKEN_LABEL})`}>
          <span className="text-2xl font-semibold tabular-nums">
            {formatUsdt(listing.declared_stake)}
          </span>
        </Fact>
        <Fact label="Payout wallet">
          <AddressLink address={listing.payout_wallet} />
        </Fact>
        <Fact label="ERC-8004 id">
          <span className="hash">{listing.agent_id ?? "—"}</span>
        </Fact>
      </dl>
    </header>
  )
}

/** Proof on a projector that the page really is following the pipeline. */
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
      Live · every {LISTING_POLL_MS / 1000} s
      {updatedAt === 0 ? null : (
        <> · updated {formatRelativeTime(new Date(updatedAt).toISOString(), now)}</>
      )}
    </span>
  )
}

// ------------------------------------------------------------------- steps

const STATE_STYLE: Record<
  ListingStepState,
  { ring: string; text: string; icon: typeof CheckIcon; spin?: boolean }
> = {
  waiting: { ring: "bg-muted text-muted-foreground ring-border", text: "text-muted-foreground", icon: CircleDashedIcon },
  running: {
    ring: "bg-status-running/15 text-status-running ring-status-running/40",
    text: "text-foreground",
    icon: LoaderCircleIcon,
    spin: true,
  },
  done: { ring: "bg-status-ok/15 text-status-ok ring-status-ok/40", text: "text-foreground", icon: CheckIcon },
  failed: { ring: "bg-status-bad/15 text-status-bad ring-status-bad/40", text: "text-foreground", icon: XIcon },
  skipped: { ring: "bg-muted text-muted-foreground ring-border", text: "text-muted-foreground", icon: MinusIcon },
}

function Steps({ listing }: { listing: ListingDetailResponse }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Going on chain
      </h2>
      <ol className="flex flex-col">
        {listing.steps.map((step, index) => (
          <Step
            key={step.step}
            step={step}
            last={index === listing.steps.length - 1}
            listing={listing}
          />
        ))}
      </ol>
    </section>
  )
}

function Step({
  step,
  last,
  listing,
}: {
  step: ListingStepView
  last: boolean
  listing: ListingDetailResponse
}) {
  const style = STATE_STYLE[step.state]
  const Icon = style.icon

  return (
    <li data-step={step.step} data-state={step.state} className="flex gap-4">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
            style.ring,
          )}
        >
          <Icon className={cn("size-4.5", style.spin ? "animate-spin" : null)} aria-hidden />
        </span>
        {last ? null : <span className="w-px flex-1 bg-border" aria-hidden />}
      </div>

      <div className={cn("flex flex-1 flex-col gap-1 pb-8", style.text)}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className="text-lg font-semibold">{STEP_TITLE[step.step]}</h3>
          <span className="text-sm text-muted-foreground">{step.state}</span>
        </div>
        <p className="text-base">{step.detail ?? STEP_SUBTITLE[step.step]}</p>
        {step.tx_hash ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            {step.step === "verification" ? "Payment" : "Transaction"}
            <TxHashLink hash={step.tx_hash} />
          </p>
        ) : null}
        {step.step === "verification" ? <VerificationFacts listing={listing} /> : null}
      </div>
    </li>
  )
}

/**
 * AD-3: the verification Call is a `calls` row like any other payment, and this
 * is the part of it worth showing — what was locked, and how many attempts it
 * took. It never reserves Stake and is never scored; it is the platform's money.
 */
function VerificationFacts({ listing }: { listing: ListingDetailResponse }) {
  const call = listing.verification
  if (call === null) return null

  return (
    <dl className="mt-2 flex flex-wrap gap-x-8 gap-y-2 text-sm">
      <div className="flex items-center gap-2">
        <dt className="text-muted-foreground">Locked price</dt>
        <dd className="tabular-nums">
          {formatUsdt(call.locked_price)} {TOKEN_LABEL}
        </dd>
      </div>
      <div className="flex items-center gap-2">
        <dt className="text-muted-foreground">Paid to</dt>
        <dd>
          <AddressLink address={call.locked_pay_to} />
        </dd>
      </div>
      <div className="flex items-center gap-2">
        <dt className="text-muted-foreground">Paid attempts</dt>
        <dd className="tabular-nums">{call.attempt}</dd>
      </div>
    </dl>
  )
}

// ----------------------------------------------------------------- outcome

function Outcome({ listing }: { listing: ListingDetailResponse }) {
  if (listing.status === "failed") {
    return (
      <section className="flex flex-col gap-4">
        <Separator />
        <p
          role="alert"
          className="rounded-lg bg-status-bad/10 px-4 py-3 text-base font-medium text-status-bad ring-1 ring-status-bad/40 ring-inset"
        >
          {listing.last_error ?? "The listing failed."}
        </p>
        <p className="text-base text-muted-foreground">
          Nothing was minted and no Stake moved. Fix the one thing above and submit again.
        </p>
        {listing.is_creator ? (
          <div>
            <Link href={resubmitHref(listing.id)} className={buttonVariants({ size: "lg" })}>
              Fix and resubmit
            </Link>
          </div>
        ) : null}
      </section>
    )
  }

  if (listing.status === "verifying") {
    return (
      <p className="text-base text-muted-foreground">
        Nothing is signed until the verification Call is paid for and its answer matches the{" "}
        {listing.type} output schema. This page follows every step; leaving it does not stop the
        pipeline.
      </p>
    )
  }

  return (
    <section className="flex flex-col gap-4">
      <Separator />
      <p className="text-base">
        {listing.status === "paused"
          ? "Your Agent is on the Registry but paused, so no new Run can select it. A Run already running finishes at its locked price."
          : "Your Agent is on the Registry. Any Builder can put it in a Workflow, and every Call to it pays your payout wallet directly."}
      </p>
      <div className="flex flex-wrap gap-3">
        {/* Story 3.6: the price, the Stake and the pause switch live one click away. */}
        {listing.is_creator ? (
          <Link href={manageHref(listing.id)} className={buttonVariants({ size: "lg" })}>
            Manage this Listing
          </Link>
        ) : null}
        <Link
          href={`/marketplace?type=${listing.type}`}
          className={buttonVariants({ variant: "outline", size: "lg" })}
        >
          See the marketplace card
        </Link>
        <a
          href={`/api/listings/${listing.id}/agent.json`}
          target="_blank"
          rel="noreferrer noopener"
          className={buttonVariants({ variant: "outline", size: "lg" })}
        >
          Agent card JSON
        </a>
      </div>
    </section>
  )
}

// ------------------------------------------------------------------- parts

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  )
}

function Skeleton() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
      <div className="h-9 w-72 animate-pulse rounded-lg bg-muted" />
      <div className="h-40 animate-pulse rounded-xl bg-muted" />
    </div>
  )
}

function LoadError({ error }: { error: unknown }) {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <p
        role="alert"
        className="rounded-lg bg-status-bad/10 px-4 py-3 text-base font-medium text-status-bad ring-1 ring-status-bad/40 ring-inset"
      >
        {errorMessage(error)}
      </p>
    </div>
  )
}
