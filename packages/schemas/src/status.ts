import { z } from 'zod'

/** Verbatim from the PRD (FR-28) and AD-4. Stored as text; nothing invents a status. */

export const CALL_STATUSES = [
  'pending',
  'price_mismatch',
  'payment_failed',
  'paid_awaiting_result',
  'succeeded',
  'failed_after_payment',
  'skipped',
] as const
export type CallStatus = (typeof CALL_STATUSES)[number]
export const callStatusSchema = z.enum(CALL_STATUSES)

export const TERMINAL_CALL_STATUSES: readonly CallStatus[] = [
  'price_mismatch',
  'payment_failed',
  'succeeded',
  'failed_after_payment',
  'skipped',
]

/** A Call in one of these statuses has been paid for (AD-3 spend query). */
export const PAID_CALL_STATUSES: readonly CallStatus[] = [
  'paid_awaiting_result',
  'succeeded',
  'failed_after_payment',
]

export const RUN_STATUSES = ['running', 'completed', 'completed, no order', 'timed out'] as const
export type RunStatusLiteral = (typeof RUN_STATUSES)[number]
/** `failed at <Node>` carries the Type name, so the Run status is a template. */
export type RunStatus = RunStatusLiteral | `failed at ${string}`

export const runStatusSchema = z
  .string()
  .refine(
    (value) => (RUN_STATUSES as readonly string[]).includes(value) || value.startsWith('failed at '),
    'not a Run status',
  )

export function failedAt(nodeType: string): RunStatus {
  return `failed at ${nodeType}`
}

export function isRunTerminal(status: string): boolean {
  return status !== 'running'
}

export const CALL_KINDS = ['run', 'verification'] as const
export type CallKind = (typeof CALL_KINDS)[number]
export const callKindSchema = z.enum(CALL_KINDS)

export const SKIP_REASONS = ['not_reached', 'hold', 'reject'] as const
export type SkipReason = (typeof SKIP_REASONS)[number]
export const skipReasonSchema = z.enum(SKIP_REASONS)

/** AD-2: exactly four listing statuses. */
export const LISTING_STATUSES = ['verifying', 'failed', 'active', 'paused'] as const
export type ListingStatus = (typeof LISTING_STATUSES)[number]
export const listingStatusSchema = z.enum(LISTING_STATUSES)

/** AD-8 */
export const CHAIN_TX_STATUSES = ['pending', 'confirmed', 'reverted', 'failed'] as const
export type ChainTxStatus = (typeof CHAIN_TX_STATUSES)[number]
export const chainTxStatusSchema = z.enum(CHAIN_TX_STATUSES)

/** AD-9 */
export const SETTLEMENT_RESULTS = ['passed', 'failed', 'not_scored'] as const
export type SettlementResult = (typeof SETTLEMENT_RESULTS)[number]
export const settlementResultSchema = z.enum(SETTLEMENT_RESULTS)

export const NOT_SCORED_REASONS = ['reject_decision', 'no_fill', 'no_reference_price'] as const
export type NotScoredReason = (typeof NOT_SCORED_REASONS)[number]
export const notScoredReasonSchema = z.enum(NOT_SCORED_REASONS)

export const PLATFORM_MODES = ['production', 'demo'] as const
export type PlatformMode = (typeof PLATFORM_MODES)[number]
export const platformModeSchema = z.enum(PLATFORM_MODES)

/** AD-9: the only price source Settlement may name. */
export const PRICE_SOURCE = 'binance-public-market-data' as const
