import {
  isDecimalUsdt,
  toBaseUnits,
  type AgentType,
  type ChainViolation,
  type ListingStatus,
} from '@agent-desk/schemas'

/**
 * FR-17 to FR-19: the one definition of a valid Workflow chain.
 *
 * `POST /api/workflows`, `PUT /api/workflows/<id>` and the Workflow Builder all
 * call `validateChain`, so a chain the builder draws in green can never be
 * refused by the API, and a chain it draws in red can never be saved. The
 * function is pure over values — no database, no listings query — which is what
 * lets the same rules run on a keystroke in the browser and inside a
 * transaction on the server.
 *
 * Every violation carries the index of the Node it belongs to, so the builder
 * can render it inline at that Node, and a stable `rule` name, so a test and a
 * log line can name a rule without matching on prose. A violation about the
 * chain as a whole rather than one Node carries `node_index: null`
 * (`chainViolation` in `packages/schemas`).
 *
 * The listing rules are deliberately the same refusals `buildPriceLock` makes
 * in `apps/web/app/api/runs/admission.ts`: a Listing that is not `active`, or
 * that the chain says is paused, cannot be part of a new Run (FR-8), so the
 * builder has to refuse it at edit time rather than let `POST /api/runs` do it
 * after the Builder has pressed run.
 */

/** The rule names violations carry. Nothing invents a name outside this table. */
export const CHAIN_RULES = {
  emptyChain: 'empty_chain',
  oneNodePerType: 'one_node_per_type',
  notifyLast: 'notify_last',
  researchRequiresData: 'research_requires_data',
  riskRequiresResearch: 'risk_requires_research',
  executionRequiresRisk: 'execution_requires_risk',
  listingMissing: 'listing_missing',
  listingTypeMismatch: 'listing_type_mismatch',
  listingNotActive: 'listing_not_active',
  listingPaused: 'listing_paused',
  orderCapRequired: 'order_cap_required',
} as const

export type ChainRule = (typeof CHAIN_RULES)[keyof typeof CHAIN_RULES]

/** One step of the chain, exactly as `saveWorkflowRequest` states it. */
export interface ChainNode {
  type: AgentType
  listing_id: string
}

/**
 * As much of a Listing as validation reads. `GET /api/listings` answers a
 * superset of it, so the builder passes its marketplace rows straight in.
 */
export interface ChainListing {
  id: string
  type: AgentType
  status: ListingStatus
  paused_by_creator?: boolean
  paused_by_stake?: boolean
}

export interface ValidateChainOptions {
  /** `workflows.order_cap_usdt`: a decimal USDT string, null when unset (FR-4). */
  order_cap_usdt?: string | null
}

/** FR-17: which Type each Type needs to have seen earlier in the chain. */
const REQUIRES: Partial<Record<AgentType, { earlier: AgentType; rule: ChainRule }>> = {
  research: { earlier: 'data', rule: CHAIN_RULES.researchRequiresData },
  risk: { earlier: 'research', rule: CHAIN_RULES.riskRequiresResearch },
  execution: { earlier: 'risk', rule: CHAIN_RULES.executionRequiresRisk },
}

