import type { Database } from '@agent-desk/db'
import {
  PAID_CALL_STATUSES,
  RUN_FEED_DEFAULT_LIMIT,
  RUN_FEED_MAX_LIMIT,
  baseUnitsToString,
  runFeedQuery,
  sumBaseUnits,
  type AgentType,
  type CallKind,
  type CallStatus,
  type RunFeedQuery,
  type RunNodeView,
  type RunSummary,
} from '@agent-desk/schemas'

/**
 * `GET /api/runs?limit=&cursor=`: the account's Runs, newest first, as the
 * dashboard's live feed reads them (Story 5.1, FR-39).
 *
 * This is the list counterpart of `read-run.ts`, and it makes the same three
 * choices for the same reasons:
 *
 *   - the body is `runsResponse` from `packages/schemas` and the route parses
 *     its own answer against it before sending (AD-14);
 *   - `total_cost` is what has actually been paid — the AD-3 paid statuses
 *     summed over `locked_price` — not the Price Lock total, so a Run that
 *     failed at its second Node shows the one payment it made;
 *   - `apps/web` depends on `@agent-desk/db` but not on `drizzle-orm`, so the
 *     read goes through the relational query API, whose operators arrive as
 *     callback arguments, and the Workflow, the wallet and the Calls are small
 *     follow-up reads keyed by ids the first read already holds rather than one
 *     joined statement.
 *
 * The decisions are pure functions over rows so they can be tested without a
 * database; only `selectRunsForAccount` touches Postgres.
 */

// --------------------------------------------------------------- row shapes

/** The `calls` columns a feed row needs. `kind` is carried on purpose: see AD-3 below. */
export interface RunFeedCallRow {
  kind: CallKind
  nodeIndex: number
  nodeType: AgentType
  status: CallStatus
  /** Base units, from the Price Lock. */
  lockedPrice: string
}

/** One `runs` row with the three joins the response needs. */
export interface RunFeedRow {
  id: string
  workflowId: string
  /** Null when the Workflow is gone; the response then says so rather than crashing. */
  workflowName: string | null
  symbol: string | null
  status: string
  failureReason: string | null
  /** Lower-case, AD-13. Null when the wallet row is gone. */
  walletAddress: string | null
  createdAt: Date
  startedAt: Date | null
  endedAt: Date | null
  calls: readonly RunFeedCallRow[]
}

// ------------------------------------------------------------ pure decisions

/** AD-3: the three statuses in which a Call's `locked_price` has been spent. */
const PAID = new Set<string>(PAID_CALL_STATUSES)

/**
 * AD-3 again, and the reason `kind` is on `RunFeedCallRow`: a `verification`
 * Call belongs to a Listing and is paid by the Platform Wallet, so it is never
 * part of a Builder's Run cost. The query already filters it out; this filter
 * is what makes that true of the view model on its own, and what the test can
 * hold a mixed set of Calls against.
 */
function runCalls(calls: readonly RunFeedCallRow[]): RunFeedCallRow[] {
  return calls.filter((call) => call.kind === 'run')
}

/** The sum of `locked_price` over the Run's paid Calls, as a base-unit string. */
export function totalCost(calls: readonly RunFeedCallRow[]): string {
  const paid = runCalls(calls).filter((call) => PAID.has(call.status))
  return baseUnitsToString(sumBaseUnits(paid.map((call) => call.lockedPrice)))
}

/** The Run's Node Types in chain order, each with the status of its Call. */
export function toRunNodes(calls: readonly RunFeedCallRow[]): RunNodeView[] {
  return runCalls(calls)
    .slice()
    .sort((left, right) => left.nodeIndex - right.nodeIndex)
    .map((call) => ({ node_type: call.nodeType, status: call.status }))
}

/** One feed row. A missing join is named rather than left blank (see `RunFeedRow`). */
export function toRunSummary(row: RunFeedRow): RunSummary {
  return {
    id: row.id,
    workflow_id: row.workflowId,
    workflow_name: row.workflowName ?? 'unknown Workflow',
    symbol: row.symbol ?? '',
    status: row.status,
    failure_reason: row.failureReason,
    wallet_address: row.walletAddress,
    total_cost: totalCost(row.calls),
    created_at: row.createdAt.toISOString(),
    started_at: iso(row.startedAt),
    ended_at: iso(row.endedAt),
    nodes: toRunNodes(row.calls),
  }
}

/**
 * Keyset pagination over the id. Run ids are ULIDs (AD-13), whose first ten
 * characters are the creation time in base 32, so ordering by id descending is
 * ordering by newest first and a cursor needs no second column.
 *
 * The caller fetches `limit + 1` rows; the extra one is what says whether a
 * next page exists, and it is not returned.
 */
