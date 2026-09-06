import type { ListingStatus } from '@agent-desk/schemas'
import type { Address } from '@agent-desk/core/ports'

/**
 * Story 3.6 / FR-7, FR-8, FR-9: what the `listing.write` job needs from
 * Postgres.
 *
 * AD-2 draws the same line here that it draws for `listing.verify`. The nine
 * chain-owned columns are readable — the job has to know the price it is about
 * to break the ten-times minimum against — but they are not writable from this
 * port at all. `refreshListingFromChain` fills them from the confirmed receipt
 * and nothing else touches them; what this store may write is `status` and
 * `last_error`, which are pipeline columns.
 */

/** The `listings` row as the write job reads it. */
export interface ListingWriteRow {
  id: string
  creatorAccountId: string
  /** AD-2: only `active` and `paused` have a Registry entry to write to. */
  status: ListingStatus
  registryListingId: string | null
  // -- chain-owned, read only -----------------------------------------------
  /** Base units, from the Registry. Null before the first confirmed receipt. */
  price: string | null
  stake: string | null
  pausedByCreator: boolean
  pausedByStake: boolean
}

/** The Creator wallet, which owns the Registry entry and signs every change. */
export interface ListingWriteWallet {
  id: string
  address: Address
  /** AD-5: null until `approve:<wallet_id>` confirmed. */
  readyAt: Date | null
}

/** The two pipeline columns, written together so neither outlives the other. */
export interface ListingWritePatch {
  status?: ListingStatus
  lastError?: string | null
}

export interface ListingWriteStore {
  read(listingId: string): Promise<ListingWriteRow | null>
  creatorWallet(listingId: string): Promise<ListingWriteWallet | null>
  patch(listingId: string, patch: ListingWritePatch): Promise<void>
}
