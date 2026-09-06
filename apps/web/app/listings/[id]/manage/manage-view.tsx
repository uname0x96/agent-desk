"use client"

import { useState } from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RefreshCwIcon } from "lucide-react"
import { cn } from "cn"
import type { ListingStatus } from "@agent-desk/schemas"
import type { ListingDetailResponse } from "../../../api/listings/listing-progress.ts"
import {
  canManage,
  manageHistory,
  type ManageHistoryRow,
} from "../../../api/listings/manage-history.ts"
import type { ListingTerms } from "../../../api/listings/manage-rules.ts"
import { TxHashLink } from "../../../../components/chain-link.tsx"
import { StatusBadge } from "../../../../components/status-badge.tsx"
import { Button } from "../../../../components/ui/button.tsx"
import { Input } from "../../../../components/ui/input.tsx"
import { Label } from "../../../../components/ui/label.tsx"
import { Separator } from "../../../../components/ui/separator.tsx"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../../components/ui/table.tsx"
import { errorMessage } from "../../../../lib/api.ts"
import { formatRelativeTime, formatUsdt, TOKEN_LABEL } from "../../../../lib/format.ts"
import { listingQueryKey } from "../../listing-query.ts"
import {
  addStake,
  MANAGE_POLL_MS,
  manageQueryOptions,
  refreshFromChain,
  setPaused,
  setPrice,
} from "../../manage-query.ts"
import {
  canSubmitPrice,
  canSubmitTopUp,
  pauseAction,
  pauseSummary,
  priceError,
  stakeAfter,
  stakeFloor,
  termsOf,
  topUpError,
} from "../../manage-state.ts"

/**
 * FR-7, FR-8, FR-9: the Creator's three levers on a listed Agent (Story 3.6).
 *
 * Each one is a single Registry transaction, and none of them is applied here:
 * the button enqueues an intent and the page then watches `chain_tx` — the same
 * two-second beat the listing page keeps — until the transaction confirms and
 * `refreshListingFromChain` writes the new terms back (AD-2, AD-8, AD-12). So
 * the numbers at the top of this page are always what the Registry says, never
 * what the Creator just typed.
 *
 * The refusals are `manage-state.ts` over `manage-rules.ts`, which is what the
 * three routes apply, so a price the Stake cannot carry is refused in the same
 * words before and after the request — and the shortfall is named rather than
 * discovered as a revert.
 */

export function ManageView({ listingId }: { listingId: string }) {
  const { data: listing, error, isPending } = useQuery(manageQueryOptions(listingId))

  if (isPending) return <Skeleton />
  if (error) return <Alert>{errorMessage(error)}</Alert>
  if (!listing.is_creator) return <Alert>Only the Creator of this Listing can manage it.</Alert>
  if (!canManage(listing)) return <NotOnChainYet listing={listing} />

  return <Manage listing={listing} />
}

// ------------------------------------------------------------------- layout

function Manage({ listing }: { listing: ListingDetailResponse }) {
  const terms = termsOf(listing)

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-8">
      <Header listing={listing} terms={terms} />
      <Separator />
      <div className="grid gap-8 md:grid-cols-2">
        <PriceForm listing={listing} terms={terms} />
        <TopUpForm listing={listing} terms={terms} />
      </div>
      <PauseSwitch listing={listing} terms={terms} />
      <Separator />
      <History listing={listing} />
    </div>
  )
}