export function toRunFeedPage(
  rows: readonly RunFeedRow[],
  limit: number,
): { items: RunSummary[]; next: string | null } {
  const page = rows.slice(0, limit)
  const hasMore = rows.length > limit
  const last = page.at(-1)
  return {
    items: page.map(toRunSummary),
    next: hasMore && last ? last.id : null,
  }
}

/**
 * `?limit=&cursor=`, ending in `runFeedQuery` so the bounds the client builds
 * against and the ones the route enforces are one declaration (AD-14).
 *
 * A limit that is missing or unreadable falls back to the default and one above
 * the ceiling is clamped, rather than either being refused: the feed is a read
 * the dashboard makes on every beat, and an unreadable dashboard is a worse
 * answer than a page one row shorter than asked for. That is also the rule
 * `parsePageSize` already applies in `app/api/listings/listings-view.ts`.
 *
 * The cursor is passed through whenever it is there at all — a value that is
 * not a Run id simply matches nothing.
 */
export function parseRunFeedQuery(params: URLSearchParams): RunFeedQuery {
  const asked = Number(params.get('limit'))
  const limit =
    Number.isInteger(asked) && asked >= 1
      ? Math.min(asked, RUN_FEED_MAX_LIMIT)
      : RUN_FEED_DEFAULT_LIMIT
  const cursor = params.get('cursor')?.trim() ?? ''

  return runFeedQuery.parse({ limit, cursor: cursor === '' ? undefined : cursor })
}

// -------------------------------------------------------------------- read

/**
 * The account's Runs, newest first. `account_id` comes from the iron-session
 * cookie at the call site, never from the request, so there is no id here
 * anyone could tamper with.
 */
export async function selectRunsForAccount(
  db: Database,
  accountId: string,
  limit: number,
  cursor: string | null,
): Promise<RunFeedRow[]> {
  const runRows = await db.query.runs.findMany({
    where: (run, { and, eq, lt }) =>
      and(eq(run.accountId, accountId), cursor === null ? undefined : lt(run.id, cursor)),
    orderBy: (run, { desc }) => [desc(run.id)],
    limit: limit + 1,
  })
  if (runRows.length === 0) return []

  const runIds = runRows.map((run) => run.id)
  const workflowIds = [...new Set(runRows.map((run) => run.workflowId))]
  const walletIds = [...new Set(runRows.map((run) => run.walletId))]

  const [workflowRows, walletRows, callRows] = await Promise.all([
    db.query.workflows.findMany({
      where: (workflow, { inArray }) => inArray(workflow.id, workflowIds),
      columns: { id: true, name: true, symbol: true },
    }),
    db.query.wallets.findMany({
      where: (wallet, { inArray }) => inArray(wallet.id, walletIds),
      columns: { id: true, address: true },
    }),
    // AD-3: a `verification` Call has no Run, so `run_id in (...)` would drop it
    // anyway; `kind = 'run'` is stated so the Run cost never depends on that.
    db.query.calls.findMany({
      where: (call, { and, eq, inArray }) => and(inArray(call.runId, runIds), eq(call.kind, 'run')),
      orderBy: (call, { asc }) => [asc(call.nodeIndex)],
      columns: {
        runId: true,
        kind: true,
        nodeIndex: true,
        nodeType: true,
        status: true,
        lockedPrice: true,
      },
    }),
  ])

  const workflowById = new Map(workflowRows.map((workflow) => [workflow.id, workflow]))
  const walletById = new Map(walletRows.map((wallet) => [wallet.id, wallet]))

  const callsByRun = new Map<string, RunFeedCallRow[]>()
  for (const call of callRows) {
    if (call.runId === null) continue
    const bucket = callsByRun.get(call.runId) ?? []
    bucket.push({
      kind: call.kind,
      nodeIndex: call.nodeIndex,
      nodeType: call.nodeType,
      status: call.status,
      lockedPrice: call.lockedPrice,
    })
    callsByRun.set(call.runId, bucket)
  }

  return runRows.map((run) => {
    const workflow = workflowById.get(run.workflowId)
    return {
      id: run.id,
      workflowId: run.workflowId,
      workflowName: workflow?.name ?? null,
      symbol: workflow?.symbol ?? null,
      status: run.status,
      failureReason: run.failureReason,
      walletAddress: walletById.get(run.walletId)?.address ?? null,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      calls: callsByRun.get(run.id) ?? [],
    }
  })
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}
