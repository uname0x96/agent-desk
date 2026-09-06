import { afterEach, describe, expect, it } from 'vitest'
import { listingResponse, listingsResponse } from '@agent-desk/schemas'
import { buildAgentCard } from '@agent-desk/core/listing'
import {
  DEFAULT_PAGE_SIZE,
  MARKETPLACE_STATUSES,
  MAX_PAGE_SIZE,
  parsePageSize,
  publicBaseUrl,
  toAgentCardSource,
  toListingResponse,
  toListingsPage,
  type ListingRow,
} from './listings-view.ts'

/**
 * AD-2 / AD-13: the marketplace read model. Every number on a card comes from
 * the chain-owned columns, amounts leave as base-unit strings, and addresses
 * leave lower-case. The bodies are parsed against the shared schemas here for
 * the same reason the routes parse them: a shape the client would reject must
 * fail in a test, not in a browser.
 */

const ROW: ListingRow = {
  id: 'lst_01JBINANCE',
  name: 'Binance Ticker',
  description: 'BNBUSDT last price and 24h change.',
  type: 'data',
  endpoint: 'http://agent-binance-ticker:4101/',
  status: 'active',
  lastError: null,
  price: '10000',
  stake: '100000',
  reputationBps: null,
  pausedByCreator: false,
  pausedByStake: false,
  payoutWallet: '0x00000000000000000000000000000000000000B2',
  agentId: '7',
  registryListingId: '1',
  creatorAccountId: 'acc_PLATFORM',
  ownerAddress: '0x00000000000000000000000000000000000000C1',
  scoredCallCount: 0,
  createdAt: new Date('2026-09-06T12:00:00.000Z'),
}

const row = (overrides: Partial<ListingRow> = {}): ListingRow => ({ ...ROW, ...overrides })

afterEach(() => {
  delete process.env.PUBLIC_BASE_URL
})

describe('a marketplace card', () => {
  it('matches the shared schema, with base units and lower-case addresses', () => {
    const card = toListingResponse(ROW)

    expect(listingResponse.parse(card)).toEqual({
      id: 'lst_01JBINANCE',
      name: 'Binance Ticker',
      description: 'BNBUSDT last price and 24h change.',
      type: 'data',
      endpoint: 'http://agent-binance-ticker:4101/',
      status: 'active',
      last_error: null,
      price: '10000',
      stake: '100000',
      reputation_bps: null,
      scored_call_count: 0,
      paused_by_creator: false,
      paused_by_stake: false,
      payout_wallet: '0x00000000000000000000000000000000000000b2',
      owner_address: '0x00000000000000000000000000000000000000c1',
      creator_account_id: 'acc_PLATFORM',
      agent_id: '7',
      registry_listing_id: '1',
      created_at: '2026-09-06T12:00:00.000Z',
    })
  })

  it('carries the chain-owned price and Stake, never the declared ones', () => {
    // `refreshListingFromChain` wrote 20000 after a `price:` transaction; the
    // form's declared price is not in this row at all, which is the point.
    const card = toListingResponse(row({ price: '20000', stake: '200000' }))
    expect(card).toMatchObject({ price: '20000', stake: '200000' })
  })

  it('shows a paused listing with its reason', () => {
    const card = toListingResponse(row({ status: 'paused', pausedByStake: true }))
    expect(listingResponse.parse(card)).toMatchObject({
      status: 'paused',
      paused_by_stake: true,
      paused_by_creator: false,
    })
  })

  it('reports a reputation and its scored-call count once there is one', () => {
    const card = toListingResponse(row({ reputationBps: 6667, scoredCallCount: 3 }))
    expect(card).toMatchObject({ reputation_bps: 6667, scored_call_count: 3 })
  })

  it('survives an owner with no wallet row', () => {
    expect(listingResponse.parse(toListingResponse(row({ ownerAddress: null })))).toMatchObject({
      owner_address: null,
    })
  })
})

describe('the listings page', () => {
  it('is { items, next } and matches the shared schema', () => {
    const page = toListingsPage([row({ id: 'lst_B' }), row({ id: 'lst_A' })], 10)
    expect(listingsResponse.parse(page)).toEqual({
      items: [toListingResponse(row({ id: 'lst_B' })), toListingResponse(row({ id: 'lst_A' }))],
      next: null,
    })
  })

  it('drops the look-ahead row and names it as the cursor', () => {
    const rows = [row({ id: 'lst_C' }), row({ id: 'lst_B' }), row({ id: 'lst_A' })]
    const page = toListingsPage(rows, 2)

    expect(page.items.map((item) => item.id)).toEqual(['lst_C', 'lst_B'])
    // The next page starts strictly after the last id returned.
    expect(page.next).toBe('lst_B')
  })

  it('is empty and final when there is nothing to show', () => {
    expect(toListingsPage([], 10)).toEqual({ items: [], next: null })
  })

  it('clamps the page size and falls back on nonsense', () => {
    expect(parsePageSize('10')).toBe(10)
    expect(parsePageSize('1000')).toBe(MAX_PAGE_SIZE)
    for (const value of [null, '', '0', '-5', 'many', '2.5']) {
      expect(parsePageSize(value)).toBe(DEFAULT_PAGE_SIZE)
    }
  })

  it('shows exactly the two statuses AD-2 puts on the marketplace', () => {
    expect(MARKETPLACE_STATUSES).toEqual(['active', 'paused'])
  })
})

describe('the agent card the route serves', () => {
  it('is built from the same row as the marketplace card', () => {
    const card = buildAgentCard(toAgentCardSource(ROW), 'https://agentdesk.example')
    expect(card).toMatchObject({
      name: 'Binance Ticker',
      type: 'data',
      endpoint: 'http://agent-binance-ticker:4101/',
      agent_id: '7',
      registry_listing_id: '1',
      payout_wallet: '0x00000000000000000000000000000000000000b2',
      schema_url: 'https://agentdesk.example/schema',
    })
  })

  it('answers before the receipts land, with the ids still null', () => {
    const source = toAgentCardSource(row({ status: 'verifying', agentId: null, registryListingId: null }))
    expect(buildAgentCard(source, 'https://agentdesk.example')).toMatchObject({
      agent_id: null,
      registry_listing_id: null,
    })
  })

  it('prefers PUBLIC_BASE_URL over the host the request arrived on', () => {
    process.env.PUBLIC_BASE_URL = 'https://agentdesk.example/'
    expect(publicBaseUrl('http://localhost:3000/api/listings/x/agent.json')).toBe(
      'https://agentdesk.example',
    )
  })

  it('falls back to the request origin so the card is self-describing', () => {
    expect(publicBaseUrl('http://localhost:3000/api/listings/x/agent.json')).toBe(
      'http://localhost:3000',
    )
  })
})
