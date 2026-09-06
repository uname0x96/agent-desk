import type { AgentType, ListingResponse, ListingStatus } from '@agent-desk/schemas'
import type { AgentCardSource } from '@agent-desk/core/listing'

/**
 * The read model behind `GET /api/listings` and
 * `GET /api/listings/<id>/agent.json`.
 *
 * ┌─ AD-2 ─────────────────────────────────────────────────────────────────┐
 * │ Every number on a marketplace card — price, Stake, reputation, pause   │
 * │ flags, payout wallet, endpoint, `agentId`, Registry id — is read from  │
 * │ the chain-owned columns of `listings`. Those columns have exactly one  │
 * │ writer, `refreshListingFromChain`, which fills them from `getListing`  │
 * │ after every confirmed receipt whose intent names the Listing. So a     │
 * │ card matches the Registry by construction, and this route never reads  │
 * │ the chain: doing so per request would add an RPC round trip to answer  │
 * │ the question the cache was built to answer, and would still be stale   │
 * │ by the time it rendered.                                              │
 * │                                                                        │
 * │ `POST /api/listings/<id>/refresh` (Story 3.6) is the manual re-read    │
 * │ for the case where a receipt was missed.                              │
 * └────────────────────────────────────────────────────────────────────────┘
 */

/** AD-2: the marketplace, the Workflow Builder, and the Price Lock read these two. */
export const MARKETPLACE_STATUSES: readonly ListingStatus[] = ['active', 'paused']

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 100

/** One row of the query both routes run. */
export interface ListingRow {
  id: string
  name: string
  description: string | null
  type: AgentType
  endpoint: string
  status: ListingStatus
  lastError: string | null
  // -- chain-owned ---------------------------------------------------------
  price: string | null
  stake: string | null
  reputationBps: number | null
  pausedByCreator: boolean
  pausedByStake: boolean
  payoutWallet: string | null
  agentId: string | null
  registryListingId: string | null
  // -- joined --------------------------------------------------------------
  creatorAccountId: string
  /** The Creator's System Wallet, the address that owns the Registry entry. */
  ownerAddress: string | null
  /** AD-9: settlements of this Listing with a `passed` or `failed` result. */
  scoredCallCount: number
  createdAt: Date
}

export function toListingResponse(row: ListingRow): ListingResponse {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    endpoint: row.endpoint,
    status: row.status,
    last_error: row.lastError,
    // A Listing reaches `active` or `paused` only after a confirmed `list:`
    // receipt, which is also what fills these two, so they are never null on a
    // card. `0` rather than the declared amount is deliberate: a wrong number
    // that is obviously wrong beats one that looks like a price.
    price: row.price ?? '0',
    stake: row.stake ?? '0',
    reputation_bps: row.reputationBps,
    scored_call_count: row.scoredCallCount,
    paused_by_creator: row.pausedByCreator,
    paused_by_stake: row.pausedByStake,
    payout_wallet: lowerCase(row.payoutWallet),
    owner_address: lowerCase(row.ownerAddress),
    creator_account_id: row.creatorAccountId,
    agent_id: row.agentId,
    registry_listing_id: row.registryListingId,
    created_at: row.createdAt.toISOString(),
  }
}

/**
 * Keyset pagination over the id. Listing ids are ULIDs (AD-13), whose first ten
 * characters are the creation time in base 32, so ordering by id descending is
 * ordering by newest first and a cursor needs no second column.
 *
 * The caller fetches `limit + 1` rows; the extra one is what says whether a next
 * page exists, and it is not returned.
 */
export function toListingsPage(
  rows: readonly ListingRow[],
  limit: number,
): { items: ListingResponse[]; next: string | null } {
  const page = rows.slice(0, limit)
  const hasMore = rows.length > limit
  const last = page.at(-1)
  return {
    items: page.map(toListingResponse),
    next: hasMore && last ? last.id : null,
  }
}

export function parsePageSize(value: string | null): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE
  return Math.min(parsed, MAX_PAGE_SIZE)
}

/** The card source of `packages/core/listing`, from the same row. */
export function toAgentCardSource(row: ListingRow): AgentCardSource {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    endpoint: row.endpoint,
    agentId: row.agentId,
    registryListingId: row.registryListingId,
    // Chain-owned from the first receipt on; before it, the address the form
    // supplied, which is the one `list(...)` was built with.
    payoutWallet: row.payoutWallet ?? '',
  }
}

/**
 * `PUBLIC_BASE_URL` when the Operator set one, else the host the request
 * arrived on. AD-2 makes the first the identity of the deployment; the second
 * keeps the card self-describing when it is fetched directly.
 */
export function publicBaseUrl(requestUrl: string): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim()
  if (configured && configured.length > 0) return configured.replace(/\/+$/, '')
  return new URL(requestUrl).origin
}

/** AD-13: addresses leave this system lower-case; the UI checksums them. */
function lowerCase(address: string | null): string | null {
  return address === null ? null : address.toLowerCase()
}
