import type { AgentType, ListingStatus } from '@agent-desk/schemas'
import type { Address, Hex } from '../ports/index.ts'

/**
 * What the `listing.verify` pipeline needs from the outside world.
 *
 * AD-2 draws the line these ports sit on: the chain-owned columns belong to
 * `refreshListingFromChain` and appear nowhere here, while `status` and
 * `last_error` are pipeline columns and are the only two this store may write.
 */

/** The `listings` row as the pipeline reads it: form-owned columns plus its own. */
export interface ListingPipelineRow {
  id: string
  creatorAccountId: string
  name: string
  description: string | null
  type: AgentType
  endpoint: string
  /** Base units. */
  declaredPrice: string
  /** Base units. */
  declaredStake: string
  payoutWallet: Address
  status: ListingStatus
  /** AD-2 / Story 3.4: accepted only from the seed script. */
  skipVerification: boolean
  /** Chain-owned; read only, and null until the receipts land. */
  agentId: string | null
  registryListingId: string | null
}

/** The Creator wallet, which signs `register` and `list` and owns the `agentId`. */
export interface CreatorWallet {
  id: string
  address: Address
  /** AD-5: null until `approve:<wallet_id>` confirmed. */
  readyAt: Date | null
}

export interface ListingPipelineStore {
  read(listingId: string): Promise<ListingPipelineRow | null>
  creatorWallet(listingId: string): Promise<CreatorWallet | null>
  /** The two pipeline columns, written together so a status never outlives its reason. */
  writeStatus(listingId: string, status: ListingStatus, lastError: string | null): Promise<void>
}

/**
 * The events of a confirmed transaction this job needs but did not see.
 *
 * `chainWrite` decodes the receipt of a transaction it sent, but a job
 * redelivered after a crash finds the `chain_tx` row already `confirmed` and
 * gets no receipt back (AD-8: it re-checks, it does not re-send). The hash is
 * on the row, so the events can be read again — which is what lets a resumed
 * job build `list(...)` from the `agentId` a previous run minted instead of
 * minting a second identity.
 */
export interface ListingReceiptSource {
  /** The `Registered` event of an `identity:` transaction. */
  registeredAgentId(txHash: Hex): Promise<string | null>
  /** The `Listed` event of a `list:` transaction. */
  listedRegistryListingId(txHash: Hex): Promise<string | null>
}

// ------------------------------------------------- the Story 3.4 seam

/**
 * FR-11 / AD-2: the paid verification Call that runs before an identity is
 * minted and before any Stake is locked.
 *
 * Story 1.7 defines the seat; Story 3.4 fills it with the real Handshake from
 * the Platform Wallet (verification cap, `calls` row, unpaid POST, `accepts`
 * comparison, `signPayment`, paid POST, `validateOutput`). It is a port and not
 * a boolean because that substitution must be a wiring change in the worker,
 * not an edit inside the pipeline.
 *
 * The default implementation refuses. A placeholder that passed would list an
 * Agent nobody has called, which is precisely what FR-11 exists to prevent, and
 * the failure would surface only when a Builder paid for a Run.
 */
export interface VerificationCall {
  run(listing: ListingPipelineRow): Promise<VerificationOutcome>
}

export type VerificationOutcome =
  /** `callId` is the `kind = 'verification'` Call row Story 3.4 inserts. */
  | { ok: true; callId: string | null }
  /** Verbatim into `listings.last_error`; Story 3.4 owns the exact wording. */
  | { ok: false; reason: string }

export const VERIFICATION_NOT_IMPLEMENTED =
  'the paid verification Call is not implemented yet (Story 3.4); ' +
  'only a listing seeded with skip_verification can be listed today'

export function createUnimplementedVerificationCall(): VerificationCall {
  return {
    run: async () => ({ ok: false, reason: VERIFICATION_NOT_IMPLEMENTED }),
  }
}
