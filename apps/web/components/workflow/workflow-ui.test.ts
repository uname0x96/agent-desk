import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { toBaseUnits, type ListingResponse } from '@agent-desk/schemas'
import { CostPreview } from './cost-preview.tsx'
import { NodeCard } from './node-card.tsx'
import { ProviderPicker } from './provider-picker.tsx'

/**
 * FR-19 and FR-21 on screen: a violation is readable at the Node it belongs to,
 * both preview numbers and the shortfall are rendered, and a paused Provider is
 * shown, marked and not selectable (FR-8). Rendering to static markup checks all
 * of that without a browser, the same way `app/runs/[id]/run-view.test.ts` does.
 */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&middot;|&#183;/g, '·')
    .replace(/\s+/g, ' ')
}

describe('the Node card', () => {
  it('shows the Node number, its Type, its Provider and its price', () => {
    const markup = renderToStaticMarkup(
      createElement(NodeCard, {
        index: 1,
        type: 'research',
        provider: 'Alpha Research',
        price: toBaseUnits('0.05').toString(),
        violations: [],
      }),
    )
    expect(text(markup)).toContain('2 · research')
    expect(text(markup)).toContain('Alpha Research')
    expect(text(markup)).toContain('0.05 tUSD')
    expect(markup).toContain('data-invalid="false"')
  })

  it('shows every violation inline and marks the card invalid', () => {
    const markup = renderToStaticMarkup(
      createElement(NodeCard, {
        index: 0,
        type: 'research',
        provider: null,
        price: null,
        violations: [
          'a research Node needs a data Node earlier in the chain',
          'pick a Provider for this Node',
        ],
      }),
    )
    expect(markup).toContain('data-invalid="true"')
    expect(text(markup)).toContain('a research Node needs a data Node earlier in the chain')
    expect(text(markup)).toContain('pick a Provider for this Node')
    expect(text(markup)).toContain('no Provider')
  })
})

describe('the cost preview', () => {
  const rows = [
    { index: 0, type: 'data' as const, provider: 'Binance Ticker', price: toBaseUnits('0.01').toString() },
    { index: 1, type: 'research' as const, provider: 'Alpha Research', price: toBaseUnits('0.05').toString() },
  ]

  it('shows the max cost beside the remaining Daily Fee Budget', () => {
    const markup = renderToStaticMarkup(
      createElement(CostPreview, {
        preview: {
          total: toBaseUnits('0.095').toString(),
          remaining: toBaseUnits('100').toString(),
          shortfall: null,
          overBudget: false,
        },
        rows,
      }),
    )
    const body = text(markup)
    expect(body).toContain('Max cost of one Run')
    expect(body).toContain('0.095')
    expect(body).toContain('Remaining Daily Fee Budget')
    expect(body).toContain('100')
    expect(markup).toContain('data-over-budget="false"')
  })

  it('names the shortfall when the chain does not fit the budget', () => {
    const markup = renderToStaticMarkup(
      createElement(CostPreview, {
        preview: {
          total: toBaseUnits('0.095').toString(),
          remaining: toBaseUnits('0.05').toString(),
          shortfall: toBaseUnits('0.045').toString(),
          overBudget: true,
        },
        rows,
      }),
    )
    expect(markup).toContain('data-over-budget="true"')
    expect(text(markup)).toContain('Short by 0.045 tUSD')
  })

  it('lists one line per Node with its Provider and price', () => {
    const markup = renderToStaticMarkup(
      createElement(CostPreview, {
        preview: { total: toBaseUnits('0.06').toString(), remaining: null, shortfall: null, overBudget: false },
        rows,
      }),
    )
    const body = text(markup)
    expect(body).toContain('Binance Ticker')
    expect(body).toContain('Alpha Research')
  })
})

describe('the Provider picker', () => {
  function listing(overrides: Partial<ListingResponse>): ListingResponse {
    return {
      id: 'lst_alpha',
      name: 'Alpha Research',
      description: null,
      type: 'research',
      endpoint: 'http://localhost:4102',
      status: 'active',
      last_error: null,
      price: toBaseUnits('0.05').toString(),
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

  it('shows every Provider of the Type with its price, and marks the chosen one', () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderPicker, {
        type: 'research',
        providers: [
          listing({}),
          listing({ id: 'lst_sloppy', name: 'Sloppy Research', price: toBaseUnits('0.03').toString() }),
        ],
        selectedId: 'lst_sloppy',
        onPick: () => {},
      }),
    )
    const body = text(markup)
    expect(body).toContain('Alpha Research')
    expect(body).toContain('0.05')
    expect(body).toContain('Sloppy Research')
    expect(body).toContain('0.03')
    expect(markup).toContain('data-listing-id="lst_sloppy" class')
    expect(markup).toMatch(/aria-pressed="true"[^>]*data-listing-id="lst_sloppy"/)
  })

  it('shows a paused Provider, names FR-8, and does not let it be picked', () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderPicker, {
        type: 'research',
        providers: [listing({ paused_by_stake: true })],
        selectedId: '',
        onPick: () => {},
      }),
    )
    expect(text(markup)).toContain('paused at zero Stake · not selectable (FR-8)')
    expect(markup).toContain('disabled=""')
  })

  it('says so when no Agent of the Type is listed yet', () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderPicker, {
        type: 'execution',
        providers: [],
        selectedId: '',
        onPick: () => {},
      }),
    )
    expect(text(markup)).toContain('No execution Agent is listed on the marketplace yet.')
  })
})
