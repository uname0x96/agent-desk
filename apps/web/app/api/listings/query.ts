import { db, listings } from '@agent-desk/db'
import { MARKETPLACE_STATUSES, type ListingRow } from './listings-view.ts'

/**
 * The reads behind both listing routes.
 *
 * AD-2: every column taken out of `listings` beyond `name`, `description`,
 * `type`, and `status` is chain-owned, so the answer is the Registry's answer
 * without an RPC call. The Creator's System Wallet supplies `owner_address`, and
 * the scored-Call count is the AD-9 settlement count the marketplace's
 * Reputation label derives from (Story 3.5 owns the label itself).
 *
 * `apps/web` depends on `@agent-desk/db` but not on `drizzle-orm`, so these go
 * through the relational query API, whose operators arrive as callback
 * arguments. That is also why the owner address and the scored count are two
 * small follow-up reads keyed by the page's ids rather than a join and a
 * correlated subquery.
 */

/**
 * AD-2: the marketplace sees `active` and `paused` and nothing else — a
 * `verifying` Listing has no Registry entry to show and a `failed` one never
 * will. One row past `limit` is fetched, so the caller can tell whether a next
 * page exists without a second count.
 */
export async function selectMarketplaceListings(
  limit: number,
  cursor: string | null,
): Promise<ListingRow[]> {
  const rows = await db().query.listings.findMany({
    where: (listing, { and, inArray, lt }) =>
      and(
        inArray(listing.status, [...MARKETPLACE_STATUSES]),
        cursor === null ? undefined : lt(listing.id, cursor),
      ),
    orderBy: (listing, { desc }) => [desc(listing.id)],
    limit: limit + 1,
  })
  return withOwnerAndScore(rows)
}

/**
 * Any status, on purpose: the `agentURI` is minted before the Listing is
 * `active`, so the card it points at has to answer from the moment the
 * `listings` row exists, or an ERC-8004 indexer reading the URI gets a 404.
 */
export async function selectListingById(listingId: string): Promise<ListingRow | null> {
  const row = await db().query.listings.findFirst({
    where: (listing, { eq }) => eq(listing.id, listingId),
  })
  if (!row) return null
  const [enriched] = await withOwnerAndScore([row])
  return enriched ?? null
}

/** The `listings` row as drizzle returns it, before the two reads are folded in. */
type ListingRecord = typeof listings.$inferSelect

async function withOwnerAndScore(rows: readonly ListingRecord[]): Promise<ListingRow[]> {
  if (rows.length === 0) return []

  const accountIds = [...new Set(rows.map((row) => row.creatorAccountId))]
  const listingIds = rows.map((row) => row.id)

  const walletRows = await db().query.wallets.findMany({
    where: (wallet, { inArray }) => inArray(wallet.accountId, accountIds),
    columns: { accountId: true, address: true },
  })
  const ownerByAccount = new Map(walletRows.map((wallet) => [wallet.accountId, wallet.address]))

  // AD-9 scores `research` and `risk` Calls only, so this stays small in the
  // MVP; when it stops being small it belongs in SQL as a grouped count.
  const scoredRows = await db().query.settlements.findMany({
    where: (settlement, { and, inArray }) =>
      and(inArray(settlement.listingId, listingIds), inArray(settlement.result, ['passed', 'failed'])),
    columns: { listingId: true },
  })
  const scoredByListing = new Map<string, number>()
  for (const row of scoredRows) {
    scoredByListing.set(row.listingId, (scoredByListing.get(row.listingId) ?? 0) + 1)
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    endpoint: row.endpoint,
    status: row.status,
    lastError: row.lastError,
    price: row.price,
    stake: row.stake,
    reputationBps: row.reputationBps,
    pausedByCreator: row.pausedByCreator,
    pausedByStake: row.pausedByStake,
    payoutWallet: row.payoutWallet,
    agentId: row.agentId,
    registryListingId: row.registryListingId,
    creatorAccountId: row.creatorAccountId,
    ownerAddress: ownerByAccount.get(row.creatorAccountId) ?? null,
    scoredCallCount: scoredByListing.get(row.id) ?? 0,
    createdAt: row.createdAt,
  }))
}
