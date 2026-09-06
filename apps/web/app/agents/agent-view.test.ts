import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { agentHistoryResponse, listingResponse, type ListingResponse } from '@agent-desk/schemas'
import type { AgentHistoryResponse } from '@agent-desk/schemas'
import { ExplorerProvider } from '../../lib/explorer-context.tsx'
import { checksumAddress } from '../../lib/format.ts'
import { AgentView } from './[id]/agent-view.tsx'
import { agentHistoryQueryKey, agentHref, agentListingQueryKey } from './agent-query.ts'
import {
  IDENTITY_REGISTRY_ADDRESS,
  OWNER_ADDRESS,
  REGISTRY_ADDRESS,
  TX_PRICE,
  TX_REPUTATION,
  TX_SLASH,
  TX_STAKE,
  TX_VERIFICATION,
  sloppyResearch,
  sloppyResearchHistory,
  spotExecutor,
  spotExecutorHistory,
} from './fixtures.ts'

/**
 * Story 5.4 fixes what `/agents/<listing_id>` must carry: the identity, the
 * price history as a table, the Reputation history as a line, the Stake with its
 * `stake:` and `slash:` rows, and the verification Call with its request and
 * response JSON. Rendering the component against a seeded cache checks all of
 * them at once, without a browser.
 */

const EXPLORER = 'https://testnet.bscscan.com'

