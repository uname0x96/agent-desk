"use client"

import { cn } from "cn"
import { AddressLink, TxHashLink } from "../../../../components/chain-link.tsx"
import { formatUsdt, TOKEN_LABEL } from "../../../../lib/format.ts"
import type { ArrowEndpoint, MoneyArrow, MoneyTotals } from "../../split-model.ts"

/**
 * FR-43, the right pane: per paid Call an arrow from the Builder's System
 * Wallet to the payout wallet, labelled with the amount as decimal tUSD
 * (AD-13) and the tx hash as an explorer link; for a scored Call whose
 * Settlement failed, an arrow back to the Builder's wallet labelled with the
 * Refund amount and the Slash tx hash. Underneath, the running totals.
 *
 * The Builder's wallet is always the left-hand chip, so the arrowhead alone
 * says which way the money went: pointing right is a payment leaving, pointing
 * left is a Refund landing. The arrows are plain CSS rules with an inline SVG
 * head; there is no diagram library in this build.
 */

export function MoneyFlow({ arrows }: { arrows: readonly MoneyArrow[] }) {
  if (arrows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing has moved yet. The first arrow appears the moment the engine signs for Node 1.
      </p>
    )
  }

  return (
    <ol className="flex flex-col gap-2">
      {arrows.map((arrow) => (
        <li key={arrow.id}>
          <ArrowRow arrow={arrow} />
        </li>
      ))}
    </ol>
  )
}

function ArrowRow({ arrow }: { arrow: MoneyArrow }) {
  const payment = arrow.kind === "payment"
  // The Builder's wallet is the constant party, so it holds the left-hand
  // chip in both directions and the counterparty holds the right-hand one.
  const builderSide = payment ? arrow.from : arrow.to
  const agentSide = payment ? arrow.to : arrow.from
  const tone = payment ? "text-status-running" : "text-status-ok"

  return (
    <article
      data-arrow-kind={arrow.kind}
      className={cn(
        "flex flex-col gap-1 rounded-lg px-3 py-2 ring-1 ring-inset",
        payment ? "bg-status-running/5 ring-status-running/25" : "bg-status-ok/10 ring-status-ok/30",
      )}
    >
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="min-w-0 truncate font-medium">{arrow.node_label}</span>
        <span className={cn("shrink-0 font-semibold uppercase", tone)}>
          {payment ? "payment" : "refund"}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <WalletChip endpoint={builderSide} />
        <ArrowLane arrow={arrow} facing={payment ? "right" : "left"} tone={tone} />
        <WalletChip endpoint={agentSide} align="right" />
      </div>
    </article>
  )
}

/** One end of an arrow: who it is, and the wallet it is, when it is a wallet. */
function WalletChip({
  endpoint,
  align = "left",
}: {
  endpoint: ArrowEndpoint
  align?: "left" | "right"
}) {
  return (
    <div
      className={cn(
        // Wide enough for a truncated address plus its explorer icon on one
        // line: the `hash` utility breaks on any character, so a chip a few
        // pixels too narrow drops the last one onto a line of its own.
        "flex w-[10rem] shrink-0 flex-col gap-0.5 overflow-hidden",
        align === "right" && "items-end text-right",
      )}
    >
      <span className="w-full truncate text-xs font-semibold" title={endpoint.label}>
        {endpoint.label}
      </span>
      {endpoint.address ? (
        <AddressLink address={endpoint.address} className="text-[11px] whitespace-nowrap" />
      ) : (
        // FR-35: a Refund is paid out of the Stake held by AgentDeskRegistry,
        // not out of the Creator's payout wallet, so there is no address to
        // link here and claiming one would be a lie.
        <span className="text-[11px] text-muted-foreground">held by the Registry</span>
      )}
    </div>
  )
}

function ArrowLane({
  arrow,
  facing,
  tone,
}: {
  arrow: MoneyArrow
  facing: "left" | "right"
  tone: string
}) {
  return (
    <div className="flex min-w-[5rem] flex-1 flex-col items-center gap-0.5">
      <span className="text-sm font-semibold tabular-nums">
        {formatUsdt(arrow.amount)} <span className="text-xs font-normal">{TOKEN_LABEL}</span>
      </span>

      <div className={cn("flex w-full items-center", tone)} aria-hidden>
        {facing === "left" ? <ArrowHead facing="left" /> : null}
        <span className={cn("h-px flex-1 bg-current", arrow.pending && "opacity-40")} />
        {facing === "right" ? <ArrowHead facing="right" /> : null}
      </div>

      <span className="max-w-full truncate text-[11px] whitespace-nowrap">
        {arrow.pending ? (
          <span className="text-muted-foreground">
            {arrow.kind === "payment" ? "settling…" : "slash pending"}
          </span>
        ) : (
          <TxHashLink hash={arrow.tx_hash} />
        )}
      </span>

      {arrow.amount_confirmed ? null : (
        // Before the `Slashed` event is read, the amount shown is the Call's
        // locked price; the contract clamps it to the remaining Stake (FR-35).
        <span className="text-[10px] text-muted-foreground">expected, not yet on chain</span>
      )}
    </div>
  )
}

/** The arrowhead. Inline SVG, so the direction is a path and not an image. */
function ArrowHead({ facing }: { facing: "left" | "right" }) {
  return (
    <svg viewBox="0 0 8 8" className="size-2 shrink-0" aria-hidden focusable="false">
      <path d={facing === "right" ? "M0 0 L8 4 L0 8 Z" : "M8 0 L0 4 L8 8 Z"} fill="currentColor" />
    </svg>
  )
}

/** The running totals under the arrows. */
export function MoneyTotalsStrip({ totals }: { totals: MoneyTotals }) {
  return (
    <dl className="grid shrink-0 grid-cols-3 gap-2 border-t border-border px-4 py-2">
      <Total
        label="Paid"
        amount={totals.paid}
        count={totals.payment_count}
        className="text-status-running"
      />
      <Total
        label="Refunded"
        amount={totals.refunded}
        count={totals.refund_count}
        className="text-status-ok"
      />
      <Total label="Net cost" amount={totals.net} />
    </dl>
  )
}

function Total({
  label,
  amount,
  count,
  className,
}: {
  label: string
  amount: string
  count?: number
  className?: string
}) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
        {count === undefined ? null : <span className="ml-1 normal-case">({count})</span>}
      </dt>
      <dd className={cn("text-lg font-semibold tabular-nums", className)}>
        {formatUsdt(amount)} <span className="text-xs font-normal">{TOKEN_LABEL}</span>
      </dd>
    </div>
  )
}
