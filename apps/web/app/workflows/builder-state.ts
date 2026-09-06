import {
  AGENT_TYPES,
  baseUnitsToString,
  sumBaseUnits,
  type AgentType,
  type ChainViolation,
  type ListingResponse,
  type SaveWorkflowRequest,
  type WorkflowResponse,
} from '@agent-desk/schemas'
import { validateChain, type ChainListing, type ChainNode } from '@agent-desk/core/workflow'

/**
 * Everything the Workflow Builder decides, as pure functions over values.
 *
 * The component below it holds one `BuilderState` in `useState` and calls these
 * on every edit, which is what makes "swapping one Node's Provider leaves every
 * other Node unchanged, re-validates, and re-prices" a property of the data
 * rather than a promise about the component: `withProvider` rewrites exactly one
 * element of `nodes`, and the violations and the cost preview are derived from
 * the result on the same render, so they can never be a keystroke behind.
 *
 * The validation itself is `validateChain` from `packages/core` — the same
 * function `POST /api/workflows` runs — so a chain the builder draws in green
 * cannot be refused by the API.
 */

/** FR-18: the MVP builder trades one pair. */
export const FIXED_SYMBOL = 'BNBUSDT'

/** The order the Type buttons are offered in, which is also a valid chain. */
export const TYPE_ORDER: readonly AgentType[] = AGENT_TYPES

/** What each Type does, in the words the Builder needs to choose one. */
export const TYPE_BLURB: Record<AgentType, string> = {
  data: 'Reads the market: last price, 24h change, 24h volatility.',
  research: 'Turns the market into a LONG, SHORT or HOLD signal.',
  risk: 'Approves, reduces or rejects the proposed order size.',
  execution: 'Places the spot order and reports the fill.',
  notify: 'Sends the Run summary, the costs and the hashes to Telegram.',
}

export interface BuilderNode {
  type: AgentType
  /** The chosen Listing, or "" while the Node is still waiting for a Provider. */
  listing_id: string
}

export interface BuilderState {
  name: string
  symbol: string
  /** Decimal USDT, as typed. Empty means "not set" (FR-4). */
  orderCapUsdt: string
  nodes: BuilderNode[]
}

export function emptyBuilderState(): BuilderState {
  return { name: '', symbol: FIXED_SYMBOL, orderCapUsdt: '', nodes: [] }
}

/** The state that edits an existing Workflow, from `GET /api/workflows/<id>`. */
export function builderStateFrom(
  workflow: WorkflowResponse,
  orderCapDecimal: string | null,
): BuilderState {
  return {
    name: workflow.name,
    symbol: workflow.symbol,
    orderCapUsdt: orderCapDecimal ?? '',
    nodes: [...workflow.nodes]
      .sort((left, right) => left.node_index - right.node_index)
      .map((node) => ({ type: node.type, listing_id: node.listing_id })),
  }
}

// ------------------------------------------------------------------- edits

/** A new Node of `type`, with no Provider yet: the Builder picks that next. */
export function withNode(nodes: readonly BuilderNode[], type: AgentType): BuilderNode[] {
  return [...nodes, { type, listing_id: '' }]
}

export function withoutNode(nodes: readonly BuilderNode[], index: number): BuilderNode[] {
  return nodes.filter((_, position) => position !== index)
}

/**
 * The Provider swap. Exactly one element changes; every other Node keeps the
 * Listing it was bound to, which is what the acceptance criteria require and
 * what the test asserts.
 */
export function withProvider(
  nodes: readonly BuilderNode[],
  index: number,
  listingId: string,
): BuilderNode[] {
  return nodes.map((node, position) =>
    position === index ? { ...node, listing_id: listingId } : node,
  )
}

/** Moves one Node one place along the chain, so an invalid order can be repaired. */
export function withMovedNode(
  nodes: readonly BuilderNode[],
  index: number,
  direction: -1 | 1,
): BuilderNode[] {
  const target = index + direction
  if (index < 0 || index >= nodes.length || target < 0 || target >= nodes.length) return [...nodes]
  const moved = [...nodes]
  const [node] = moved.splice(index, 1)
  moved.splice(target, 0, node!)
  return moved
}

// -------------------------------------------------------------- listings

export function listingsById(
  listings: readonly ListingResponse[],
): Map<string, ListingResponse> {
  return new Map(listings.map((listing) => [listing.id, listing]))
}

/**
 * The Providers offered for one Node. Paused and otherwise unavailable Listings
 * are still shown — FR-8 says a Builder should see why a Provider cannot be
 * used, not simply not find it — but `isProviderSelectable` marks them, and
 * picking one is a violation `validateChain` reports at that Node.
 */
export function providersForType(
  listings: readonly ListingResponse[],
  type: AgentType,
): ListingResponse[] {
  return listings
    .filter((listing) => listing.type === type)
    .sort((left, right) => comparePrice(left, right) || left.name.localeCompare(right.name))
}

