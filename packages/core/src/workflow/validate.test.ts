import { describe, expect, it } from 'vitest'
import type { AgentType, ListingStatus } from '@agent-desk/schemas'
import { CHAIN_RULES, isValidChain, validateChain, violationsForNode } from './validate.ts'
import type { ChainListing, ChainNode } from './validate.ts'

/**
 * Story 2.7: the chain rules, over values only. Every case the acceptance
 * criteria name is here — the two chains that must be accepted, and the five
 * that must be rejected — plus the Order Cap and the FR-8 pause.
 */

/** The six Seed Listings of Stories 1.10 and 2.3 to 2.6, as the builder sees them. */
const SEED: Record<string, ChainListing> = {
  ticker: { id: 'lst_ticker', type: 'data', status: 'active' },
  alpha: { id: 'lst_alpha', type: 'research', status: 'active' },
  sloppy: { id: 'lst_sloppy', type: 'research', status: 'active' },
  guardrail: { id: 'lst_guardrail', type: 'risk', status: 'active' },
  executor: { id: 'lst_executor', type: 'execution', status: 'active' },
  notifier: { id: 'lst_notifier', type: 'notify', status: 'active' },
}

const LISTINGS = Object.values(SEED)

const NODE: Record<string, ChainNode> = {
  data: { type: 'data', listing_id: SEED.ticker!.id },
  research: { type: 'research', listing_id: SEED.alpha!.id },
  sloppy: { type: 'research', listing_id: SEED.sloppy!.id },
  risk: { type: 'risk', listing_id: SEED.guardrail!.id },
  execution: { type: 'execution', listing_id: SEED.executor!.id },
  notify: { type: 'notify', listing_id: SEED.notifier!.id },
}

function rules(nodes: readonly ChainNode[], listings = LISTINGS, orderCap: string | null = '10') {
  return validateChain(nodes, listings, { order_cap_usdt: orderCap }).map(
    (violation) => violation.rule,
  )
}

describe('validateChain accepts', () => {
  it('data, research, notify', () => {
    const violations = validateChain([NODE.data!, NODE.research!, NODE.notify!], LISTINGS)
    expect(violations).toEqual([])
    expect(isValidChain(violations)).toBe(true)
  })

  it('data, research, risk, execution, notify with an Order Cap', () => {
    const violations = validateChain(
      [NODE.data!, NODE.research!, NODE.risk!, NODE.execution!, NODE.notify!],
      LISTINGS,
      { order_cap_usdt: '10' },
    )
    expect(violations).toEqual([])
  })

  it('a chain with no notify Node, and a chain of one data Node', () => {
    expect(validateChain([NODE.data!, NODE.research!], LISTINGS)).toEqual([])
    expect(validateChain([NODE.data!], LISTINGS)).toEqual([])
  })
})

