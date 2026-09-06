import type { Call, Database, Settlement } from '@agent-desk/db'
import {
  PAID_CALL_STATUSES,
  baseUnitsToString,
  runResponse,
  sumBaseUnits,
  type CallView,
  type RunResponse,
  type SettlementView,
} from '@agent-desk/schemas'

/**
 * `GET /api/runs/<id>`: the Run, its Price Lock, and every Call, as one JSON
 * body. This is what the live Run view of Story 1.9 polls every two seconds
 * (AD-12), so the shape is `runResponse` from `packages/schemas` and the route
 * parses its own answer against it before sending — a body that does not match
 * its schema is a 500 here rather than a broken screen there.
 *
 * `total_cost` is what has actually been paid: the AD-3 paid statuses, summed
 * over `locked_price`. It is deliberately not the Price Lock total, which is
 * what the Run *may* cost; a Run that failed at its second Node has to show the
 * one payment it made.
 *
 * `apps/web` depends on `@agent-desk/db` but not on `drizzle-orm` (Story 1.7
 * notes the same), so this goes through the relational query API, whose
 * operators arrive as callback arguments. That is also why the Workflow, the
 * wallet, the provider names, and the settlements are small follow-up reads
 * keyed by ids this function already holds rather than one joined statement:
 * a Run has at most five Calls, so it is five keys, once, per poll.
 */

const PAID = new Set<string>(PAID_CALL_STATUSES)

export async function readRun(db: Database, runId: string): Promise<RunResponse | null> {
  const run = await db.query.runs.findFirst({
    where: (table, { eq }) => eq(table.id, runId),
  })
  if (!run) return null

  const [workflow, wallet, callRows] = await Promise.all([
    db.query.workflows.findFirst({
      where: (table, { eq }) => eq(table.id, run.workflowId),
      columns: { name: true, symbol: true },
    }),
    db.query.wallets.findFirst({
      where: (table, { eq }) => eq(table.id, run.walletId),
      columns: { address: true },
    }),
    db.query.calls.findMany({
      where: (table, { and, eq }) => and(eq(table.runId, runId), eq(table.kind, 'run')),
      orderBy: (table, { asc }) => [asc(table.nodeIndex)],
    }),
  ])

  // Both are `not null` foreign keys, so a miss is a broken database rather than
  // a missing Run, and a 500 says so more honestly than a 404 would.
  if (!workflow) throw new Error(`run ${runId} points at a Workflow that is gone`)
  if (!wallet) throw new Error(`run ${runId} points at a wallet that is gone`)

  const [providers, settlementByCall] = await Promise.all([
    providerNames(db, callRows),
    settlementsByCall(db, callRows),
  ])

  const callViews: CallView[] = callRows.map((call) => ({
    id: call.id,
    kind: call.kind,
    node_index: call.nodeIndex,
    node_type: call.nodeType,
    listing_id: call.listingId,
    provider: providers.get(call.listingId) ?? '',
    status: call.status,
    locked_price: call.lockedPrice,
    locked_pay_to: call.lockedPayTo,
    locked_asset: call.lockedAsset,
    locked_network: call.lockedNetwork,
    request: call.request ?? null,
    response: call.response ?? null,
    payment_required: call.paymentRequired ?? null,
    payment_tx_hash: call.paymentTxHash,
    attempt: call.attempt,
    reference_price: call.referencePrice,
    reference_at: iso(call.referenceAt),
    failure_reason: call.failureReason,
    skip_reason: call.skipReason,
    started_at: iso(call.startedAt),
    ended_at: iso(call.endedAt),
    settlement: toSettlementView(settlementByCall.get(call.id)),
  }))

  const totalCost = sumBaseUnits(
    callRows.filter((call) => PAID.has(call.status)).map((call) => call.lockedPrice),
  )

  const body: RunResponse = {
    id: run.id,
    workflow_id: run.workflowId,
    workflow_name: workflow.name,
    symbol: workflow.symbol,
    status: run.status,
    failure_reason: run.failureReason,
    price_lock: run.priceLock,
    wallet_address: wallet.address,
    total_cost: baseUnitsToString(totalCost),
    created_at: run.createdAt.toISOString(),
    started_at: iso(run.startedAt),
    ended_at: iso(run.endedAt),
    calls: callViews,
  }

  return runResponse.parse(body)
}

/** The Listing name each Call was priced against, keyed by `listing_id`. */
async function providerNames(
  db: Database,
  callRows: readonly Call[],
): Promise<Map<string, string>> {
  const ids = [...new Set(callRows.map((call) => call.listingId))]
  if (ids.length === 0) return new Map()

  const rows = await db.query.listings.findMany({
    where: (table, { inArray }) => inArray(table.id, ids),
    columns: { id: true, name: true },
  })
  return new Map(rows.map((row) => [row.id, row.name]))
}

/** AD-9 scores a Call at most once, so this is one settlement per Call at most. */
async function settlementsByCall(
  db: Database,
  callRows: readonly Call[],
): Promise<Map<string, Settlement>> {
  const ids = callRows.map((call) => call.id)
  if (ids.length === 0) return new Map()

  const rows = await db.query.settlements.findMany({
    where: (table, { inArray }) => inArray(table.callId, ids),
  })
  return new Map(rows.map((row) => [row.callId, row]))
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}

function toSettlementView(row: Settlement | undefined): SettlementView | null {
  if (!row) return null
  return {
    id: row.id,
    call_id: row.callId,
    listing_id: row.listingId,
    result: row.result,
    not_scored_reason: row.notScoredReason,
    mode: row.mode,
    rule_label: row.ruleLabel,
    price_source: row.priceSource,
    start_price: row.startPrice,
    end_price: row.endPrice,
    change_24h_pct: row.change24hPct,
    p_fill: row.pFill,
    window_min: row.windowMin,
    window_max: row.windowMax,
    scored_at: row.scoredAt.toISOString(),
    slash_amount: row.slashAmount,
    slash_tx_hash: row.slashTxHash,
    refund_to: row.refundTo,
    reputation_tx_hash: row.reputationTxHash,
  }
}
