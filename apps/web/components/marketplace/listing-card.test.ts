import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ListingResponse } from '@agent-desk/schemas'
import { ExplorerProvider } from '../../lib/explorer-context.tsx'
import { checksumAddress } from '../../lib/format.ts'
import { ListingCard } from './listing-card.tsx'
import { ListingGrid } from './listing-grid.tsx'
import {
  alphaResearch,
  binanceTicker,
  freshResearch,
  marketplaceFixture,
  pausedExecutor,
  pausedNotifier,
} from './fixtures.ts'

/**
 * Story 3.5 fixes what a card must carry: name, Type, price per call, Stake,
 * Reputation with its scored-Call count, owner address checksummed with an
 * explorer link, status, and `agent_id`. Rendering the component checks all of
 * them at once, without a browser.
 */

const EXPLORER = 'https://testnet.bscscan.com'

function render(listing: ListingResponse): string {
  return renderToStaticMarkup(
    createElement(ExplorerProvider, {
      value: EXPLORER,
      children: createElement(ListingCard, { listing }),
    }),
  )
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&middot;|&#183;/g, '·')
    .replace(/\s+/g, ' ')
}

describe('a marketplace card', () => {
  const markup = render(alphaResearch)
  const body = text(markup)

  it('names the Agent, its Type and its description', () => {
    expect(body).toContain('Alpha Research')
    expect(body).toContain('research')
    expect(body).toContain('Trend and volatility read')
  })

  it('renders price and Stake as decimal tUSD, never base units', () => {
    // 30000 base units is 0.03 tUSD; 300000 is 0.3.
    expect(body).toContain('0.03')
    expect(body).toContain('per call')
    expect(body).toContain('0.3')
    expect(body).toContain('tUSD')
    expect(body).not.toContain('30000')
  })

  it('shows the Reputation percentage with its scored-Call count', () => {
    expect(body).toContain('100%')
    expect(body).toContain('over 3 scored Calls')
  })

  it('shows the status', () => {
    expect(markup).toContain('data-status="active"')
    expect(body).toContain('active')
  })

  it('shows the ERC-8004 agent id', () => {
    expect(body).toContain('#11')
  })

  /** Story 5.4: the card is the summary, `/agents/<id>` is the evidence. */
  it('links its name to the Agent detail page', () => {
    expect(markup).toContain(`href="/agents/${alphaResearch.id}"`)
  })

  it('links the owner address to the explorer, checksummed', () => {
    const checksummed = checksumAddress(alphaResearch.owner_address as string)
    expect(checksummed).not.toBe(alphaResearch.owner_address)
    expect(markup).toContain(`href="${EXPLORER}/address/${checksummed}"`)
    expect(markup).toContain(`title="${checksummed}"`)
    // AD-13: the lower-case form the API returns is never printed.
    expect(markup).not.toContain(alphaResearch.owner_address as string)
  })
})

describe('a card with no score yet', () => {
  it('says so rather than showing a zero', () => {
    const body = text(render(freshResearch))
    expect(body).toContain('no score yet')
    expect(body).not.toContain('0%')
  })
})

describe('a card of a Type that is not scored', () => {
  it('says "not scored in MVP" for a data listing', () => {
    const body = text(render(binanceTicker))
    expect(body).toContain('not scored in MVP')
    expect(body).not.toContain('0%')
  })
})

describe('a paused card', () => {
  it('shows "paused (creator)" with the reason and is not selectable', () => {
    const markup = render(pausedNotifier)
    const body = text(markup)
    expect(body).toContain('paused (creator)')
    expect(body).toContain('Paused by its creator')
    expect(markup).toContain('data-selectable="false"')
  })

  it('shows "paused (stake)" with the reason and is not selectable', () => {
    const markup = render(pausedExecutor)
    const body = text(markup)
    expect(body).toContain('paused (stake)')
    expect(body).toContain('Stake fell below ten times its price')
    expect(markup).toContain('data-selectable="false"')
  })

  it('is still visible on the marketplace (FR-12), only unselectable (FR-8)', () => {
    expect(text(render(pausedExecutor))).toContain('Spot Executor')
  })
})

describe('the grid', () => {
  it('renders one card per Listing, in the order it is given', () => {
    const markup = renderToStaticMarkup(
      createElement(ExplorerProvider, {
        value: EXPLORER,
        children: createElement(ListingGrid, { listings: marketplaceFixture }),
      }),
    )
    for (const listing of marketplaceFixture) {
      expect(markup).toContain(`data-listing-id="${listing.id}"`)
    }
    const positions = marketplaceFixture.map((listing) =>
      markup.indexOf(`data-listing-id="${listing.id}"`),
    )
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('links every card to its Agent detail page (Story 5.4)', () => {
    const markup = renderToStaticMarkup(
      createElement(ExplorerProvider, {
        value: EXPLORER,
        children: createElement(ListingGrid, { listings: marketplaceFixture }),
      }),
    )
    for (const listing of marketplaceFixture) {
      expect(markup).toContain(`href="/agents/${listing.id}"`)
    }
  })
})
