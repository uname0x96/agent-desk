import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import {
  PLATFORM_SETTINGS_ID,
  calls,
  listings,
  platformSettings,
  runs,
  settlements,
  wallets,
  workflows,
  type Database,
} from '@agent-desk/db'
import { SCORED_NODE_TYPES, type SettlementCandidate, type SettlementRowPlan } from '@agent-desk/core/settlement'
import { newId, type AgentType, type CallStatus, type PlatformMode, type SettlementResult, type Side } from '@agent-desk/schemas'
import type {
  RecordedSlash,
  SettlementFollowUp,
  SettlementRecord,
  SettlementStore,
  SettlementWork,
} from './ports.ts'

/**
 * The Postgres side of the settlement tick.
 *
 * The selection is Story 4.1's, spelled out in SQL so it cannot drift: `kind =
 * 'run'` — never a `verification` Call, which FR-11 exempts from scoring — a
 * `research` or `risk` Type, `succeeded` or `failed_after_payment`, and no
 * `settlements` row. `failed_after_payment` is in the periodic selection
 * deliberately: the engine also publishes a targeted `settlement.tick` for it,
 * and this is what recovers the Call when that job is dropped.
 *
 * The `execution` fill each `risk` candidate needs is a second query rather
 * than a fourth join, because it is one row per Run and only the `risk`
 * candidates want it.
 */

/** AD-9: the Types that are scored, as the SQL `in` list. */
const SCORED_TYPES = [...SCORED_NODE_TYPES] as AgentType[]

/** Story 4.1: the two statuses a scorable Call can be in. */
const SCORABLE_STATUSES: CallStatus[] = ['succeeded', 'failed_after_payment']

