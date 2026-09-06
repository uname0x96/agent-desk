import { z } from 'zod'
import { intentPrefixOf, toDecimalUsdt } from '@agent-desk/schemas'
import type { ChainTxView, ListingDetailResponse } from './listing-progress.ts'

/**
 * The Creator's change history, derived from `chain_tx` (Story 3.6, AD-2, AD-8).
 *
 * AD-2 says there is no history table: "price history is the `list:` row plus
 * `price:` rows of `chain_tx`". So this reads the rows the writes already leave
 * behind and turns each one into a line a Creator can act on — what changed,
 * from what to what, and the transaction that says so.
 *
 * Pure, and next to the schema it reads, so the page, the route and the test all
 * apply one definition of what a `price:` row means.
 */

/** AD-8: the three intents a Creator may create on a listed Agent. */
export const MANAGE_PREFIXES = ['price', 'stake', 'pause'] as const
export type ManagePrefix = (typeof MANAGE_PREFIXES)[number]

/** What was on the row before the write; a first listing reads as zero. */
const terms = z.object({
  price: z.string().optional(),
  stake: z.string().optional(),
  paused: z.boolean().optional(),
})

const listingIntentPayload = z.object({
  before: terms.optional(),
  after: terms.optional(),
})

export interface ManageHistoryRow {
  intentKey: string
  /** `price`, `stake`, `pause`, or the pipeline's `identity` and `list`. */
  intent: string
  /** `pending`, `confirmed`, `reverted`, `failed`, verbatim from `chain_tx`. */
  status: string
  txHash: string | null
  /** One line: what this transaction changed, in decimal tUSD (AD-13). */
  change: string
  createdAt: string
  confirmedAt: string | null
}

/**
 * Newest first, because a Creator who just pressed a button is looking for the
 * row they just made. The `identity:` and `list:` rows are part of the same
 * history — the `list:` row is the price the Listing started at.
 */
export function manageHistory(rows: readonly ChainTxView[]): ManageHistoryRow[] {
  return rows
    .map((row) => ({
      intentKey: row.intent_key,
      intent: intentPrefixOf(row.intent_key) ?? row.intent_key.split(':')[0] ?? 'unknown',
      status: row.status,
      txHash: row.tx_hash,
      change: describeChange(row),
      createdAt: row.created_at,
      confirmedAt: row.confirmed_at,
    }))
    .reverse()
}

/** AD-12: the manage page polls while any of its transactions can still move. */
export function hasPendingIntent(rows: readonly ChainTxView[]): boolean {
  return rows.some((row) => row.status === 'pending')
}

/**
 * One sentence per intent, from the `before` and `after` AD-8 captured at
 * enqueue. A `stake:` row states the total it moved the Stake to, because that
 * is the number the ten-times minimum is checked against; the difference is the
 * amount `addStake` was given.
 */
export function describeChange(row: ChainTxView): string {
  const parsed = listingIntentPayload.safeParse(row.payload)
  const before = parsed.success ? (parsed.data.before ?? {}) : {}
  const after = parsed.success ? (parsed.data.after ?? {}) : {}
  const intent = intentPrefixOf(row.intent_key)

  if (intent === 'price' && after.price !== undefined) {
    return `price ${usdt(before.price)} → ${usdt(after.price)} tUSD`
  }
  if (intent === 'stake' && after.stake !== undefined) {
    const added = BigInt(after.stake) - BigInt(before.stake ?? '0')
    return `Stake ${usdt(before.stake)} → ${usdt(after.stake)} tUSD (+${toDecimalUsdt(added < 0n ? 0n : added)})`
  }
  if (intent === 'pause' && after.paused !== undefined) {
    return after.paused ? 'paused by the creator' : 'resumed by the creator'
  }
  if (intent === 'list' && after.price !== undefined && after.stake !== undefined) {
    return `listed at ${usdt(after.price)} tUSD with ${usdt(after.stake)} tUSD of Stake`
  }
  if (intent === 'identity') return 'ERC-8004 identity minted'
  return '—'
}

/**
 * The one refusal the manage page can make before the request: a price whose
 * ten-times minimum is above the Stake the Registry holds. `decidePrice` on the
 * server says the same thing, from the same numbers.
 */
export function canManage(listing: ListingDetailResponse): boolean {
  return listing.is_creator && (listing.status === 'active' || listing.status === 'paused')
}

function usdt(base: string | undefined): string {
  return toDecimalUsdt(base ?? '0')
}
