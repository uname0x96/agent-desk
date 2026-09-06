import { workflowNodes, workflows, type Database, type Listing } from '@agent-desk/db'
import type { AgentType } from '@agent-desk/schemas'
import type { WorkflowNodeRow, WorkflowRow } from './workflows-view.ts'

/**
 * The reads and the two writes behind `/api/workflows`.
 *
 * `apps/web` depends on `@agent-desk/db` but not on `drizzle-orm` (the same
 * note is on `app/api/runs/create-run.ts` and `lib/accounts.ts`), so every read
 * goes through the relational query API, whose comparison operators arrive as
 * callback arguments, the Workflow row is written with an upsert keyed on its
 * primary key — which needs no `where` — and the one statement that genuinely
 * needs a `where`, deleting a Workflow's Nodes before rewriting them, is issued
 * directly with an id this module has asserted to be a type-prefixed ULID
 * first, exactly as `lockAccountRow` does.
 */

/** AD-13: `wf_` and 26 Crockford base-32 characters, and nothing else, ever. */
const WORKFLOW_ID = /^wf_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

export function isWorkflowId(value: string): boolean {
  return WORKFLOW_ID.test(value)
}

/** The account's Workflows, newest first, keyset-paginated over the id (AD-13 ULIDs). */
export async function selectWorkflowsForAccount(
  db: Database,
  accountId: string,
  limit: number,
  cursor: string | null,
): Promise<WorkflowRow[]> {
  const rows = await db.query.workflows.findMany({
    where: (workflow, { and, eq, lt }) =>
      and(eq(workflow.accountId, accountId), cursor === null ? undefined : lt(workflow.id, cursor)),
    orderBy: (workflow, { desc }) => [desc(workflow.id)],
    limit: limit + 1,
  })
  return withNodesAndLastRun(db, rows)
}

/** One Workflow, for the builder's edit page and for the save routes' answer. */
export async function selectWorkflowById(
  db: Database,
  workflowId: string,
): Promise<WorkflowRow | null> {
  const row = await db.query.workflows.findFirst({
    where: (workflow, { eq }) => eq(workflow.id, workflowId),
  })
  if (!row) return null
  const [enriched] = await withNodesAndLastRun(db, [row])
  return enriched ?? null
}

/** The Listings a chain names, for `validateChain` and for the Node prices. */
export async function selectListingsByIds(
  db: Database,
  listingIds: readonly string[],
): Promise<Listing[]> {
  const ids = [...new Set(listingIds)].filter((id) => id.length > 0)
  if (ids.length === 0) return []
  return db.query.listings.findMany({ where: (listing, { inArray }) => inArray(listing.id, ids) })
}

export interface SaveWorkflowInput {
  workflowId: string
  accountId: string
  name: string
  symbol: string
  /** Decimal USDT, as `workflows.order_cap_usdt` stores it. */
  orderCapUsdt: string | null
  nodes: readonly { type: AgentType; listing_id: string }[]
}

/**
 * Insert or replace one Workflow and its Nodes in a single transaction, so a
 * `PUT` never leaves a half-rewritten chain behind. `account_id` is written on
 * insert and deliberately left out of the update, so an upsert can never
 * re-parent a Workflow to another Account.
 */
export async function saveWorkflow(db: Database, input: SaveWorkflowInput): Promise<void> {
  if (!isWorkflowId(input.workflowId)) {
    throw new Error(`refusing to save a malformed Workflow id: ${input.workflowId}`)
  }
  const now = new Date()

  await db.transaction(async (tx) => {
    await tx
      .insert(workflows)
      .values({
        id: input.workflowId,
        accountId: input.accountId,
        name: input.name,
        symbol: input.symbol,
        orderCapUsdt: input.orderCapUsdt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workflows.id,
        set: {
          name: input.name,
          symbol: input.symbol,
          orderCapUsdt: input.orderCapUsdt,
          updatedAt: now,
        },
      })

    await tx.execute(`delete from workflow_nodes where workflow_id = '${input.workflowId}'`)

    if (input.nodes.length > 0) {
      await tx.insert(workflowNodes).values(
        input.nodes.map((node, index) => ({
          workflowId: input.workflowId,
          nodeIndex: index,
          nodeType: node.type,
          listingId: node.listing_id,
        })),
      )
    }
  })
}

// ------------------------------------------------------------------ joins

type WorkflowRecord = typeof workflows.$inferSelect

/**
 * The Nodes of every Workflow on the page with their Listings, and the newest
 * Run of each, in three reads keyed by the page's ids rather than a join and a
 * correlated subquery — the same shape `app/api/listings/query.ts` uses.
 */
async function withNodesAndLastRun(
  db: Database,
  rows: readonly WorkflowRecord[],
): Promise<WorkflowRow[]> {
  if (rows.length === 0) return []
  const workflowIds = rows.map((row) => row.id)

  const nodeRows = await db.query.workflowNodes.findMany({
    where: (node, { inArray }) => inArray(node.workflowId, workflowIds),
    orderBy: (node, { asc }) => [asc(node.workflowId), asc(node.nodeIndex)],
  })

  const listingRows = await selectListingsByIds(
    db,
    nodeRows.map((node) => node.listingId),
  )
  const listingById = new Map(listingRows.map((listing) => [listing.id, listing]))

  const nodesByWorkflow = new Map<string, WorkflowNodeRow[]>()
  for (const node of nodeRows) {
    const listing = listingById.get(node.listingId)
    const bucket = nodesByWorkflow.get(node.workflowId) ?? []
    bucket.push({
      nodeIndex: node.nodeIndex,
      nodeType: node.nodeType,
      listingId: node.listingId,
      provider: listing?.name ?? null,
      price: listing?.price ?? null,
      status: listing?.status ?? null,
      pausedByCreator: listing?.pausedByCreator ?? false,
      pausedByStake: listing?.pausedByStake ?? false,
    })
    nodesByWorkflow.set(node.workflowId, bucket)
  }

  const lastRunByWorkflow = await selectLastRunStatuses(db, workflowIds)

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    orderCapUsdt: row.orderCapUsdt,
    createdAt: row.createdAt,
    nodes: nodesByWorkflow.get(row.id) ?? [],
    lastRunStatus: lastRunByWorkflow.get(row.id) ?? null,
  }))
}

/**
 * The newest Run per Workflow. Run ids are ULIDs, whose first ten characters
 * are the creation time in base 32, so ordering by id descending is ordering by
 * newest first and the first row seen per Workflow is the one wanted.
 */
async function selectLastRunStatuses(
  db: Database,
  workflowIds: readonly string[],
): Promise<Map<string, string>> {
  const runRows = await db.query.runs.findMany({
    where: (run, { inArray }) => inArray(run.workflowId, [...workflowIds]),
    orderBy: (run, { desc }) => [desc(run.id)],
    columns: { workflowId: true, status: true },
  })

  const byWorkflow = new Map<string, string>()
  for (const run of runRows) {
    if (!byWorkflow.has(run.workflowId)) byWorkflow.set(run.workflowId, run.status)
  }
  return byWorkflow
}
