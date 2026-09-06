import type { Database } from '@agent-desk/db'
import { SCORED_NODE_TYPES } from '@agent-desk/core/settlement'
import type { AgentType } from '@agent-desk/schemas'
import type { SettlementRecord } from './settlements-page.ts'

/**
 * The read behind `GET /api/settlements`: the `settlements` rows of the
 * signed-in account's Runs, joined to `calls`, `runs` and `listings`.
 *
 * `apps/web` depends on `@agent-desk/db` but not on `drizzle-orm` (`read-run.ts`
 * and `listings/query.ts` note the same), so this goes through the relational
 * query API, whose operators arrive as callback arguments. That API cannot
 * filter a parent by a column of a joined table, which is why the account scope
 * is four keyed reads rather than one statement: the account's Run ids, the
 * scorable Calls of those Runs, the settlements of those Calls, and the Listing
 * names of the page. Each read is keyed by ids the previous one produced, and
 * only the third is paginated, which is the one that grows.
 *
 * AD-9 is what keeps the middle read small and what makes the scope airtight in
 * both directions: only a `kind = 'run'` `research` or `risk` Call is ever
 * scored, and a `verification` Call has no `run_id` at all (`calls_run_id_matches_kind`),
 * so it cannot reach this list even by accident.
 */

export interface SettlementFilters {
  /** The session's account. Never a client-supplied id. */
  accountId: string
  /** `?run_id=`; a Run of another account simply matches nothing. */
  runId: string | null
  /** `?listing_id=`; the Provider whose scored Calls are wanted. */
  listingId: string | null
  /** `?cursor=`; the last `settlements.id` of the previous page. */
  cursor: string | null
}

const SCORED: readonly AgentType[] = SCORED_NODE_TYPES

/** `limit + 1` rows, so the caller can tell whether a next page exists. */
export async function selectSettlements(
  db: Database,
  filters: SettlementFilters,
  limit: number,
): Promise<SettlementRecord[]> {
  const runRows = await db.query.runs.findMany({
    where: (run, { and, eq }) =>
      and(
        eq(run.accountId, filters.accountId),
        filters.runId === null ? undefined : eq(run.id, filters.runId),
      ),
    columns: { id: true },
  })
  if (runRows.length === 0) return []

  const callRows = await db.query.calls.findMany({
    where: (call, { and, eq, inArray }) =>
      and(
        inArray(
          call.runId,
          runRows.map((run) => run.id),
        ),
        eq(call.kind, 'run'),
        inArray(call.nodeType, [...SCORED]),
        filters.listingId === null ? undefined : eq(call.listingId, filters.listingId),
      ),
    columns: { id: true, runId: true, nodeType: true },
  })
  if (callRows.length === 0) return []

  const settlementRows = await db.query.settlements.findMany({
    where: (settlement, { and, inArray, lt }) =>
      and(
        inArray(
          settlement.callId,
          callRows.map((call) => call.id),
        ),
        filters.cursor === null ? undefined : lt(settlement.id, filters.cursor),
      ),
    orderBy: (settlement, { desc }) => [desc(settlement.id)],
    limit: limit + 1,
  })
  if (settlementRows.length === 0) return []

  const callById = new Map(callRows.map((call) => [call.id, call]))
  const providers = await providerNames(
    db,
    settlementRows.map((settlement) => settlement.listingId),
  )

  return settlementRows.map((settlement) => {
    // The settlement was selected through this very Call, so a miss is a broken
    // database rather than a missing row, and a 500 says so more honestly than
    // a made-up Node type would. A missing Listing name is different: it is
    // cosmetic, so it falls back to the empty Provider `read-run.ts` uses.
    const call = callById.get(settlement.callId)
    if (!call) throw new Error(`settlement ${settlement.id} points at a Call that is gone`)
    return {
      id: settlement.id,
      callId: settlement.callId,
      listingId: settlement.listingId,
      result: settlement.result,
      notScoredReason: settlement.notScoredReason,
      mode: settlement.mode,
      ruleLabel: settlement.ruleLabel,
      priceSource: settlement.priceSource,
      startPrice: settlement.startPrice,
      endPrice: settlement.endPrice,
      change24hPct: settlement.change24hPct,
      pFill: settlement.pFill,
      windowMin: settlement.windowMin,
      windowMax: settlement.windowMax,
      scoredAt: settlement.scoredAt,
      slashAmount: settlement.slashAmount,
      slashTxHash: settlement.slashTxHash,
      refundTo: settlement.refundTo,
      reputationTxHash: settlement.reputationTxHash,
      runId: call.runId,
      nodeType: call.nodeType,
      provider: providers.get(settlement.listingId) ?? '',
    }
  })
}

/** The Listing name each row was scored against, keyed by `listing_id`. */
async function providerNames(
  db: Database,
  listingIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(listingIds)]
  if (ids.length === 0) return new Map()

  const rows = await db.query.listings.findMany({
    where: (listing, { inArray }) => inArray(listing.id, ids),
    columns: { id: true, name: true },
  })
  return new Map(rows.map((row) => [row.id, row.name]))
}