export function validateChain(
  nodes: readonly ChainNode[],
  listings: readonly ChainListing[],
  options: ValidateChainOptions = {},
): ChainViolation[] {
  if (nodes.length === 0) {
    return [
      {
        node_index: null,
        rule: CHAIN_RULES.emptyChain,
        message: 'a Workflow needs at least one Node',
      },
    ]
  }

  const violations: ChainViolation[] = []
  const byId = new Map(listings.map((listing) => [listing.id, listing]))
  const seen = new Set<AgentType>()
  const last = nodes.length - 1

  for (const [index, node] of nodes.entries()) {
    // -- order (FR-17) ----------------------------------------------------
    const requirement = REQUIRES[node.type]
    if (requirement && !seen.has(requirement.earlier)) {
      violations.push({
        node_index: index,
        rule: requirement.rule,
        message: `${article(node.type)} ${node.type} Node needs ${article(requirement.earlier)} ${requirement.earlier} Node earlier in the chain`,
      })
    }

    if (node.type === 'notify' && index !== last) {
      violations.push({
        node_index: index,
        rule: CHAIN_RULES.notifyLast,
        message: 'a notify Node can only be the last Node of the chain',
      })
    }

    if (seen.has(node.type)) {
      violations.push({
        node_index: index,
        rule: CHAIN_RULES.oneNodePerType,
        message: `the chain already has ${article(node.type)} ${node.type} Node; a Type may appear once`,
      })
    }
    seen.add(node.type)

    // -- the Listing the Node is bound to (FR-8, FR-18) -------------------
    violations.push(...listingViolations(index, node, byId.get(node.listing_id)))
  }

  // -- the Order Cap (FR-4) ------------------------------------------------
  const execution = nodes.findIndex((node) => node.type === 'execution')
  if (execution !== -1 && !isPositiveDecimal(options.order_cap_usdt)) {
    violations.push({
      node_index: execution,
      rule: CHAIN_RULES.orderCapRequired,
      message: 'an execution Node needs an Order Cap above 0 USDT',
    })
  }

  return violations.sort(byNodeIndex)
}

function listingViolations(
  index: number,
  node: ChainNode,
  listing: ChainListing | undefined,
): ChainViolation[] {
  if (!listing) {
    return [
      {
        node_index: index,
        rule: CHAIN_RULES.listingMissing,
        message: 'pick a Provider for this Node',
      },
    ]
  }

  if (listing.type !== node.type) {
    return [
      {
        node_index: index,
        rule: CHAIN_RULES.listingTypeMismatch,
        message: `this Provider is ${article(listing.type)} ${listing.type} Agent, not ${article(node.type)} ${node.type} Agent`,
      },
    ]
  }

  // AD-2: `paused` is one of the four listing statuses, and the two chain-owned
  // flags pause an otherwise `active` Listing. Both are the FR-8 pause as far
  // as a new Run is concerned, and both are named as such so the Builder reads
  // "this Provider ran out of Stake", not "invalid".
  if (listing.status !== 'active') {
    return [
      {
        node_index: index,
        rule: CHAIN_RULES.listingNotActive,
        message:
          listing.status === 'paused'
            ? 'this Provider is paused (FR-8) and cannot be part of a new Run'
            : `this Provider is ${listing.status}, not active`,
      },
    ]
  }

  if (listing.paused_by_creator === true || listing.paused_by_stake === true) {
    return [
      {
        node_index: index,
        rule: CHAIN_RULES.listingPaused,
        message:
          listing.paused_by_stake === true
            ? 'this Provider is paused on chain at zero Stake (FR-8)'
            : 'this Provider is paused on chain by its Creator (FR-8)',
      },
    ]
  }

  return []
}

/** "an execution Node", "a risk Node". The five Type names are the whole vocabulary. */
function article(type: AgentType): string {
  return type === 'execution' ? 'an' : 'a'
}

/** AD-13: an Order Cap is a decimal USDT string, so it is compared as base units. */
function isPositiveDecimal(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false
  if (!isDecimalUsdt(value)) return false
  try {
    return toBaseUnits(value) > 0n
  } catch {
    // More than six decimal places. Not an amount this system can carry.
    return false
  }
}

/** Chain-wide violations first, then in Node order, so the list reads top to bottom. */
function byNodeIndex(left: ChainViolation, right: ChainViolation): number {
  return (left.node_index ?? -1) - (right.node_index ?? -1)
}

/** True when the chain is savable and runnable. */
export function isValidChain(violations: readonly ChainViolation[]): boolean {
  return violations.length === 0
}

/** The violations that belong to one Node, for the inline message on its card. */
export function violationsForNode(
  violations: readonly ChainViolation[],
  nodeIndex: number,
): ChainViolation[] {
  return violations.filter((violation) => violation.node_index === nodeIndex)
}
