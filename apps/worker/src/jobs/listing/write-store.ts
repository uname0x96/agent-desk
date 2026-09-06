import { eq } from 'drizzle-orm'
import { listings, wallets, type Database } from '@agent-desk/db'
import type { ListingWriteRow, ListingWriteStore, ListingWriteWallet } from './write-ports.ts'

/**
 * The Postgres side of the `listing.write` ports.
 *
 * AD-1 is why it lives in the worker: `packages/core` may not see
 * `@agent-desk/db`, so a host is the one place allowed to hold both halves —
 * the same arrangement `createListingPipelineStore` next door uses.
 *
 * AD-2 is why `patch` writes only `status` and `last_error`. The nine
 * chain-owned columns are selected here because the ten-times minimum is
 * checked against them, but there is no path from this store to a write of any
 * of them; `refreshListingFromChain` is still their only writer.
 */
export function createListingWriteStore(db: Database): ListingWriteStore {
  return {
    async read(listingId): Promise<ListingWriteRow | null> {
      const [row] = await db
        .select({
          id: listings.id,
          creatorAccountId: listings.creatorAccountId,
          status: listings.status,
          registryListingId: listings.registryListingId,
          price: listings.price,
          stake: listings.stake,
          pausedByCreator: listings.pausedByCreator,
          pausedByStake: listings.pausedByStake,
        })
        .from(listings)
        .where(eq(listings.id, listingId))
        .limit(1)
      return row ?? null
    },

    /** AD-2: the Creator wallet owns the Registry entry and signs every change. */
    async creatorWallet(listingId): Promise<ListingWriteWallet | null> {
      const [row] = await db
        .select({ id: wallets.id, address: wallets.address, readyAt: wallets.readyAt })
        .from(listings)
        .innerJoin(wallets, eq(wallets.accountId, listings.creatorAccountId))
        .where(eq(listings.id, listingId))
        .limit(1)
      return row ?? null
    },

    async patch(listingId, patch): Promise<void> {
      if (patch.status === undefined && patch.lastError === undefined) return
      await db
        .update(listings)
        .set({
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.lastError === undefined ? {} : { lastError: patch.lastError }),
          updatedAt: new Date(),
        })
        .where(eq(listings.id, listingId))
    },
  }
}
