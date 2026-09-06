import { describe, expect, it } from 'vitest'
import { toBaseUnits, type AgentType, type ListingResponse } from '@agent-desk/schemas'
import { CHAIN_RULES } from '@agent-desk/core/workflow'
import {
  FIXED_SYMBOL,
  chainTotal,
  costPreview,
  emptyBuilderState,
  judgeChain,
  listingsById,
  providersForType,
  toSaveRequest,
  withMovedNode,
  withNode,
  withProvider,
  withoutNode,
  type BuilderNode,
  type BuilderState,
} from './builder-state.ts'

/**
 * Story 2.7: the cost preview and the Provider swap, over the six Seed Listings
 * of Stories 1.10 and 2.3 to 2.6 at the PRD addendum §2 prices. The acceptance
 * criteria fix both totals — 0.095 tUSD for the good chain, 0.075 tUSD after
 * the swap to Sloppy Research — so those are asserted verbatim.
 */

function listing(
  id: string,
  name: string,
  type: AgentType,
  price: string,
  overrides: Partial<ListingResponse> = {},
): ListingResponse {
  return {
    id,
    name,
    description: null,
    type,
    endpoint: 'http://localhost:4101',
    status: 'active',
    last_error: null,
    price: toBaseUnits(price).toString(),
    stake: toBaseUnits('0.30').toString(),
    reputation_bps: null,
    scored_call_count: 0,
    paused_by_creator: false,
    paused_by_stake: false,
    payout_wallet: '0x1e4a2f7d3c9b60518a7d3f2c4b8e91d0a6c73f52',
    owner_address: '0x1e4a2f7d3c9b60518a7d3f2c4b8e91d0a6c73f52',
    creator_account_id: 'acc_01M1V0V1493YH1F8AZMMQ42JZ7',
    agent_id: '28',
    registry_listing_id: '27',
    created_at: '2026-09-06T09:29:56.651Z',
    ...overrides,
  }
}

const TICKER = listing('lst_ticker', 'Binance Ticker', 'data', '0.01')
const ALPHA = listing('lst_alpha', 'Alpha Research', 'research', '0.05')
const SLOPPY = listing('lst_sloppy', 'Sloppy Research', 'research', '0.03')
const GUARDRAIL = listing('lst_guardrail', 'Guardrail Risk', 'risk', '0.02')
const EXECUTOR = listing('lst_executor', 'Binance Spot Executor', 'execution', '0.01')
const NOTIFIER = listing('lst_notifier', 'Telegram Notifier', 'notify', '0.005')

const CATALOGUE = [TICKER, ALPHA, SLOPPY, GUARDRAIL, EXECUTOR, NOTIFIER]
const BY_ID = listingsById(CATALOGUE)

const GOOD_CHAIN: BuilderNode[] = [
  { type: 'data', listing_id: TICKER.id },
  { type: 'research', listing_id: ALPHA.id },
  { type: 'risk', listing_id: GUARDRAIL.id },
  { type: 'execution', listing_id: EXECUTOR.id },
  { type: 'notify', listing_id: NOTIFIER.id },
]

function state(nodes: BuilderNode[], overrides: Partial<BuilderState> = {}): BuilderState {
  return { ...emptyBuilderState(), name: 'BNB momentum desk', orderCapUsdt: '10', nodes, ...overrides }
}

describe('the cost preview', () => {
  it('prices the good chain at 0.095 tUSD', () => {
    expect(chainTotal(GOOD_CHAIN, BY_ID)).toBe(toBaseUnits('0.095').toString())
  })

  it('prices the chain at 0.075 tUSD after the swap to Sloppy Research', () => {
    const swapped = withProvider(GOOD_CHAIN, 1, SLOPPY.id)
    expect(chainTotal(swapped, BY_ID)).toBe(toBaseUnits('0.075').toString())
  })

  it('counts a Node with no Provider as nothing rather than refusing to price', () => {
    const partial: BuilderNode[] = [GOOD_CHAIN[0]!, { type: 'research', listing_id: '' }]
    expect(chainTotal(partial, BY_ID)).toBe(toBaseUnits('0.01').toString())
  })

  it('reports the shortfall when the chain does not fit the remaining budget', () => {
    const preview = costPreview(GOOD_CHAIN, BY_ID, toBaseUnits('0.05').toString())
    expect(preview.overBudget).toBe(true)
    expect(preview.shortfall).toBe(toBaseUnits('0.045').toString())
  })

  it('is not over budget when the chain fits exactly', () => {
    const preview = costPreview(GOOD_CHAIN, BY_ID, toBaseUnits('0.095').toString())
    expect(preview).toMatchObject({ overBudget: false, shortfall: null })
  })

  it('shows no verdict at all while GET /api/me has not answered', () => {
    const preview = costPreview(GOOD_CHAIN, BY_ID, null)
    expect(preview).toMatchObject({ remaining: null, shortfall: null, overBudget: false })
  })
})