function Header({ listing, terms }: { listing: ListingDetailResponse; terms: ListingTerms }) {
  return (
    <header className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight">{listing.name}</h1>
          <p className="text-sm text-muted-foreground">
            {listing.type} · registry entry #{listing.registry_listing_id ?? "—"} ·{" "}
            {pauseSummary(terms)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusBadge status={listing.status} tone={STATUS_TONE[listing.status]} size="lg" />
          <Link
            href={`/listings/${listing.id}`}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Back to the Listing
          </Link>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 md:grid-cols-4">
        <Fact label={`Price per call (${TOKEN_LABEL})`}>{formatUsdt(listing.price)}</Fact>
        <Fact label={`Stake (${TOKEN_LABEL})`}>{formatUsdt(listing.stake)}</Fact>
        <Fact label={`Stake floor at this price (${TOKEN_LABEL})`}>{stakeFloor(terms)}</Fact>
        <Fact label="Reputation">{reputation(listing.reputation_bps)}</Fact>
      </dl>

      <p className="text-sm text-muted-foreground">
        These are the Registry&rsquo;s numbers, not this page&rsquo;s. Every change below is one
        transaction; the values update when it confirms.
      </p>
    </header>
  )
}

// -------------------------------------------------------------------- price

function PriceForm({ listing, terms }: { listing: ListingDetailResponse; terms: ListingTerms }) {
  const [price, setPriceInput] = useState("")
  const change = useIntent((value: string) => setPrice(listing.id, value), listing.id, () =>
    setPriceInput(""),
  )

  const refusal = priceError(price, terms)
  const ready = canSubmitPrice(price, terms) && !change.isPending

  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) change.mutate(price)
      }}
    >
      <h2 className="text-lg font-semibold">Price per call</h2>
      <p className="text-sm text-muted-foreground">
        A Run that is already running keeps the price it locked. The new price applies to the next
        Call, and needs ten times itself in Stake.
      </p>
      <Label htmlFor="price">New price ({TOKEN_LABEL})</Label>
      <Input
        id="price"
        name="price"
        inputMode="decimal"
        placeholder={formatUsdt(listing.price)}
        value={price}
        onChange={(event) => setPriceInput(event.target.value)}
      />
      <FieldNote error={refusal ?? errorOf(change.error)}>
        Currently {formatUsdt(listing.price)} {TOKEN_LABEL}. More than 0, at most 1.
      </FieldNote>
      <div>
        <Button type="submit" disabled={!ready} size="lg">
          {change.isPending ? "Submitting…" : "Change price"}
        </Button>
      </div>
    </form>
  )
}

// ------------------------------------------------------------------- top-up

function TopUpForm({ listing, terms }: { listing: ListingDetailResponse; terms: ListingTerms }) {
  const [amount, setAmount] = useState("")
  const change = useIntent((value: string) => addStake(listing.id, value), listing.id, () =>
    setAmount(""),
  )

  const refusal = topUpError(amount)
  const after = stakeAfter(amount, terms)
  const ready = canSubmitTopUp(amount) && !change.isPending

  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) change.mutate(amount)
      }}
    >
      <h2 className="text-lg font-semibold">Top up the Stake</h2>
      <p className="text-sm text-muted-foreground">
        Pulled from your System Wallet into the Registry. A top-up that brings the Stake back to the
        floor also clears a pause the Registry set.
      </p>
      <Label htmlFor="amount">Amount to add ({TOKEN_LABEL})</Label>
      <Input
        id="amount"
        name="amount"
        inputMode="decimal"
        placeholder="0.1"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
      />
      <FieldNote error={refusal ?? errorOf(change.error)}>
        {after === null
          ? `Currently ${formatUsdt(listing.stake)} ${TOKEN_LABEL}.`
          : `${formatUsdt(listing.stake)} → ${after} ${TOKEN_LABEL}.`}
      </FieldNote>
      <div>
        <Button type="submit" disabled={!ready} size="lg">
          {change.isPending ? "Submitting…" : "Add Stake"}
        </Button>
      </div>
    </form>
  )
}

// -------------------------------------------------------------------- pause

function PauseSwitch({ listing, terms }: { listing: ListingDetailResponse; terms: ListingTerms }) {
  const action = pauseAction(terms)
  const change = useIntent((value: boolean) => setPaused(listing.id, value), listing.id)
  const failure = errorOf(change.error)

  return (
    <section className="flex flex-col gap-3 rounded-xl bg-card px-4 py-4 ring-1 ring-border">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-lg font-semibold">Availability</h2>
          <p className="max-w-xl text-sm text-muted-foreground">{action.detail}</p>
        </div>
        <Button
          type="button"
          size="lg"
          variant={action.next ? "destructive" : "default"}
          disabled={action.disabled || change.isPending}
          onClick={() => change.mutate(action.next)}
        >
          {change.isPending ? "Submitting…" : action.label}
        </Button>
      </div>
      {failure ? <Alert inline>{failure}</Alert> : null}
    </section>
  )
}

// ------------------------------------------------------------------ history

