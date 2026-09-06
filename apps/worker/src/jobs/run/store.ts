import { and, asc, eq, sql } from 'drizzle-orm'
import {
  accounts,
  calls,
  listings,
  runs,
  workflowNodes,
  workflows,
  type Database,
} from '@agent-desk/db'
import { assertCallStatus, type CallState } from '@agent-desk/core/run'
import type { StoredPaymentPayload } from '@agent-desk/core/ports'
import type { AgentType, RunStatus, SkipReason } from '@agent-desk/schemas'
import type { CallPatch, RunCallRecord, RunRecord, RunStore } from './ports.ts'

/**
 * The Postgres side of the run engine.
 *
 * Two queries do the load, because a Run is a row plus its Calls and nothing
 * else needs to be joined twice: the Run with its Workflow and account, then the
 * Calls with the Listing each one pays. AD-2 is why the endpoint and the Listing
 * name come from `listings` at execution time rather than from the Price Lock —
 * the lock fixes the *price*, the chain owns the endpoint.
 *
 * The only clever line in the file is `endRun`, and it is the AD-4 rule: the
 * update is guarded on `status = 'running'` and reports whether it matched, so
 * two writers ending one Run can never both believe they did.
 */
export function createRunStore(db: Database): RunStore {
  return {
    async load(runId: string): Promise<RunRecord | null> {
      const [run] = await db
        .select({
          id: runs.id,
          workflowId: runs.workflowId,
          accountId: runs.accountId,
          walletId: runs.walletId,
          status: runs.status,
          failureReason: runs.failureReason,
          priceLock: runs.priceLock,
          startedAt: runs.startedAt,
          symbol: workflows.symbol,
          orderCapUsdt: workflows.orderCapUsdt,
          telegramChatId: accounts.telegramChatId,
        })
        .from(runs)
        .innerJoin(workflows, eq(runs.workflowId, workflows.id))
        .innerJoin(accounts, eq(runs.accountId, accounts.id))
        .where(eq(runs.id, runId))
        .limit(1)
      if (!run) return null

      const nodes = await db
        .select({ nodeType: workflowNodes.nodeType })
        .from(workflowNodes)
        .where(eq(workflowNodes.workflowId, run.workflowId))
        .orderBy(asc(workflowNodes.nodeIndex))

      const rows = await db
        .select({
          callId: calls.id,
          nodeIndex: calls.nodeIndex,
          nodeType: calls.nodeType,
          status: calls.status,
          attempt: calls.attempt,
          listingId: calls.listingId,
          lockedPrice: calls.lockedPrice,
          lockedPayTo: calls.lockedPayTo,
          lockedAsset: calls.lockedAsset,
          lockedNetwork: calls.lockedNetwork,
          request: calls.request,
          response: calls.response,
          paymentTxHash: calls.paymentTxHash,
          skipReason: calls.skipReason,
          // The engine only needs to know whether an authorization exists; the
          // header itself is read once, by `readPaymentPayload`, when it is used.
          hasPaymentPayload: sql<boolean>`${calls.paymentPayload} is not null`.as(
            'has_payment_payload',
          ),
          provider: listings.name,
          endpoint: listings.endpoint,
        })
        .from(calls)
        .innerJoin(listings, eq(calls.listingId, listings.id))
        .where(and(eq(calls.runId, runId), eq(calls.kind, 'run')))
        .orderBy(asc(calls.nodeIndex))

      return {
        id: run.id,
        workflowId: run.workflowId,
        accountId: run.accountId,
        walletId: run.walletId,
        status: run.status,
        failureReason: run.failureReason,
        priceLock: run.priceLock,
        startedAt: run.startedAt,
        symbol: run.symbol,
        orderCapUsdt: run.orderCapUsdt,
        telegramChatId: run.telegramChatId,
        nodeTypes: nodes.map((node) => node.nodeType) as readonly AgentType[],
        calls: rows.map(
          (row): RunCallRecord => ({
            callId: row.callId,
            nodeIndex: row.nodeIndex,
            nodeType: row.nodeType,
            // The column is a text enum in Postgres; the machine is the only
            // thing allowed to say which strings are statuses.
            status: assertCallStatus(row.status),
            attempt: row.attempt,
            hasPaymentPayload: row.hasPaymentPayload,
            listingId: row.listingId,
            provider: row.provider,
            endpoint: row.endpoint,
            lockedPrice: row.lockedPrice,
            lockedPayTo: row.lockedPayTo,
            lockedAsset: row.lockedAsset,
            lockedNetwork: row.lockedNetwork,
            request: row.request,
            response: row.response,
            paymentTxHash: row.paymentTxHash,
            skipReason: row.skipReason,
          }),
        ) satisfies readonly CallState[],
      }
    },

    /** AD-4: set at pickup and only if still null, so a redelivery never restarts the budget. */
    async markStarted(runId: string, at: Date): Promise<Date> {
      const [row] = await db
        .update(runs)
        .set({ startedAt: sql`coalesce(${runs.startedAt}, ${at.toISOString()}::timestamptz)` })
        .where(eq(runs.id, runId))
        .returning({ startedAt: runs.startedAt })
      return row?.startedAt ?? at
    },

    async updateCall(callId: string, patch: CallPatch): Promise<void> {
      const set: Record<string, unknown> = {}
      if (patch.status !== undefined) set.status = patch.status
      if (patch.request !== undefined) set.request = patch.request
      if (patch.response !== undefined) set.response = patch.response
      if (patch.paymentRequired !== undefined) set.paymentRequired = patch.paymentRequired
      if (patch.paymentTxHash !== undefined) set.paymentTxHash = patch.paymentTxHash
      if (patch.attempt !== undefined) set.attempt = patch.attempt
      if (patch.referencePrice !== undefined) set.referencePrice = patch.referencePrice
      if (patch.referenceAt !== undefined) set.referenceAt = patch.referenceAt
      if (patch.failureReason !== undefined) set.failureReason = patch.failureReason
      if (patch.endedAt !== undefined) set.endedAt = patch.endedAt
      // `started_at` is the Call's clock: the engine sets it once, at the first
      // request, and `signPayment` writes the same coalesce from its own side.
      if (patch.startedAt !== undefined) {
        set.startedAt = sql`coalesce(${calls.startedAt}, ${patch.startedAt.toISOString()}::timestamptz)`
      }
      if (Object.keys(set).length === 0) return
      await db.update(calls).set(set).where(eq(calls.id, callId))
    },

    /**
     * AD-4, the load-bearing line: a compare-and-set from `running`. Zero rows
     * updated means another writer — the timeout sweep, or a second delivery —
     * already ended this Run, and the engine must not write over it.
     */
    async endRun(
      runId: string,
      status: RunStatus,
      at: Date,
      failureReason: string | null,
    ): Promise<boolean> {
      const updated = await db
        .update(runs)
        .set({ status, endedAt: at, failureReason })
        .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
        .returning({ id: runs.id })
      return updated.length > 0
    },

    async skipPendingCalls(runId: string, reason: SkipReason, at: Date): Promise<number> {
      const updated = await db
        .update(calls)
        .set({ status: 'skipped', skipReason: reason, endedAt: at })
        .where(and(eq(calls.runId, runId), eq(calls.status, 'pending')))
        .returning({ id: calls.id })
      return updated.length
    },

    /**
     * FR-24: one Node the chain no longer needs. Guarded on `pending` for the
     * same reason `endRun` is guarded on `running` — a Call that has already
     * been paid for must never be rewritten as skipped.
     */
    async skipCall(callId: string, reason: SkipReason, at: Date): Promise<void> {
      await db
        .update(calls)
        .set({ status: 'skipped', skipReason: reason, endedAt: at })
        .where(and(eq(calls.id, callId), eq(calls.status, 'pending')))
    },

    async readPaymentPayload(callId: string): Promise<StoredPaymentPayload | null> {
      const [row] = await db
        .select({ paymentPayload: calls.paymentPayload })
        .from(calls)
        .where(eq(calls.id, callId))
        .limit(1)
      const payload = row?.paymentPayload
      if (!payload || typeof payload !== 'object') return null
      return payload as StoredPaymentPayload
    },
  }
}
