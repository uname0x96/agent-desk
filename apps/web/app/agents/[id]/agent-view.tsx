"use client"

import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { ExternalLinkIcon } from "lucide-react"
import { cn } from "cn"
import type { AgentHistoryResponse, AgentType, ListingResponse } from "@agent-desk/schemas"
import {
  REPUTATION_MAX_BPS,
  describeVerification,
  pauseHistory,
  priceHistory,
  reputationChart,
  reputationSeries,
  reputationY,
  stakeHistory,
  type PricePoint,
  type ReputationPoint,
  type StakeEvent,
  type VerificationRecord,
} from "../../api/listings/listing-history.ts"
import {
  listingStatusLabel,
  reputationLabel,
} from "../../../components/marketplace/listing-model.ts"
import { AddressLink, TxHashLink } from "../../../components/chain-link.tsx"
import { JsonBlock } from "../../../components/json-block.tsx"
import { StatusBadge } from "../../../components/status-badge.tsx"
import { Separator } from "../../../components/ui/separator.tsx"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table.tsx"
import { errorMessage } from "../../../lib/api.ts"
import { useExplorerLink } from "../../../lib/explorer-context.tsx"
import {
  formatAddress,
  formatTimestamp,
  formatUsdt,
  TOKEN_LABEL,
  truncateMiddle,
} from "../../../lib/format.ts"
import { agentHistoryQueryOptions, agentListingQueryOptions } from "../agent-query.ts"

/**
 * FR-42: the page a Builder reads before putting an Agent in a Workflow.
 *
 * ┌─ AD-2 ─────────────────────────────────────────────────────────────────┐
 * │ Every number here is the Registry's own. The identity, the price, the  │
 * │ Stake and the Reputation come from the chain-owned columns of          │
 * │ `listings`, whose one writer is `refreshListingFromChain`; the four    │
 * │ histories are the `chain_tx` rows AD-8 wrote before it sent each       │
 * │ transaction. Nothing on this page is a claim the Agent makes about     │
 * │ itself, which is the whole reason the page exists.                     │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * The order is the order a sceptic reads in: who is this and what does it
 * charge, has it been right, what is it risking, and finally the one paid Call
 * that put it on the Registry, request and response in full.
 */
export function AgentView({
  listingId,
  registryAddress,
  identityRegistryAddress,
}: {
  listingId: string
  registryAddress: string
  identityRegistryAddress: string
}) {
  const listingQuery = useQuery(agentListingQueryOptions(listingId))
  const historyQuery = useQuery(agentHistoryQueryOptions(listingId))

  if (listingQuery.error) return <LoadError error={listingQuery.error} />
  if (historyQuery.error) return <LoadError error={historyQuery.error} />

  const listing = listingQuery.data
  const history = historyQuery.data
  if (listing === undefined || history === undefined) return <Skeleton />

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-8">
      <Header listing={listing} />
      <Identity
        listing={listing}
        registryAddress={registryAddress}
        identityRegistryAddress={identityRegistryAddress}
      />
      <Reputation listing={listing} history={history} />
      <Prices listing={listing} history={history} />
      <Stake listing={listing} history={history} />
      <Pauses listing={listing} history={history} />
      <Verification history={history} />
    </div>
  )
}

// ------------------------------------------------------------------ header