function History({ listing }: { listing: ListingDetailResponse }) {
  const client = useQueryClient()
  const rows = manageHistory(listing.chain_tx)
  const now = new Date()

  // AD-2's second caller: the route reads the Registry and writes the nine
  // chain-owned columns, and answers the refreshed Listing, so the reply
  // replaces the cache entry instead of costing another fetch.
  const refresh = useMutation({
    mutationFn: () => refreshFromChain(listing.id),
    onSuccess: (refreshed) => client.setQueryData(listingQueryKey(listing.id), refreshed),
  })

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">Changes</h2>
          <p className="text-sm text-muted-foreground">
            Every transaction this Listing has made, newest first. The page refetches every{" "}
            {MANAGE_POLL_MS / 1000} s while one is pending.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCwIcon className={cn(refresh.isPending ? "animate-spin" : null)} aria-hidden />
          {refresh.isPending ? "Reading the chain…" : "Refresh from chain"}
        </Button>
      </div>

      {refresh.error ? <Alert inline>{errorMessage(refresh.error)}</Alert> : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Intent</TableHead>
            <TableHead>Change</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Transaction</TableHead>
            <TableHead className="text-right">When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                No transaction yet.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => <HistoryRow key={row.intentKey} row={row} now={now} />)
          )}
        </TableBody>
      </Table>
    </section>
  )
}

function HistoryRow({ row, now }: { row: ManageHistoryRow; now: Date }) {
  return (
    <TableRow data-intent={row.intent} data-status={row.status}>
      <TableCell className="font-medium">{row.intent}</TableCell>
      <TableCell>{row.change}</TableCell>
      <TableCell>
        <StatusBadge status={row.status} tone={TX_TONE[row.status] ?? "idle"} />
      </TableCell>
      <TableCell>
        <TxHashLink hash={row.txHash} />
      </TableCell>
      <TableCell className="text-right whitespace-nowrap text-muted-foreground">
        {formatRelativeTime(row.confirmedAt ?? row.createdAt, now)}
      </TableCell>
    </TableRow>
  )
}

// -------------------------------------------------------------------- parts

const STATUS_TONE: Record<ListingStatus, "running" | "ok" | "warn" | "bad"> = {
  verifying: "running",
  active: "ok",
  paused: "warn",
  failed: "bad",
}

const TX_TONE: Record<string, "running" | "ok" | "warn" | "bad" | "idle"> = {
  pending: "running",
  confirmed: "ok",
  reverted: "bad",
  failed: "bad",
}

/**
 * One mutation shape for all three levers: send the intent, then invalidate the
 * shared listing query so the new `pending` row — and with it the poll — is on
 * screen without waiting out the current interval.
 */
function useIntent<TInput>(
  send: (input: TInput) => Promise<string>,
  listingId: string,
  onDone?: () => void,
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: send,
    onSuccess: async () => {
      onDone?.()
      await client.invalidateQueries({ queryKey: listingQueryKey(listingId) })
    },
  })
}

/** AD-2: `reputation_bps` is null until the Agent has been scored (Story 4.x). */
function reputation(bps: number | null): string {
  if (bps === null || bps === 0) return "no score yet"
  return `${bps / 100}%`
}

function errorOf(error: unknown): string | null {
  return error === null || error === undefined ? null : errorMessage(error)
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="text-2xl font-semibold tabular-nums">{children}</dd>
    </div>
  )
}

function FieldNote({ error, children }: { error: string | null; children: React.ReactNode }) {
  return error ? (
    <p role="alert" className="text-sm font-medium text-destructive">
      {error}
    </p>
  ) : (
    <p className="text-sm text-muted-foreground">{children}</p>
  )
}

function Alert({ children, inline = false }: { children: React.ReactNode; inline?: boolean }) {
  const alert = (
    <p
      role="alert"
      className="rounded-lg bg-status-bad/10 px-4 py-3 text-base font-medium text-status-bad ring-1 ring-status-bad/40 ring-inset"
    >
      {children}
    </p>
  )
  return inline ? alert : <div className="mx-auto w-full max-w-4xl px-6 py-8">{alert}</div>
}

/**
 * A Listing that is still `verifying` has nothing to manage — no Registry entry
 * exists yet — and a `failed` one never will. Both belong on the listing page,
 * which is where the pipeline is narrated.
 */
function NotOnChainYet({ listing }: { listing: ListingDetailResponse }) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-8">
      <h1 className="text-3xl font-bold tracking-tight">{listing.name}</h1>
      <p className="text-base text-muted-foreground">
        {listing.status === "failed"
          ? "This Listing never reached the Registry, so there is nothing on chain to change."
          : "This Listing is still going on chain. There is nothing to change until its Registry entry exists."}
      </p>
      <div>
        <Link
          href={`/listings/${listing.id}`}
          className="text-base underline underline-offset-4 hover:no-underline"
        >
          Follow it on the Listing page
        </Link>
      </div>
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