export function isProviderSelectable(listing: ListingResponse): boolean {
  return listing.status === 'active' && !listing.paused_by_creator && !listing.paused_by_stake
}

function comparePrice(left: ListingResponse, right: ListingResponse): number {
  const difference = BigInt(left.price) - BigInt(right.price)
  return difference === 0n ? 0 : difference < 0n ? -1 : 1
}

/** The Listing shape `validateChain` reads, from a marketplace row. */
export function toChainListing(listing: ListingResponse): ChainListing {
  return {
    id: listing.id,
    type: listing.type,
    status: listing.status,
    paused_by_creator: listing.paused_by_creator,
    paused_by_stake: listing.paused_by_stake,
  }
}

// ------------------------------------------------------- price and budget

/**
 * FR-21: the max cost of the chain, in base units. A Node with no Provider yet
 * costs nothing, so the preview grows as the chain is assembled instead of
 * refusing to show a number until the last Node is bound.
 */
export function chainTotal(
  nodes: readonly BuilderNode[],
  byId: ReadonlyMap<string, ListingResponse>,
): string {
  const prices = nodes.map((node) => byId.get(node.listing_id)?.price ?? '0')
  return baseUnitsToString(sumBaseUnits(prices))
}

export interface CostPreview {
  /** Base units: the sum of the Nodes' current prices. */
  total: string
  /** Base units: `budget_remaining` from `GET /api/me`, or null while it loads. */
  remaining: string | null
  /** Base units: how much the chain is over the remaining budget, else null. */
  shortfall: string | null
  overBudget: boolean
}

export function costPreview(
  nodes: readonly BuilderNode[],
  byId: ReadonlyMap<string, ListingResponse>,
  budgetRemaining: string | null | undefined,
): CostPreview {
  const total = chainTotal(nodes, byId)
  if (budgetRemaining === null || budgetRemaining === undefined) {
    return { total, remaining: null, shortfall: null, overBudget: false }
  }
  const over = BigInt(total) - BigInt(budgetRemaining)
  return {
    total,
    remaining: budgetRemaining,
    shortfall: over > 0n ? baseUnitsToString(over) : null,
    overBudget: over > 0n,
  }
}

// ------------------------------------------------------------- the verdict

export interface ChainVerdict {
  violations: ChainViolation[]
  preview: CostPreview
  /** Empty when the chain can be saved. */
  saveBlockers: string[]
  /** Empty when the chain can be run. Always a superset of `saveBlockers`. */
  runBlockers: string[]
}

/**
 * One call per render: validate the chain, price it, and say in plain words why
 * saving or running is off. The two lists are what the buttons show, so a
 * disabled button on a projector always explains itself.
 */
export function judgeChain(
  state: BuilderState,
  listings: readonly ListingResponse[],
  budgetRemaining: string | null | undefined,
): ChainVerdict {
  const byId = listingsById(listings)
  const nodes: ChainNode[] = state.nodes.map((node) => ({
    type: node.type,
    listing_id: node.listing_id,
  }))
  const violations = validateChain(nodes, listings.map(toChainListing), {
    order_cap_usdt: state.orderCapUsdt === '' ? null : state.orderCapUsdt,
  })
  const preview = costPreview(state.nodes, byId, budgetRemaining)

  const saveBlockers: string[] = []
  if (state.name.trim().length === 0) saveBlockers.push('Name the Workflow.')
  if (state.nodes.length === 0) {
    saveBlockers.push('Add at least one Node.')
  } else if (violations.length > 0) {
    // One Node can break more than one rule at once, so this counts Nodes, not
    // violations: the Builder is being told how much of the chain to go and fix.
    const offending = new Set<number>()
    for (const violation of violations) {
      if (violation.node_index !== null) offending.add(violation.node_index)
    }
    if (offending.size === 0) {
      saveBlockers.push('The chain is not valid yet.')
    } else if (offending.size === 1) {
      saveBlockers.push('One Node is not valid yet.')
    } else {
      saveBlockers.push(`${offending.size} Nodes are not valid yet.`)
    }
  }

  const runBlockers = [...saveBlockers]
  if (preview.overBudget) {
    // The amount itself is on the cost preview, in the largest type on the page.
    runBlockers.push('The chain costs more than the remaining Daily Fee Budget.')
  }

  return { violations, preview, saveBlockers, runBlockers }
}

/** The request body `POST /api/workflows` and `PUT /api/workflows/<id>` take. */
export function toSaveRequest(state: BuilderState): SaveWorkflowRequest {
  return {
    name: state.name.trim(),
    symbol: state.symbol,
    order_cap_usdt: state.orderCapUsdt.trim() === '' ? null : state.orderCapUsdt.trim(),
    nodes: state.nodes.map((node) => ({ type: node.type, listing_id: node.listing_id })),
  }
}
