import { describe, expect, it } from 'vitest'
import { agentCard } from '@agent-desk/schemas'
import { buildAgentCard, normaliseBaseUrl } from './card.ts'
import { DATA_URI_PREFIX, decideAgentUri, decodeDataUri, isDataAgentUri } from './agent-uri.ts'
import type { AgentCardSource } from './card.ts'

/**
 * AD-2: `agentURI` is `PUBLIC_BASE_URL/api/listings/<id>/agent.json`, or a
 * `data:` URI carrying the same JSON. "The same JSON" is the clause under test:
 * the card the worker seals into the URI and the card the web route serves come
 * out of one builder, so they cannot drift.
 */

const LISTING: AgentCardSource = {
  id: 'lst_01JBINANCE',
  name: 'Binance Ticker',
  description: 'BNBUSDT last price and 24h change.',
  type: 'data',
  endpoint: 'https://ticker.example/',
  agentId: null,
  registryListingId: null,
  payoutWallet: '0x00000000000000000000000000000000000000B2',
}

describe('the agent card', () => {
  it('matches the shared schema and lower-cases the payout wallet', () => {
    const card = buildAgentCard(LISTING, 'https://agentdesk.example')

    expect(agentCard.parse(card)).toEqual({
      name: 'Binance Ticker',
      description: 'BNBUSDT last price and 24h change.',
      type: 'data',
      endpoint: 'https://ticker.example/',
      agent_id: null,
      registry_listing_id: null,
      payout_wallet: '0x00000000000000000000000000000000000000b2',
      schema_url: 'https://agentdesk.example/schema',
    })
  })

  it('carries the ids once the receipts have landed', () => {
    const card = buildAgentCard(
      { ...LISTING, agentId: '7', registryListingId: '1' },
      'https://agentdesk.example/',
    )
    expect(card).toMatchObject({ agent_id: '7', registry_listing_id: '1' })
  })

  it('drops a trailing slash so the schema URL never doubles up', () => {
    expect(normaliseBaseUrl('https://agentdesk.example///')).toBe('https://agentdesk.example')
    expect(normaliseBaseUrl(null)).toBe('')
    expect(buildAgentCard(LISTING, null).schema_url).toBe('/schema')
  })
})

describe('the agentURI decision', () => {
  it('points at the hosted card when PUBLIC_BASE_URL is set', () => {
    expect(decideAgentUri(LISTING, 'https://agentdesk.example')).toBe(
      'https://agentdesk.example/api/listings/lst_01JBINANCE/agent.json',
    )
    expect(isDataAgentUri(decideAgentUri(LISTING, 'https://agentdesk.example'))).toBe(false)
  })

  it('treats an empty or blank PUBLIC_BASE_URL as absent', () => {
    for (const base of [null, '', '   ']) {
      expect(decideAgentUri(LISTING, base)).toMatch(DATA_URI_PREFIX)
    }
  })

  it('carries the same card inside the data: URI', () => {
    const uri = decideAgentUri(LISTING, null)
    expect(decodeDataUri(uri)).toEqual(buildAgentCard(LISTING, null))
  })

  it('round-trips a name that is not ASCII', () => {
    // `btoa` is one byte per code unit, so the JSON has to become UTF-8 bytes
    // first. Getting this wrong throws — on the way to a chain write.
    const listing = { ...LISTING, name: 'Máy đọc giá Binance', description: '価格を読む' }
    const decoded = decodeDataUri(decideAgentUri(listing, null)) as { name: string; description: string }
    expect(decoded.name).toBe('Máy đọc giá Binance')
    expect(decoded.description).toBe('価格を読む')
  })

  it('reads back as nothing when the URI is a URL', () => {
    expect(decodeDataUri('https://agentdesk.example/api/listings/x/agent.json')).toBeNull()
  })
})
