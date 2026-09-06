import type { AgentCard, AgentType } from '@agent-desk/schemas'

/**
 * The agent card of AD-2 / FR-12: what `GET /api/listings/<id>/agent.json`
 * returns, and the same JSON the `data:` `agentURI` carries when there is no
 * `PUBLIC_BASE_URL` to point at that route.
 *
 * It lives in `packages/core` because both halves need it and neither may
 * import the other (AD-1): the worker builds it to decide the `agentURI` before
 * `IdentityRegistry.register`, and the web route serves it afterwards. One
 * builder is what makes "the same JSON" true rather than aspirational.
 */

/** The listing columns a card is built from. All of them are form-owned. */
export interface AgentCardSource {
  id: string
  name: string
  description: string | null
  type: AgentType
  endpoint: string
  /** Null until the `identity:` receipt; a `data:` card is minted without it. */
  agentId: string | null
  /** Null until the `list:` receipt, for the same reason. */
  registryListingId: string | null
  payoutWallet: string
}

/** The route the card is served from, relative to the public base URL. */
export function agentCardPath(listingId: string): string {
  return `/api/listings/${listingId}/agent.json`
}

/**
 * `baseUrl` is `PUBLIC_BASE_URL` (or the request origin, for the web route).
 * When there is none the schema page is named by its path alone, which is the
 * honest answer: a card with no host to live on cannot link to one either.
 */
export function buildAgentCard(listing: AgentCardSource, baseUrl: string | null): AgentCard {
  const base = normaliseBaseUrl(baseUrl)
  return {
    name: listing.name,
    description: listing.description,
    type: listing.type,
    endpoint: listing.endpoint,
    agent_id: listing.agentId,
    registry_listing_id: listing.registryListingId,
    payout_wallet: listing.payoutWallet.toLowerCase(),
    schema_url: `${base}/schema`,
  }
}

/** Trailing slashes off, so `${base}/schema` never doubles up. */
export function normaliseBaseUrl(baseUrl: string | null | undefined): string {
  const trimmed = baseUrl?.trim() ?? ''
  return trimmed.replace(/\/+$/, '')
}
