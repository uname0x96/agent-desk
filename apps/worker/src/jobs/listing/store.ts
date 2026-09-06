import { eq } from 'drizzle-orm'
import { listings, wallets, type Database } from '@agent-desk/db'
import type { ListingStatus } from '@agent-desk/schemas'
import type {
  CreatorWallet,
  ListingPipelineRow,
  ListingPipelineStore,
} from '@agent-desk/core/listing'

/**
 * The Postgres side of the `listing.verify` ports.
 *
 * AD-1 is why it lives in the worker: `packages/core` may not see
 * `@agent-desk/db`, so a host is the one place allowed to hold both halves —
 * the same arrangement `scripts/src/wiring/stores.ts` uses for signing.
 *
 * AD-2 is why `writeStatus` writes only `status` and `last_error`. The nine
 * chain-owned columns are not reachable from here at all; `refreshListingFromChain`
 * is their single writer and this store has no access to it.
 */
export function createListingPipelineStore(db: Database): ListingPipelineStore {
  return {
    async read(listingId): Promise<ListingPipelineRow | null> {
      const [row] = await db
        .select({
          id: listings.id,
          creatorAccountId: listings.creatorAccountId,
          name: listings.name,
          description: listings.description,
          type: listings.type,
          endpoint: listings.endpoint,
          declaredPrice: listings.declaredPrice,
          declaredStake: listings.declaredStake,
          payoutWallet: listings.payoutWallet,
          status: listings.status,
          skipVerification: listings.skipVerification,
          agentId: listings.agentId,
          registryListingId: listings.registryListingId,
        })
        .from(listings)
        .where(eq(listings.id, listingId))
        .limit(1)
      return row ?? null
    },

    /**
     * AD-2: the Creator wallet signs `register` and `list` and owns the
     * `agentId`. An Account has one System Wallet (FR-2), so the join needs no
     * ordering to be deterministic.
     */
    async creatorWallet(listingId): Promise<CreatorWallet | null> {
      const [row] = await db
        .select({ id: wallets.id, address: wallets.address, readyAt: wallets.readyAt })
        .from(listings)
        .innerJoin(wallets, eq(wallets.accountId, listings.creatorAccountId))
        .where(eq(listings.id, listingId))
        .limit(1)
      return row ?? null
    },

    async writeStatus(listingId, status: ListingStatus, lastError: string | null): Promise<void> {
      await db
        .update(listings)
        .set({ status, lastError, updatedAt: new Date() })
        .where(eq(listings.id, listingId))
    },
  }
}
