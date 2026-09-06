import type { AgentType, CallStatus } from '@agent-desk/schemas'
import type { StoredPaymentPayload } from '@agent-desk/core/ports'

/**
 * Story 3.4 / FR-11: what the paid verification Call needs from Postgres.
 *
 * The `calls` row is the payment (AD-3: there is no `payments` table), so this
 * port writes exactly the AD-3 columns and no others. It is a port for the same
 * reason the run engine's `RunStore` is one — the Handshake itself is then
 * testable without a database, and `verification.test.ts` drives it through an
 * in-memory double.
 */

/** The `kind = 'verification'` row as this job reads it back. */
export interface VerificationCallRow {
  id: string
  status: CallStatus
  attempt: number
  /** The body already sent, so a resumed paid attempt never rebuilds it. */
  request: unknown
  failureReason: string | null
  paymentTxHash: string | null
  /** True once `signPayment` has written the authorization (AD-5). */
  hasPaymentPayload: boolean
}

/** Everything fixed at insert. AD-3 names every column; none of them is optional. */
export interface NewVerificationCall {
  id: string
  listingId: string
  nodeType: AgentType
  /** Base units, the declared price. */
  lockedPrice: string
  lockedPayTo: string
  lockedAsset: string
  lockedNetwork: string
  request: unknown
  startedAt: Date
}

/** Exactly the AD-3 columns this job writes after the insert. */
export interface VerificationCallPatch {
  status?: CallStatus
  response?: unknown
  paymentRequired?: unknown
  paymentTxHash?: string | null
  attempt?: number
  failureReason?: string | null
  endedAt?: Date
}

/** AD-3 / FR-11: the Platform Wallet's 24 h verification spend against its cap. */
export interface VerificationCapUsage {
  /** Base units, from the AD-3 query over `kind = 'verification'` Calls. */
  spent: bigint
  /** Base units, `platform_settings.verification_cap_daily`. */
  cap: bigint
}

export interface VerificationCallStore {
  /**
   * The verification Call this Listing already has, if any. A `listing.verify`
   * redelivered after a crash must find it rather than pay a second time; the
   * queue's singleton key stops two from running at once, and this stops two
   * from ever existing.
   */
  findForListing(listingId: string): Promise<VerificationCallRow | null>
  insert(call: NewVerificationCall): Promise<void>
  update(callId: string, patch: VerificationCallPatch): Promise<void>
  /** AD-5: the header `signPayment` stored, so a paid retry never re-signs. */
  readPaymentPayload(callId: string): Promise<StoredPaymentPayload | null>
  /** Read before the endpoint is touched, so an exhausted cap costs nothing. */
  capUsage(now: Date): Promise<VerificationCapUsage>
  /** AD-5: the Platform Wallet is an ordinary `wallets` row of the Platform Account. */
  platformWalletId(): Promise<string>
}