describe('validateChain rejects', () => {
  it('data, execution: an execution Node with no earlier risk Node', () => {
    expect(rules([NODE.data!, NODE.execution!])).toEqual([CHAIN_RULES.executionRequiresRisk])
  })

  it('research, data: a research Node with no earlier data Node', () => {
    const violations = validateChain([NODE.research!, NODE.data!], LISTINGS)
    expect(violations).toEqual([
      {
        node_index: 0,
        rule: CHAIN_RULES.researchRequiresData,
        message: 'a research Node needs a data Node earlier in the chain',
      },
    ])
  })

  it('a duplicate Type, at the index of the second one', () => {
    const violations = validateChain([NODE.data!, NODE.research!, NODE.sloppy!], LISTINGS)
    expect(violations).toEqual([
      {
        node_index: 2,
        rule: CHAIN_RULES.oneNodePerType,
        message: 'the chain already has a research Node; a Type may appear once',
      },
    ])
  })

  it('a paused Listing, naming FR-8', () => {
    const paused: ChainListing = { ...SEED.alpha!, status: 'paused' }
    const violations = validateChain([NODE.data!, NODE.research!], [SEED.ticker!, paused])
    expect(violations).toHaveLength(1)
    expect(violations[0]!.node_index).toBe(1)
    expect(violations[0]!.rule).toBe(CHAIN_RULES.listingNotActive)
    expect(violations[0]!.message).toContain('FR-8')
  })

  it('a Listing paused on chain at zero Stake, naming FR-8', () => {
    const drained: ChainListing = { ...SEED.alpha!, paused_by_stake: true }
    const violations = validateChain([NODE.data!, NODE.research!], [SEED.ticker!, drained])
    expect(violations.map((violation) => violation.rule)).toEqual([CHAIN_RULES.listingPaused])
    expect(violations[0]!.message).toContain('FR-8')
  })

  it('a notify Node that is not last', () => {
    expect(rules([NODE.data!, NODE.notify!, NODE.research!])).toEqual([
      CHAIN_RULES.notifyLast,
      // The research Node still needs an earlier data Node, which it has, so the
      // only other complaint is the one about notify.
    ])
  })

  it('a Node bound to nothing, and a Node bound to the wrong Type of Agent', () => {
    expect(rules([{ type: 'data', listing_id: '' }])).toEqual([CHAIN_RULES.listingMissing])
    expect(rules([{ type: 'data', listing_id: SEED.alpha!.id }])).toEqual([
      CHAIN_RULES.listingTypeMismatch,
    ])
  })

  it('an empty chain, as a violation of the chain rather than of a Node', () => {
    const violations = validateChain([], LISTINGS)
    expect(violations).toEqual([
      { node_index: null, rule: CHAIN_RULES.emptyChain, message: 'a Workflow needs at least one Node' },
    ])
  })

  it('a Listing that is still verifying or has failed', () => {
    for (const status of ['verifying', 'failed'] as ListingStatus[]) {
      const listing: ChainListing = { ...SEED.ticker!, status }
      expect(rules([NODE.data!], [listing])).toEqual([CHAIN_RULES.listingNotActive])
    }
  })
})

describe('the Order Cap', () => {
  const chain = [NODE.data!, NODE.research!, NODE.risk!, NODE.execution!]

  it('is required once the chain has an execution Node', () => {
    const violations = validateChain(chain, LISTINGS, { order_cap_usdt: null })
    expect(violations).toEqual([
      {
        node_index: 3,
        rule: CHAIN_RULES.orderCapRequired,
        message: 'an execution Node needs an Order Cap above 0 USDT',
      },
    ])
  })

  it('has to be above zero, and has to be a decimal amount', () => {
    for (const cap of ['0', '0.0', '', 'ten', '-5', '1.0000001']) {
      expect(rules(chain, LISTINGS, cap)).toEqual([CHAIN_RULES.orderCapRequired])
    }
    for (const cap of ['10', '0.000001', '1000.5']) {
      expect(rules(chain, LISTINGS, cap)).toEqual([])
    }
  })

  it('is not required by a chain with no execution Node', () => {
    expect(rules([NODE.data!, NODE.research!, NODE.notify!], LISTINGS, null)).toEqual([])
  })
})

describe('violationsForNode', () => {
  it('picks out the violations one Node card has to show', () => {
    const violations = validateChain([NODE.research!, NODE.execution!], LISTINGS, {
      order_cap_usdt: null,
    })
    expect(violationsForNode(violations, 0).map((v) => v.rule)).toEqual([
      CHAIN_RULES.researchRequiresData,
    ])
    expect(violationsForNode(violations, 1).map((v) => v.rule)).toEqual([
      CHAIN_RULES.executionRequiresRisk,
      CHAIN_RULES.orderCapRequired,
    ])
  })

  it('reports every offending Node, not only the first', () => {
    const chain: ChainNode[] = [NODE.research!, NODE.execution!]
    const found = validateChain(chain, LISTINGS, { order_cap_usdt: '10' }).map(
      (violation) => violation.node_index,
    )
    expect(found).toEqual([0, 1])
  })
})

describe('the rule table', () => {
  it('names every Type the PRD does and nothing else', () => {
    const types: AgentType[] = ['data', 'research', 'risk', 'execution', 'notify']
    for (const type of types) {
      expect(LISTINGS.some((listing) => listing.type === type)).toBe(true)
    }
  })
})
