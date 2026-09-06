import {
  listOf,
  toBaseUnits,
  toDecimalUsdt,
  workflowResponse,
  type AgentType,
  type ListingStatus,
  type WorkflowResponse,
} from '@agent-desk/schemas'
import type { ChainListing } from '@agent-desk/core/workflow'

/**
 * The read model behind `/api/workflows`, as pure functions over rows.
 *
 * A Workflow is the chain plus the two Run-time settings the Builder chose:
 * the symbol and the Order Cap. Everything else on a Node — the Provider's
 * name, its current price, whether it is still `active` — belongs to the
 * Listing and is read fresh on every request, because that is exactly what the
 * builder's cost preview and `POST /api/runs` will disagree about if it is
 * cached anywhere.
 *
 * AD-13 on the two amount formats that meet here: the Order Cap is an order
 * size, so `workflows.order_cap_usdt` holds it as a decimal USDT string and the
 * engine reads it that way, while `workflowResponse.order_cap_usdt` is a
 * base-unit integer string like every other amount the API answers. The two
 * conversions of `packages/schemas` are the only crossing.
 */

/** The `workflows` row with the joins the response needs. */
export interface WorkflowRow {
  id: string
  name: string
  symbol: string
  /** Decimal USDT, as the column stores it. Null when the chain has no execution Node. */
  orderCapUsdt: string | null
  createdAt: Date
  nodes: readonly WorkflowNodeRow[]
  /** The status of the newest Run of this Workflow, or null when it has never run. */
  lastRunStatus: string | null
}

/** One Node joined to the Listing it is bound to. */
export interface WorkflowNodeRow {
  nodeIndex: number
  nodeType: AgentType
  listingId: string
  /** Null when the Listing is gone; the response then says so rather than crashing. */
  provider: string | null
  /** Base units, chain-owned. Null before the first confirmed `list:` receipt. */
  price: string | null
  status: ListingStatus | null
  pausedByCreator: boolean
  pausedByStake: boolean
}

/** AD-14: `GET /api/workflows` answers the shared list envelope. */
export const workflowsResponse = listOf(workflowResponse)

export function toWorkflowResponse(row: WorkflowRow): WorkflowResponse {
  return {
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    order_cap_usdt: orderCapToBaseUnits(row.orderCapUsdt),
    nodes: [...row.nodes]
      .sort((left, right) => left.nodeIndex - right.nodeIndex)
      .map((node) => ({
        node_index: node.nodeIndex,
        type: node.nodeType,
        listing_id: node.listingId,
        // A Listing can only disappear from under a Node if it was deleted by
        // hand; saying so beats an empty cell nobody can explain on a projector.
        provider: node.provider ?? 'unknown Provider',
        price: node.price ?? '0',
        status: node.status ?? 'failed',
      })),
    last_run_status: row.lastRunStatus,
    created_at: row.createdAt.toISOString(),
  }
}

export function toWorkflowsPage(
  rows: readonly WorkflowRow[],
  limit: number,
): { items: WorkflowResponse[]; next: string | null } {
  const page = rows.slice(0, limit)
  const hasMore = rows.length > limit
  const last = page.at(-1)
  return { items: page.map(toWorkflowResponse), next: hasMore && last ? last.id : null }
}

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 100

export function parsePageSize(value: string | null): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE
  return Math.min(parsed, MAX_PAGE_SIZE)
}

/** "10" -> "10000000". Null stays null; anything unparseable answers null too. */
export function orderCapToBaseUnits(decimal: string | null): string | null {
  if (decimal === null || decimal === '') return null
  try {
    return toBaseUnits(decimal).toString()
  } catch {
    return null
  }
}

/** "10000000" -> "10", the form the builder's Order Cap field holds. */
export function orderCapToDecimal(base: string | null): string | null {
  if (base === null) return null
  try {
    return toDecimalUsdt(base)
  } catch {
    return null
  }
}

/** The Listing shape `validateChain` reads, from a marketplace row. */
export function toChainListing(row: {
  id: string
  type: AgentType
  status: ListingStatus
  pausedByCreator: boolean
  pausedByStake: boolean
}): ChainListing {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    paused_by_creator: row.pausedByCreator,
    paused_by_stake: row.pausedByStake,
  }
}