function Header({ listing }: { listing: ListingResponse }) {
  const status = listingStatusLabel(listing)

  return (
    <header className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-3">
            <TypeChip type={listing.type} />
            <StatusBadge status={status.text} tone={status.tone} />
          </div>
          <h1 className="text-4xl font-bold tracking-tight">{listing.name}</h1>
          <p className="max-w-3xl text-lg text-muted-foreground">
            {listing.description ?? "No description."}
          </p>
        </div>
        <Link
          href={`/marketplace?type=${listing.type}`}
          className="text-sm text-link underline-offset-4 hover:underline"
        >
          Back to the marketplace
        </Link>
      </div>

      {status.reason ? (
        <p className="rounded-lg bg-status-warn/10 px-4 py-3 text-base font-medium text-status-warn ring-1 ring-status-warn/40 ring-inset">
          {status.reason}
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-8 gap-y-6 md:grid-cols-4">
        <Fact label={`Price per call (${TOKEN_LABEL})`}>
          <span className="text-3xl font-semibold tabular-nums">{formatUsdt(listing.price)}</span>
        </Fact>
        <Fact label={`Stake at risk (${TOKEN_LABEL})`}>
          <span className="text-3xl font-semibold tabular-nums">{formatUsdt(listing.stake)}</span>
        </Fact>
        <Fact label="Owner">
          <AddressLink address={listing.owner_address} />
        </Fact>
        <Fact label="Endpoint">
          <span className="hash text-sm break-all">{listing.endpoint}</span>
        </Fact>
      </dl>
    </header>
  )
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

// ---------------------------------------------------------------- identity

/**
 * FR-5: the two ids that make this Agent findable by anyone who does not
 * believe the page. The ERC-8004 id belongs to the IdentityRegistry, the entry
 * id to `AgentDeskRegistry`; both link to the contract that holds them, from the
 * addresses `deployments/97.json` fixes (AD-10).
 */
function Identity({
  listing,
  registryAddress,
  identityRegistryAddress,
}: {
  listing: ListingResponse
  registryAddress: string
  identityRegistryAddress: string
}) {
  return (
    <Section
      title="On-chain identity"
      hint="The two entries this Agent is, on the two contracts that hold them."
    >
      <dl className="grid gap-6 sm:grid-cols-2">
        <RegistryId
          label="ERC-8004 agent id"
          value={listing.agent_id}
          contract="IdentityRegistry"
          address={identityRegistryAddress}
          target="token"
        />
        <RegistryId
          label="Registry listing id"
          value={listing.registry_listing_id}
          contract="AgentDeskRegistry"
          address={registryAddress}
          target="address"
        />
      </dl>
    </Section>
  )
}

function RegistryId({
  label,
  value,
  contract,
  address,
  target,
}: {
  label: string
  value: string | null
  contract: string
  address: string
  target: "address" | "token"
}) {
  const link = useExplorerLink()
  const checksummed = formatAddress(address)

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-muted/40 px-4 py-3 ring-1 ring-border ring-inset">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="flex flex-col gap-1">
        {value === null ? (
          <span className="text-2xl font-semibold text-muted-foreground">not minted yet</span>
        ) : (
          <a
            href={link(target, checksummed)}
            target="_blank"
            rel="noreferrer noopener"
            title={`${contract} at ${checksummed}`}
            data-registry={contract}
            className="hash inline-flex w-fit items-baseline gap-1.5 text-2xl font-semibold text-link underline-offset-4 hover:underline"
          >
            #{value}
            <ExternalLinkIcon className="size-4 shrink-0 self-center" aria-hidden />
          </a>
        )}
        <span className="text-sm text-muted-foreground">
          {contract} · <span className="hash">{truncateMiddle(checksummed)}</span>
        </span>
      </dd>
    </div>
  )
}

// -------------------------------------------------------------- reputation

/**
 * FR-36 / AD-9: Reputation is `passed / (passed + failed)` over the last 30
 * scored Calls, written on chain after every Settlement. The line is one point
 * per `reputation:` row, so what is drawn is the sequence of transactions, not a
 * recomputation of them.
 */
function Reputation({
  listing,
  history,
}: {
  listing: ListingResponse
  history: AgentHistoryResponse
}) {
  const label = reputationLabel(listing)
  const series = reputationSeries(history.rows)

  return (
    <Section
      title="Reputation history"
      hint="One point per on-chain Reputation write, oldest first. The axis is the whole 0–100 %."
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span
          className={cn(
            "font-bold",
            label.kind === "scored" ? "text-5xl tabular-nums" : "text-2xl text-muted-foreground",
          )}
        >
          {label.text}
        </span>
        <span className="text-base text-muted-foreground">{label.detail}</span>
      </div>

      <ReputationLine series={series} name={listing.name} />

      {series.length === 0 ? null : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Confirmed</TableHead>
              <TableHead className="text-right">Reputation</TableHead>
              <TableHead>Transaction</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {series.map((point) => (
              <TableRow key={point.intent_key} data-intent-key={point.intent_key}>
                <TableCell className="text-muted-foreground">{formatTimestamp(point.at)}</TableCell>
                <TableCell className="text-right tabular-nums">{percent(point.bps)}</TableCell>
                <TableCell>
                  <TxHashLink hash={point.tx_hash} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  )
}

/**
 * A plain inline `<polyline>`. A chart library would be a dependency for one
 * line of thirty points at most, and the geometry it would compute is a pure
 * function that is unit-tested next to the rest of the read model.
 */
function ReputationLine({ series, name }: { series: readonly ReputationPoint[]; name: string }) {
  const chart = reputationChart(series)
  if (chart === null) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-base text-muted-foreground">
        No Reputation has been written on chain for this Agent yet. The first one lands with its
        first settled Call.
      </p>
    )
  }

  const { box, dots, polyline } = chart
  const latest = dots.at(-1)

  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${box.width} ${box.height}`}
        preserveAspectRatio="none"
        role="img"
        data-points={String(dots.length)}
        aria-label={`Reputation of ${name} over ${dots.length} on-chain writes, ending at ${
          latest ? percent(latest.point.bps) : "no value"
        }`}
        className="h-40 w-full text-status-running"
      >
        {[0, REPUTATION_MAX_BPS / 2, REPUTATION_MAX_BPS].map((bps) => (
          <line
            key={bps}
            x1={0}
            x2={box.width}
            y1={reputationY(bps, box)}
            y2={reputationY(bps, box)}
            stroke="currentColor"
            strokeOpacity={0.15}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <polyline
          points={polyline}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {dots.map((dot) => (
          <circle
            key={dot.point.intent_key}
            cx={dot.x}
            cy={dot.y}
            r={4}
            fill="currentColor"
            vectorEffect="non-scaling-stroke"
          >
            <title>{`${percent(dot.point.bps)} · ${formatTimestamp(dot.point.at)}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="flex justify-between text-xs text-muted-foreground">
        <span>0 %</span>
        <span>
          {dots.length} on-chain {dots.length === 1 ? "write" : "writes"}
        </span>
        <span>100 %</span>
      </figcaption>
    </figure>
  )
}

// ------------------------------------------------------------------ prices

/**
 * FR-9 / AD-2: "price history is the `list:` row plus `price:` rows of
 * `chain_tx`". The first row is the price the Agent was listed at, which has no
 * old price to show, and every later row carries the `before` AD-8 captured at
 * enqueue rather than a number this page inferred.
 */
function Prices({
  listing,
  history,
}: {
  listing: ListingResponse
  history: AgentHistoryResponse
}) {
  const points = priceHistory(history.rows)

  return (
    <Section
      title="Price history"
      hint="Every price this Agent has charged, and the transaction that set it. A Run pays the price its Price Lock captured, never a later one."
    >
      {points.length === 0 ? (
        <Empty>No price has been written to the Registry for this Agent yet.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Confirmed</TableHead>
              <TableHead className="text-right">Old price</TableHead>
              <TableHead className="text-right">New price</TableHead>
              <TableHead>Transaction</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {points.map((point) => (
              <PriceRow key={point.intent_key} point={point} />
            ))}
          </TableBody>
        </Table>
      )}
      <p className="text-sm text-muted-foreground">
        Charging {formatUsdt(listing.price)} {TOKEN_LABEL} per call today.
      </p>
    </Section>
  )
}

function PriceRow({ point }: { point: PricePoint }) {
  return (
    <TableRow data-intent-key={point.intent_key} data-status={point.status}>
      <TableCell className="text-muted-foreground">{formatTimestamp(point.at)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {point.old_price === null ? (
          <span className="text-muted-foreground">listed</span>
        ) : (
          formatUsdt(point.old_price)
        )}
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        {formatUsdt(point.new_price)}
      </TableCell>
      <TableCell>
        <TxHashLink hash={point.tx_hash} />
      </TableCell>
    </TableRow>
  )
}

// ------------------------------------------------------------------- stake

/**
 * FR-7 and FR-35: the Stake only moves two ways. The Creator adds to it under a
 * `stake:` intent, and a failed Settlement takes from it under `slash:<call_id>`
 * — one transaction that pays the Builder back, which is why a Slash row names
 * the Call it refused and the wallet it refunded.
 */
function Stake({ listing, history }: { listing: ListingResponse; history: AgentHistoryResponse }) {
  const events = stakeHistory(history.rows)

  return (
    <Section
      title="Stake"
      hint="What this Agent stands to lose. A failed Settlement slashes the Call's price out of it and refunds the Builder in the same transaction."
    >
      <p className="flex items-baseline gap-2">
        <span className="text-4xl font-bold tabular-nums">{formatUsdt(listing.stake)}</span>
        <span className="text-base text-muted-foreground">{TOKEN_LABEL} locked in the Registry</span>
      </p>

      {events.length === 0 ? (
        <Empty>No Stake has moved since this Agent was listed.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Confirmed</TableHead>
              <TableHead>Change</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Stake after</TableHead>
              <TableHead>Transaction</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <StakeRow key={event.intent_key} event={event} />
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  )
}

function StakeRow({ event }: { event: StakeEvent }) {
  const slashed = event.kind === "slash"

  return (
    <TableRow data-intent-key={event.intent_key} data-kind={event.kind} data-status={event.status}>
      <TableCell className="text-muted-foreground">{formatTimestamp(event.at)}</TableCell>
      <TableCell>
        <span className={cn("font-medium", slashed ? "text-status-bad" : "text-status-ok")}>
          {slashed ? "slashed" : "topped up"}
        </span>
        {slashed && event.call_id ? (
          <span className="hash ml-2 text-xs text-muted-foreground">
            for Call {truncateMiddle(event.call_id, 8, 6)}
          </span>
        ) : null}
      </TableCell>
      <TableCell
        className={cn("text-right tabular-nums", slashed ? "text-status-bad" : "text-status-ok")}
      >
        {slashed ? "−" : "+"}
        {formatUsdt(event.amount)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {event.total === null ? (
          <span className="text-muted-foreground" title="the contract clamps a Slash to the stake it can still take">
            clamped on chain
          </span>
        ) : (
          formatUsdt(event.total)
        )}
      </TableCell>
      <TableCell>
        <TxHashLink hash={event.tx_hash} />
      </TableCell>
    </TableRow>
  )
}

// ------------------------------------------------------------------ pauses

/** AD-2: the pause history is the `pause:` rows, exactly as the price history is the `price:` rows. */
function Pauses({ listing, history }: { listing: ListingResponse; history: AgentHistoryResponse }) {
  const events = pauseHistory(history.rows)
  if (events.length === 0) return null

  return (
    <Section
      title="Pause history"
      hint="A paused Agent stays visible and stays out of new Runs; a Run already running finishes at its locked price."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Confirmed</TableHead>
            <TableHead>Change</TableHead>
            <TableHead>Transaction</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
            <TableRow key={event.intent_key} data-intent-key={event.intent_key}>
              <TableCell className="text-muted-foreground">{formatTimestamp(event.at)}</TableCell>
              <TableCell className="font-medium">
                {event.paused ? "paused by the creator" : "resumed by the creator"}
              </TableCell>
              <TableCell>
                <TxHashLink hash={event.tx_hash} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {listing.paused_by_stake ? (
        <p className="text-sm text-muted-foreground">
          The Registry is holding this Agent paused because its Stake fell below ten times its
          price.
        </p>
      ) : null}
    </Section>
  )
}

// ------------------------------------------------------------ verification

/**
 * FR-11: the one paid Call that put this Agent on the Registry, request and
 * response in full, because it is the only evidence that the endpoint answered
 * the Type's schema before anyone's money was at stake. AD-9 never scores a
 * `kind = 'verification'` Call, so this is a verification record and never a
 * settlement.
 */
function Verification({ history }: { history: AgentHistoryResponse }) {
  const record = describeVerification(history)

  return (
    <Section
      title="Verification Call"
      hint="One real, paid Call to the endpoint, made by the platform before the Agent was listed."
    >
      {record.kind === "call" ? <VerificationCall record={record} /> : <Empty>{record.note}</Empty>}
    </Section>
  )
}

function VerificationCall({ record }: { record: Extract<VerificationRecord, { kind: "call" }> }) {
  const call = record.call

  return (
    <div className="flex flex-col gap-6" data-call-id={call.id}>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 md:grid-cols-4">
        <Fact label="Status">
          <StatusBadge status={call.status} tone={call.status === "succeeded" ? "ok" : "bad"} />
        </Fact>
        <Fact label={`Paid (${TOKEN_LABEL})`}>
          <span className="text-xl font-semibold tabular-nums">{formatUsdt(call.locked_price)}</span>
        </Fact>
        <Fact label="Payment">
          <TxHashLink hash={call.payment_tx_hash} />
        </Fact>
        <Fact label="Paid to">
          <AddressLink address={call.locked_pay_to} />
        </Fact>
        <Fact label="Started">
          <span className="text-sm">{formatTimestamp(call.started_at)}</span>
        </Fact>
        <Fact label="Ended">
          <span className="text-sm">{formatTimestamp(call.ended_at)}</span>
        </Fact>
        <Fact label="Paid attempts">
          <span className="tabular-nums">{call.attempt}</span>
        </Fact>
        <Fact label="Never scored">
          <span className="text-sm text-muted-foreground">a verification Call is not settled</span>
        </Fact>
      </dl>

      {call.failure_reason === null ? null : (
        <p
          role="alert"
          className="rounded-lg bg-status-bad/10 px-4 py-3 text-base font-medium text-status-bad ring-1 ring-status-bad/40 ring-inset"
        >
          {call.failure_reason}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <JsonBlock title="Request" value={call.request} emptyLabel="nothing was sent" />
        <JsonBlock title="Response" value={call.response} emptyLabel="nothing came back" />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------- parts

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-4">
      <Separator />
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="max-w-3xl text-base text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  )
}

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

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-base text-muted-foreground">
      {children}
    </p>
  )
}

/** 10000 bps -> "100 %". AD-9 writes basis points; only the label is a percentage. */
function percent(bps: number): string {
  return `${Math.round(bps / 100)} %`
}

function Skeleton() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <div className="h-10 w-80 animate-pulse rounded-lg bg-muted" />
      <div className="h-32 animate-pulse rounded-xl bg-muted" />
      <div className="h-56 animate-pulse rounded-xl bg-muted" />
    </div>
  )
}

function LoadError({ error }: { error: unknown }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <p
        role="alert"
        className="rounded-lg bg-status-bad/10 px-4 py-3 text-base font-medium text-status-bad ring-1 ring-status-bad/40 ring-inset"
      >
        {errorMessage(error)}
      </p>
    </div>
  )
}
