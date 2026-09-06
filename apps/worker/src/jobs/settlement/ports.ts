import type { PlatformMode, SettlementResult } from '@agent-desk/schemas'
import type { SettlementCandidate, SettlementRowPlan } from '@agent-desk/core/settlement'

/**
 * What the settlement tick needs from Postgres and from the Registry.
 *
 * The rules themselves are pure and live in `packages/core/settlement`; these
 * two ports are the whole of the tick's contact with the outside world, which
 * is what lets `tick.test.ts` drive the full slash-and-reputation sequence
 * without a database, a chain, or a network.
 */

// ------------------------------------------------------------------- store

/**
 * A Call the tick may have to score, together with the three facts the slash
 * needs and the candidate does not: what to move, from which Registry entry,
 * and to whom.
 */
export interface SettlementWork {
  candidate: SettlementCandidate
  /** AD-9: "amount = locked price". Base units, from the Price Lock. */
  lockedPrice: string
  /** `listings.registry_listing_id`; null before the `list:` receipt landed. */
  registryListingId: string | null
  /** AD-9: the Run's Builder System Wallet, where the refund goes. Lower-case. */
  refundTo: string | null
}

/** The `settlements` row as the tick reads it back. */
export interface SettlementRecord {
  id: string
  callId: string
  listingId: string
  result: SettlementResult
  /** Base units, read from the `Slashed` event. */
  slashAmount: string | null
  slashTxHash: string | null
  refundTo: string | null
  reputationTxHash: string | null
}

/** A row that exists but whose chain writes have not all landed yet. */
export interface SettlementFollowUp {
  record: SettlementRecord
  work: SettlementWork
}

export interface SettlementStore {
  /** AD-10: `platform_settings.mode`, re-read every tick; that read governs. */
  mode(): Promise<PlatformMode>
  /**
   * Story 4.1: `research` and `risk` Calls with `kind = 'run'` in `succeeded`
   * or `failed_after_payment` with no `settlements` row. `failed_after_payment`
   * is in the periodic selection on purpose, so a dropped `settlement.tick` job
   * is recovered by the loop.
   */
  due(limit: number): Promise<SettlementWork[]>
  /** The same shape for one named Call, for `settlement.tick { call_id }`. */
  workFor(callId: string): Promise<SettlementWork | null>
  /**
   * Rows whose slash or reputation write has not confirmed. This is what makes
   * a lost receipt cost latency rather than a missing Refund: the next tick
   * picks the row up and calls `chainWrite` on the same intent key.
   */
  unfinished(limit: number): Promise<SettlementFollowUp[]>
  find(callId: string): Promise<SettlementRecord | null>
  /**
   * AD-9: `call_id` is unique, so this is where "settled at most once" is
   * actually decided. `inserted: false` means another tick won the race and the
   * returned record is theirs.
   */
  insert(row: SettlementRowPlan): Promise<{ record: SettlementRecord; inserted: boolean }>
  recordSlash(settlementId: string, slash: RecordedSlash): Promise<void>
  recordReputation(settlementId: string, txHash: string): Promise<void>
  /** AD-9: the listing's scored results, newest first, for the reputation window. */
  recentResults(listingId: string, limit: number): Promise<SettlementResult[]>
  /** `listings.reputation_bps`, the `before` of the `reputation:` payload. */
  reputationOf(listingId: string): Promise<number | null>
  /** AD-8: a `reverted` or `failed` intent that names no Listing records itself. */
  noteListingError(listingId: string, message: string): Promise<void>
}

export interface RecordedSlash {
  /** Base units, from the `Slashed` event — the clamped amount, not the ask. */
  slashAmount: string
  slashTxHash: string
  refundTo: string
}

// ------------------------------------------------------------------- chain

/**
 * The two Registry writes a Settlement makes, both from the Platform Wallet and
 * both through `chainWrite` on their AD-8 intent key. The port hides viem and
 * `chain_tx` from the tick; `chain.ts` is the implementation.
 */
export interface SettlementChain {
  slash(request: SlashRequest): Promise<ChainOutcome>
  setReputation(request: ReputationRequest): Promise<ChainOutcome>
}

export interface SlashRequest {
  settlementId: string
  callId: string
  listingId: string
  registryListingId: string
  /** Base units: exactly the Call's locked price (addendum §4). */
  amount: string
  /** The Builder System Wallet of the Run. */
  to: string
}

export interface ReputationRequest {
  settlementId: string
  listingId: string
  registryListingId: string
  bps: number
  /** `listings.reputation_bps` before this write, for the history payload. */
  beforeBps: number | null
}

export type ChainOutcome =
  /** The receipt is in. `amount` is set for a slash, read from `Slashed`. */
  | { status: 'confirmed'; txHash: string; amount?: string }
  /** Sent, or already sent by an earlier tick, but no receipt yet. Retry next tick. */
  | { status: 'pending'; txHash: string | null }
  /** The signing policy refused; nothing was signed and nothing was spent. */
  | { status: 'refused'; reason: string }
  /** Reverted on chain, or the node would not take it. Terminal for this key. */
  | { status: 'failed'; reason: string; txHash: string | null }