function render(listing: ListingResponse, history: AgentHistoryResponse): string {
  const client = new QueryClient()
  client.setQueryData(agentListingQueryKey(listing.id), listing)
  client.setQueryData(agentHistoryQueryKey(listing.id), history)

  return renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client,
      children: createElement(ExplorerProvider, {
        value: EXPLORER,
        children: createElement(AgentView, {
          listingId: listing.id,
          registryAddress: REGISTRY_ADDRESS,
          identityRegistryAddress: IDENTITY_REGISTRY_ADDRESS,
        }),
      }),
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

describe('the fixtures', () => {
  it('are the shapes the two routes are required to answer (AD-14)', () => {
    expect(listingResponse.safeParse(sloppyResearch).success).toBe(true)
    expect(listingResponse.safeParse(spotExecutor).success).toBe(true)
    expect(agentHistoryResponse.safeParse(sloppyResearchHistory).success).toBe(true)
    expect(agentHistoryResponse.safeParse(spotExecutorHistory).success).toBe(true)
  })
})

describe('an Agent record', () => {
  const markup = render(sloppyResearch, sloppyResearchHistory)
  const body = text(markup)

  it('names the Agent, its Type, its description and its endpoint', () => {
    expect(body).toContain('Sloppy Research')
    expect(body).toContain('research')
    expect(body).toContain('without reading the market snapshot')
    expect(body).toContain('host.docker.internal:4104')
  })

  it('shows the status with its pause reason', () => {
    expect(markup).toContain('data-status="paused (creator)"')
    expect(body).toContain('Paused by its creator')
  })

  it('renders price and Stake as decimal tUSD, never base units (AD-13)', () => {
    // 50000 base units is 0.05 tUSD; 370000 is 0.37.
    expect(body).toContain('0.05')
    expect(body).toContain('0.37')
    expect(body).toContain('tUSD')
    expect(body).not.toContain('370000')
  })

  it('shows the Reputation percentage with its scored-Call count', () => {
    expect(body).toContain('67%')
    expect(body).toContain('over 3 scored Calls')
  })

  it('links the owner address to the explorer, checksummed', () => {
    const checksummed = checksumAddress(OWNER_ADDRESS)
    expect(markup).toContain(`href="${EXPLORER}/address/${checksummed}"`)
    expect(markup).not.toContain(OWNER_ADDRESS)
  })
})

describe('the on-chain identity', () => {
  const markup = render(sloppyResearch, sloppyResearchHistory)
  const body = text(markup)

  it('links the ERC-8004 agent id to the IdentityRegistry on the explorer', () => {
    const checksummed = checksumAddress(IDENTITY_REGISTRY_ADDRESS)
    expect(markup).toContain('data-registry="IdentityRegistry"')
    expect(markup).toContain(`href="${EXPLORER}/token/${checksummed}"`)
    expect(body).toContain('#11')
  })

  it('links the Registry listing id to AgentDeskRegistry', () => {
    const checksummed = checksumAddress(REGISTRY_ADDRESS)
    expect(markup).toContain('data-registry="AgentDeskRegistry"')
    expect(markup).toContain(`href="${EXPLORER}/address/${checksummed}"`)
    expect(body).toContain('#10')
  })

  it('says so rather than showing a blank when nothing has been minted', () => {
    const unminted = { ...sloppyResearch, agent_id: null, registry_listing_id: null }
    expect(text(render(unminted, sloppyResearchHistory))).toContain('not minted yet')
  })
})

describe('the price history', () => {
  const markup = render(sloppyResearch, sloppyResearchHistory)
  const body = text(markup)

  it('is a table of timestamp, old price, new price and transaction', () => {
    expect(body).toContain('Price history')
    expect(body).toContain('Old price')
    expect(body).toContain('New price')
    // The `list:` row: 0.03, with no old price to show.
    expect(body).toContain('2026-09-05 09:00:04 UTC')
    expect(body).toContain('listed')
    expect(body).toContain('0.03')
    // The `price:` row: 0.03 -> 0.05, with its transaction.
    expect(body).toContain('2026-09-05 10:00:05 UTC')
    expect(markup).toContain(`href="${EXPLORER}/tx/${TX_PRICE}"`)
  })

  it('renders one row per chain_tx intent, keyed by it', () => {
    expect(markup).toContain(`data-intent-key="list:${sloppyResearch.id}"`)
    expect(markup).toContain(`data-intent-key="price:${sloppyResearch.id}:1757150000000"`)
  })
})

describe('the Reputation history', () => {
  const markup = render(sloppyResearch, sloppyResearchHistory)
  const body = text(markup)

  it('is a line with one point per reputation: row', () => {
    expect(body).toContain('Reputation history')
    expect(markup).toContain('data-points="1"')
    expect(markup).toContain('<polyline')
    // One row, so one dot, centred on the 640-wide box at 67 %.
    expect(markup).toContain('points="320,57.33"')
  })

  it('carries the transaction that wrote it', () => {
    expect(markup).toContain(`href="${EXPLORER}/tx/${TX_REPUTATION}"`)
  })

  it('says so plainly when nothing has been written on chain yet', () => {
    const unscored = {
      ...sloppyResearchHistory,
      rows: sloppyResearchHistory.rows.filter((row) => row.intent !== 'reputation'),
    }
    const withoutScore = { ...sloppyResearch, reputation_bps: null, scored_call_count: 0 }
    const empty = text(render(withoutScore, unscored))
    expect(empty).toContain('no score yet')
    expect(empty).toContain('No Reputation has been written on chain')
  })
})

describe('the Stake', () => {
  const markup = render(sloppyResearch, sloppyResearchHistory)
  const body = text(markup)

  it('shows the Stake with its stake: and slash: rows', () => {
    expect(body).toContain('Stake')
    expect(markup).toContain('data-kind="stake"')
    expect(markup).toContain('data-kind="slash"')
    expect(body).toContain('topped up')
    expect(body).toContain('slashed')
  })

  it('states the amount each row moved, in decimal tUSD', () => {
    // 100000 base units added, 30000 slashed.
    expect(body).toContain('+0.1')
    expect(body).toContain('0.03')
  })

  it('links both transactions to the explorer', () => {
    expect(markup).toContain(`href="${EXPLORER}/tx/${TX_STAKE}"`)
    expect(markup).toContain(`href="${EXPLORER}/tx/${TX_SLASH}"`)
  })
})

describe('the verification Call', () => {
  const markup = render(sloppyResearch, sloppyResearchHistory)
  const body = text(markup)

  it('shows its status, timestamps and payment transaction', () => {
    expect(body).toContain('Verification Call')
    expect(markup).toContain('data-status="succeeded"')
    expect(body).toContain('2026-09-05 08:59:58 UTC')
    expect(markup).toContain(`href="${EXPLORER}/tx/${TX_VERIFICATION}"`)
  })

  it('shows the request and response JSON it exchanged', () => {
    expect(body).toContain('Request')
    expect(body).toContain('BNBUSDT')
    expect(body).toContain('Response')
    expect(body).toContain('24h trend is up')
  })

  it('says a verification Call is never scored (AD-9)', () => {
    expect(body).toContain('a verification Call is not settled')
  })
})

describe('an execution Agent', () => {
  const markup = render(spotExecutor, spotExecutorHistory)
  const body = text(markup)

  it('says it was listed by the platform without a verification Call (FR-11)', () => {
    expect(body).toContain('listed by the platform without a verification Call')
  })

  it('shows no request or response panel, because there is none', () => {
    expect(body).not.toContain('24h trend is up')
    expect(markup).not.toContain('data-call-id=')
  })

  it('still shows its identity, its price history and its Stake', () => {
    expect(body).toContain('#14')
    expect(body).toContain('0.02')
    expect(body).toContain('0.2')
  })
})

describe('the link from a marketplace card', () => {
  it('is /agents/<listing_id>', () => {
    expect(agentHref(sloppyResearch.id)).toBe(`/agents/${sloppyResearch.id}`)
  })
})
