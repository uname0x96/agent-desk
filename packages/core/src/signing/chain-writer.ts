import type { Address, ChainTxRecord, Hex } from '../ports/index.ts'
import type { PolicyRefusal } from './policy.ts'

/**
 * AD-8: `chainWrite(intentKey, buildTx)` is intent-first and idempotent. The
 * interface lives here, next to the policy whose refusals it can return,
 * because every chain write is signed through the same wallet lock as a payment
 * (AD-5); the implementation is `packages/adapters/chain`, which owns viem.
 *
 * The intent key is the identity of the transaction. A second call with the
 * same key never sends: it re-checks the receipt of the hash already recorded,
 * or returns the terminal row unchanged. That is what makes a redelivered
 * pg-boss job safe for a slash, a mint, or a registry write.
 */
export interface ChainWriter {
  chainWrite(intentKey: string, buildTx: BuildTx): Promise<ChainWriteResult>
  /**
   * AD-2: the only writer of the nine chain-owned `listings` columns. Called by
   * `chainWrite` after every confirmed receipt whose intent names a Listing, and
   * by `POST /api/listings/<id>/refresh`.
   */
  refreshListingFromChain(listingId: string, hints?: ListingRefreshHints): Promise<ListingRefreshResult>
}

export type BuildTx = () => ChainWriteRequest | Promise<ChainWriteRequest>

export interface ChainWriteRequest {
  /** The wallet that signs and pays gas. Resolved by the caller, not the writer. */
  walletId: string
  to: Address
  /** Calldata; `0x` for a plain BNB transfer. */
  data: Hex
  /** Wei. */
  value?: bigint
  gas?: bigint
  /** Overrides the signing service's default BNB floor for this intent. */
  gasFloorWei?: bigint
  /** FR-7 / FR-9: the ten-times minimum, when this write changes price or stake. */
  stakeCheck?: { price: bigint; stake: bigint }
  /** AD-8: recorded on the `chain_tx` row before anything is sent. */
  payload: unknown
}

export interface ChainWriteResult {
  intentKey: string
  /** The `chain_tx` row as it stands after this call. */
  record: ChainTxRecord
  /** True when the row already existed, so nothing was built and nothing sent. */
  reused: boolean
  /** Present when a receipt was read in this call. */
  receipt?: ChainReceipt
  /** Present when the signing policy refused; no row leaves `pending`. */
  refusal?: PolicyRefusal
}

export interface ChainReceipt {
  txHash: Hex
  status: 'success' | 'reverted'
  blockNumber: bigint
  /** The block's timestamp; what `chain_tx.confirmed_at` records. */
  timestamp: Date
  /**
   * Events this system knows how to read, decoded from the receipt logs so
   * callers never re-parse them. Story 1.7 takes `agentId` from `registered`
   * and the Registry id from `listed`; AD-9 takes the clamped amount from
   * `slashed`.
   */
  registered?: { agentId: string; agentURI: string; owner: Address }
  listed?: { registryListingId: string; agentId: string; price: string; stake: string }
  slashed?: { registryListingId: string; callRef: Hex; amount: string }
}

/**
 * Ids that exist only in the receipt of the transaction that just confirmed and
 * are therefore not yet in the listings cache. `chainWrite` fills them from the
 * decoded receipt; a manual refresh passes none and the cache supplies them.
 */
export interface ListingRefreshHints {
  registryListingId?: string
  agentId?: string
}

export type ListingRefreshResult =
  | { refreshed: true; registryListingId: string }
  /** No Registry entry yet — an `identity:` receipt arrives before `list:` does. */
  | { refreshed: false; reason: 'no_registry_listing_id' | 'listing_not_found' }