describe('the Provider swap', () => {
  it('changes exactly one Node and leaves every other Node identical', () => {
    const swapped = withProvider(GOOD_CHAIN, 1, SLOPPY.id)
    expect(swapped[1]).toEqual({ type: 'research', listing_id: SLOPPY.id })
    for (const index of [0, 2, 3, 4]) {
      expect(swapped[index]).toEqual(GOOD_CHAIN[index])
    }
    expect(GOOD_CHAIN[1]).toEqual({ type: 'research', listing_id: ALPHA.id })
  })

  it('re-validates and re-prices the swapped chain in one pass', () => {
    const before = judgeChain(state(GOOD_CHAIN), CATALOGUE, toBaseUnits('100').toString())
    const after = judgeChain(
      state(withProvider(GOOD_CHAIN, 1, SLOPPY.id)),
      CATALOGUE,
      toBaseUnits('100').toString(),
    )
    expect(before.violations).toEqual([])
    expect(after.violations).toEqual([])
    expect(before.preview.total).toBe(toBaseUnits('0.095').toString())
    expect(after.preview.total).toBe(toBaseUnits('0.075').toString())
  })

  it('offers the Providers of one Type only, cheapest first', () => {
    expect(providersForType(CATALOGUE, 'research').map((row) => row.name)).toEqual([
      'Sloppy Research',
      'Alpha Research',
    ])
    expect(providersForType(CATALOGUE, 'data').map((row) => row.id)).toEqual([TICKER.id])
  })
})

describe('the chain edits', () => {
  it('adds a Node with no Provider yet, so the Builder picks one next', () => {
    expect(withNode([], 'data')).toEqual([{ type: 'data', listing_id: '' }])
  })

  it('removes one Node and renumbers nothing else', () => {
    expect(withoutNode(GOOD_CHAIN, 4)).toEqual(GOOD_CHAIN.slice(0, 4))
  })

  it('moves a Node one place, and refuses to move past either end', () => {
    const moved = withMovedNode(GOOD_CHAIN, 1, -1)
    expect(moved.map((node) => node.type)).toEqual([
      'research',
      'data',
      'risk',
      'execution',
      'notify',
    ])
    expect(withMovedNode(GOOD_CHAIN, 0, -1)).toEqual(GOOD_CHAIN)
    expect(withMovedNode(GOOD_CHAIN, 4, 1)).toEqual(GOOD_CHAIN)
  })
})

describe('judgeChain', () => {
  const budget = toBaseUnits('100').toString()

  it('lets a valid, named, affordable chain be saved and run', () => {
    const verdict = judgeChain(state(GOOD_CHAIN), CATALOGUE, budget)
    expect(verdict.saveBlockers).toEqual([])
    expect(verdict.runBlockers).toEqual([])
  })

  it('blocks saving an unnamed Workflow', () => {
    const verdict = judgeChain(state(GOOD_CHAIN, { name: '  ' }), CATALOGUE, budget)
    expect(verdict.saveBlockers).toContain('Name the Workflow.')
  })

  it('blocks running, but not saving, only because of the budget', () => {
    const verdict = judgeChain(state(GOOD_CHAIN), CATALOGUE, toBaseUnits('0.05').toString())
    expect(verdict.saveBlockers).toEqual([])
    expect(verdict.runBlockers).toEqual([
      'The chain costs more than the remaining Daily Fee Budget.',
    ])
  })

  it('reports the Order Cap as a violation of the execution Node', () => {
    const verdict = judgeChain(state(GOOD_CHAIN, { orderCapUsdt: '' }), CATALOGUE, budget)
    expect(verdict.violations).toEqual([
      {
        node_index: 3,
        rule: CHAIN_RULES.orderCapRequired,
        message: 'an execution Node needs an Order Cap above 0 USDT',
      },
    ])
    expect(verdict.saveBlockers).toContain('One Node is not valid yet.')
  })

  it('asks for a Node before it complains about the empty chain', () => {
    const verdict = judgeChain(state([]), CATALOGUE, budget)
    expect(verdict.violations.map((violation) => violation.rule)).toEqual([CHAIN_RULES.emptyChain])
    expect(verdict.saveBlockers).toEqual(['Add at least one Node.'])
  })

  it('counts offending Nodes, not violations', () => {
    const chain: BuilderNode[] = [
      { type: 'data', listing_id: TICKER.id },
      { type: 'execution', listing_id: EXECUTOR.id },
    ]
    // One Node, two broken rules: no risk Node before it, and no Order Cap.
    const verdict = judgeChain(state(chain, { orderCapUsdt: '' }), CATALOGUE, budget)
    expect(verdict.violations.map((violation) => violation.node_index)).toEqual([1, 1])
    expect(verdict.saveBlockers).toEqual(['One Node is not valid yet.'])
  })

  it('reports a paused Provider at its Node', () => {
    const paused = CATALOGUE.map((row) =>
      row.id === GUARDRAIL.id ? { ...row, paused_by_stake: true } : row,
    )
    const verdict = judgeChain(state(GOOD_CHAIN), paused, budget)
    expect(verdict.violations.map((violation) => violation.node_index)).toEqual([2])
    expect(verdict.violations[0]!.message).toContain('FR-8')
  })
})

describe('toSaveRequest', () => {
  it('sends the trimmed name, the fixed symbol and a decimal Order Cap', () => {
    const body = toSaveRequest(state(GOOD_CHAIN, { name: '  BNB momentum desk  ' }))
    expect(body).toEqual({
      name: 'BNB momentum desk',
      symbol: FIXED_SYMBOL,
      order_cap_usdt: '10',
      nodes: [
        { type: 'data', listing_id: TICKER.id },
        { type: 'research', listing_id: ALPHA.id },
        { type: 'risk', listing_id: GUARDRAIL.id },
        { type: 'execution', listing_id: EXECUTOR.id },
        { type: 'notify', listing_id: NOTIFIER.id },
      ],
    })
  })

  it('sends null rather than an empty string when no Order Cap was typed', () => {
    expect(toSaveRequest(state(GOOD_CHAIN, { orderCapUsdt: '  ' })).order_cap_usdt).toBeNull()
  })
})
