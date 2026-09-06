import { z } from 'zod'
import { agentTypeSchema } from '../types/index.ts'
import { callStatusSchema, chainTxStatusSchema } from '../status.ts'
import { addressSchema } from '../price-lock.ts'

/**
 * Story 5.4 — the Agent detail page.
 *
 * Its own file so the five Epic 5 surfaces do not share one module. The barrel
 * re-exports it, so callers still import from `@agent-desk/schemas`.
 *
 * ┌─ AD-2 ─────────────────────────────────────────────────────────────────┐
 * │ There is no history table. "Price history is the `list:` row plus      │
 * │ `price:` rows of `chain_tx`; reputation history is the `reputation:`   │
 * │ rows." So the body of `GET /api/listings/<id>/history` is the six      │
 * │ intents that make up an Agent's on-chain record — `list:`, `price:`,   │
 * │ `stake:`, `pause:`, `slash:`, `reputation:` — read back from the rows  │
 * │ AD-8 wrote before it sent each transaction. Nothing here is computed   │
 * │ from the chain at request time and nothing here is a counter.          │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * The six payloads do not share one shape on the wire: a listing intent
 * carries `{ before: { price, stake, paused }, after: { ... } }` (AD-8), a
 * `reputation:` intent carries `before` and `after` as bare basis points
 * (Story 4.4), and a `slash:` intent names a Call instead of a pair
 * (Story 4.3). This file is where those three become one row shape, so the
 * page reads one definition rather than three payload dialects.
 */

const baseUnits = z.string().regex(/^(?:0|[1-9]\d*)$/)
const txHash = z.string().regex(/^0x[0-9a-f]{64}$/)
const isoDate = z.iso.datetime({ offset: false })

/** AD-8, in the order a Listing's life produces them. */
export const AGENT_HISTORY_INTENTS = [
  'list',
  'price',
  'stake',
  'pause',
  'slash',
  'reputation',
] as const
export type AgentHistoryIntent = (typeof AGENT_HISTORY_INTENTS)[number]
export const agentHistoryIntentSchema = z.enum(AGENT_HISTORY_INTENTS)

/**
 * One side of a change, in the units AD-13 fixes: money as base-unit integer
 * strings, reputation as basis points. Every key is optional because an intent
 * states only what it moved — a `price:` row's `after` carries a price and
 * nothing else.
 */
export const agentHistoryTerms = z.object({
  price: baseUnits.optional(),
  stake: baseUnits.optional(),
  paused: z.boolean().optional(),
  reputation_bps: z.number().int().optional(),
})

/**
 * The `slash:<call_id>` payload Story 4.3 captures before sending, so the Stake
 * history renders without re-reading the chain. `amount` is what was asked for;
 * the contract clamps it to the remaining Stake, and the clamped figure lives on
 * the Settlement, not here.
 */
export const agentSlashView = z.object({
  call_id: z.string(),
  settlement_id: z.string().nullable(),
  amount: baseUnits,
  /** The Run's Builder System Wallet, which the same transaction refunds. */
  to: addressSchema.nullable(),
})

export const agentHistoryRow = z.object({
  intent_key: z.string(),
  intent: agentHistoryIntentSchema,
  status: chainTxStatusSchema,
  tx_hash: txHash.nullable(),
  before: agentHistoryTerms,
  after: agentHistoryTerms,
  /** Present only on a `slash:` row, whose payload has no before/after pair. */
  slash: agentSlashView.nullable(),
  created_at: isoDate,
  confirmed_at: isoDate.nullable(),
})

/**
 * FR-11: the one paid Call that put this Agent on the Registry. AD-3 makes it a
 * `calls` row with `kind = 'verification'` and no `run_id`; AD-9 never scores
 * one, so it is the Agent's verification record and never a settlement.
 *
 * `request` and `response` are the JSON that went over the wire, which is the
 * evidence the page exists to show; `listing-progress.ts` carries the same row
 * without them, because the Creator's pipeline view narrates steps rather than
 * payloads.
 */
export const agentVerificationCall = z.object({
  id: z.string(),
  status: callStatusSchema,
  node_type: agentTypeSchema,
  locked_price: baseUnits,
  locked_pay_to: addressSchema,
  attempt: z.number().int(),
  failure_reason: z.string().nullable(),
  request: z.unknown().nullable(),
  response: z.unknown().nullable(),
  payment_tx_hash: txHash.nullable(),
  started_at: isoDate.nullable(),
  ended_at: isoDate.nullable(),
})

/** The body of `GET /api/listings/<id>/history` (Story 4.4, extended by 5.4). */
export const agentHistoryResponse = z.object({
  listing_id: z.string(),
  /**
   * FR-11: an `execution` Agent is listed without a verification Call, because
   * a sample Call would place a real order. The Type travels with the history so
   * that "no Call" and "never called on purpose" are distinguishable from this
   * body alone.
   */
  type: agentTypeSchema,
  rows: z.array(agentHistoryRow),
  verification: agentVerificationCall.nullable(),
})

export type AgentHistoryTerms = z.infer<typeof agentHistoryTerms>
export type AgentSlashView = z.infer<typeof agentSlashView>
export type AgentHistoryRow = z.infer<typeof agentHistoryRow>
export type AgentVerificationCall = z.infer<typeof agentVerificationCall>
export type AgentHistoryResponse = z.infer<typeof agentHistoryResponse>