export function createSettlementStore(db: Database): SettlementStore {
  /** The columns every selection reads, so the two share one shape. */
  const workColumns = {
    callId: calls.id,
    listingId: calls.listingId,
    runId: calls.runId,
    kind: calls.kind,
    nodeType: calls.nodeType,
    status: calls.status,
    endedAt: calls.endedAt,
    referencePrice: calls.referencePrice,
    response: calls.response,
    lockedPrice: calls.lockedPrice,
    symbol: workflows.symbol,
    runEndedAt: runs.endedAt,
    registryListingId: listings.registryListingId,
    refundTo: wallets.address,
  }

  type WorkRow = {
    callId: string
    listingId: string
    runId: string | null
    kind: string
    nodeType: AgentType
    status: CallStatus
    endedAt: Date | null
    referencePrice: string | null
    response: unknown
    lockedPrice: string
    symbol: string
    runEndedAt: Date | null
    registryListingId: string | null
    refundTo: string | null
  }

  /**
   * AD-9: `p_fill` is the same Run's `FILLED` `execution` Call's
   * `reference_price`, and the side is the one the engine actually sent, which
   * is on that Call's request (`LONG` -> `BUY`, `SHORT` -> `SELL`).
   */
  async function fillsFor(runIds: readonly string[]): Promise<Map<string, SettlementCandidate['fill']>> {
    const ids = [...new Set(runIds)]
    if (ids.length === 0) return new Map()

    const rows = await db
      .select({
        runId: calls.runId,
        callId: calls.id,
        referencePrice: calls.referencePrice,
        request: calls.request,
        response: calls.response,
      })
      .from(calls)
      .where(
        and(
          eq(calls.kind, 'run'),
          eq(calls.nodeType, 'execution'),
          eq(calls.status, 'succeeded'),
          inArray(calls.runId, ids),
        ),
      )

    const fills = new Map<string, SettlementCandidate['fill']>()
    for (const row of rows) {
      if (!row.runId) continue
      const status = field(row.response, 'status')
      const side = field(row.request, 'side')
      fills.set(row.runId, {
        callId: row.callId,
        filled: status === 'FILLED',
        referencePrice: row.referencePrice,
        side: side === 'BUY' || side === 'SELL' ? (side as Side) : null,
      })
    }
    return fills
  }

  async function toWork(rows: readonly WorkRow[]): Promise<SettlementWork[]> {
    const riskRunIds = rows
      .filter((row) => row.nodeType === 'risk' && row.runId !== null)
      .map((row) => row.runId as string)
    const fills = await fillsFor(riskRunIds)

    return rows.map((row) => ({
      candidate: {
        callId: row.callId,
        listingId: row.listingId,
        runId: row.runId,
        kind: row.kind as SettlementCandidate['kind'],
        nodeType: row.nodeType,
        status: row.status,
        endedAt: row.endedAt,
        referencePrice: row.referencePrice,
        symbol: row.symbol,
        response: row.response,
        runEndedAt: row.runEndedAt,
        fill: (row.runId ? (fills.get(row.runId) ?? null) : null),
      },
      lockedPrice: row.lockedPrice,
      registryListingId: row.registryListingId,
      refundTo: row.refundTo,
    }))
  }

  return {
    async mode(): Promise<PlatformMode> {
      const [row] = await db
        .select({ mode: platformSettings.mode })
        .from(platformSettings)
        .where(eq(platformSettings.id, PLATFORM_SETTINGS_ID))
        .limit(1)
      return row?.mode ?? 'production'
    },

    async due(limit: number): Promise<SettlementWork[]> {
      const rows = await db
        .select(workColumns)
        .from(calls)
        .innerJoin(runs, eq(calls.runId, runs.id))
        .innerJoin(workflows, eq(runs.workflowId, workflows.id))
        .innerJoin(listings, eq(calls.listingId, listings.id))
        .innerJoin(wallets, eq(runs.walletId, wallets.id))
        .leftJoin(settlements, eq(settlements.callId, calls.id))
        .where(
          and(
            // FR-11: a verification Call is never scored, at any status.
            eq(calls.kind, 'run'),
            inArray(calls.nodeType, SCORED_TYPES),
            inArray(calls.status, SCORABLE_STATUSES),
            isNull(settlements.callId),
          ),
        )
        .orderBy(asc(calls.endedAt))
        .limit(limit)
      return toWork(rows as WorkRow[])
    },

    async workFor(callId: string): Promise<SettlementWork | null> {
      const rows = await db
        .select(workColumns)
        .from(calls)
        .innerJoin(runs, eq(calls.runId, runs.id))
        .innerJoin(workflows, eq(runs.workflowId, workflows.id))
        .innerJoin(listings, eq(calls.listingId, listings.id))
        .innerJoin(wallets, eq(runs.walletId, wallets.id))
        .where(
          and(
            eq(calls.id, callId),
            eq(calls.kind, 'run'),
            inArray(calls.nodeType, SCORED_TYPES),
            inArray(calls.status, SCORABLE_STATUSES),
          ),
        )
        .limit(1)
      const work = await toWork(rows as WorkRow[])
      return work[0] ?? null
    },

    async unfinished(limit: number): Promise<SettlementFollowUp[]> {
      const rows = await db
        .select({
          ...workColumns,
          settlementId: settlements.id,
          result: settlements.result,
          slashAmount: settlements.slashAmount,
          slashTxHash: settlements.slashTxHash,
          settlementRefundTo: settlements.refundTo,
          reputationTxHash: settlements.reputationTxHash,
        })
        .from(settlements)
        .innerJoin(calls, eq(settlements.callId, calls.id))
        .innerJoin(runs, eq(calls.runId, runs.id))
        .innerJoin(workflows, eq(runs.workflowId, workflows.id))
        .innerJoin(listings, eq(calls.listingId, listings.id))
        .innerJoin(wallets, eq(runs.walletId, wallets.id))
        .where(
          or(
            and(eq(settlements.result, 'failed'), isNull(settlements.slashTxHash)),
            and(
              inArray(settlements.result, ['passed', 'failed'] as SettlementResult[]),
              isNull(settlements.reputationTxHash),
            ),
          ),
        )
        .orderBy(asc(settlements.scoredAt))
        .limit(limit)

      const work = await toWork(rows as unknown as WorkRow[])
      return rows.map((row, index) => ({
        record: {
          id: row.settlementId,
          callId: row.callId,
          listingId: row.listingId,
          result: row.result,
          slashAmount: row.slashAmount,
          slashTxHash: row.slashTxHash,
          refundTo: row.settlementRefundTo,
          reputationTxHash: row.reputationTxHash,
        },
        work: work[index] as SettlementWork,
      }))
    },

    async find(callId: string): Promise<SettlementRecord | null> {
      const [row] = await db
        .select(recordColumns)
        .from(settlements)
        .where(eq(settlements.callId, callId))
        .limit(1)
      return row ?? null
    },

    /**
     * AD-9: `settlements.call_id` is unique, so `on conflict do nothing` is
     * where "each Call is settled at most once" is actually decided. A losing
     * insert reads the winner's row and works on that.
     */
    async insert(row: SettlementRowPlan): Promise<{ record: SettlementRecord; inserted: boolean }> {
      const [inserted] = await db
        .insert(settlements)
        .values({
          id: newId('settlement'),
          callId: row.callId,
          listingId: row.listingId,
          result: row.result,
          notScoredReason: row.notScoredReason,
          mode: row.mode,
          ruleLabel: row.ruleLabel,
          startPrice: row.startPrice,
          endPrice: row.endPrice,
          change24hPct: row.change24hPct,
          pFill: row.pFill,
          windowMin: row.windowMin,
          windowMax: row.windowMax,
          priceSource: row.priceSource,
          scoredAt: row.scoredAt,
        })
        .onConflictDoNothing({ target: settlements.callId })
        .returning(recordColumns)
      if (inserted) return { record: inserted, inserted: true }

      const [existing] = await db
        .select(recordColumns)
        .from(settlements)
        .where(eq(settlements.callId, row.callId))
        .limit(1)
      if (!existing) throw new Error(`settlement for ${row.callId} was neither inserted nor found`)
      return { record: existing, inserted: false }
    },

    async recordSlash(settlementId: string, slash: RecordedSlash): Promise<void> {
      await db
        .update(settlements)
        .set({
          slashAmount: slash.slashAmount,
          slashTxHash: slash.slashTxHash.toLowerCase(),
          refundTo: slash.refundTo.toLowerCase(),
        })
        .where(eq(settlements.id, settlementId))
    },

    async recordReputation(settlementId: string, txHash: string): Promise<void> {
      await db
        .update(settlements)
        .set({ reputationTxHash: txHash.toLowerCase() })
        .where(eq(settlements.id, settlementId))
    },

    /** AD-9: the last 30 scored rows, newest first. */
    async recentResults(listingId: string, limit: number): Promise<SettlementResult[]> {
      const rows = await db
        .select({ result: settlements.result })
        .from(settlements)
        .where(
          and(
            eq(settlements.listingId, listingId),
            inArray(settlements.result, ['passed', 'failed'] as SettlementResult[]),
          ),
        )
        .orderBy(desc(settlements.scoredAt), desc(settlements.id))
        .limit(limit)
      return rows.map((row) => row.result)
    },

    async reputationOf(listingId: string): Promise<number | null> {
      const [row] = await db
        .select({ bps: listings.reputationBps })
        .from(listings)
        .where(eq(listings.id, listingId))
        .limit(1)
      return row?.bps ?? null
    },

    /**
     * AD-8 writes `listings.last_error` for a listing intent that reverted, but
     * `slash:<call_id>` names a Call, not a Listing, so `listingIdOfIntent`
     * cannot find one. Story 4.3 still wants the reason on the row, so the
     * settlement job puts it there itself.
     */
    async noteListingError(listingId: string, message: string): Promise<void> {
      await db
        .update(listings)
        .set({ lastError: message, updatedAt: new Date() })
        .where(eq(listings.id, listingId))
    },
  }
}

const recordColumns = {
  id: settlements.id,
  callId: settlements.callId,
  listingId: settlements.listingId,
  result: settlements.result,
  slashAmount: settlements.slashAmount,
  slashTxHash: settlements.slashTxHash,
  refundTo: settlements.refundTo,
  reputationTxHash: settlements.reputationTxHash,
}

function field(value: unknown, name: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[name]
}
