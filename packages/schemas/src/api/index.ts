import { z } from 'zod'
import { agentTypeSchema } from '../types/index.ts'
import {
  callKindSchema,
  callStatusSchema,
  listingStatusSchema,
  notScoredReasonSchema,
  platformModeSchema,
  settlementResultSchema,
  skipReasonSchema,
} from '../status.ts'
import { addressSchema, priceLock } from '../price-lock.ts'

/** AD-14: every /api/* request and response body. Both sides parse with these. */

const baseUnits = z.string().regex(/^(?:0|[1-9]\d*)$/)
const decimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
const txHash = z.string().regex(/^0x[0-9a-f]{64}$/)
const isoDate = z.iso.datetime({ offset: false })

/** Every list endpoint answers this shape. */
export function listOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), next: z.string().nullable() })
}

// ------------------------------------------------------------------ auth

export const signUpRequest = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
})
export const signInRequest = signUpRequest

export const meResponse = z.object({
  account_id: z.string(),
  email: z.email(),
  is_operator: z.boolean(),
  wallet_address: addressSchema.nullable(),
  wallet_ready_at: isoDate.nullable(),
  telegram_chat_id: z.string().nullable(),
  daily_fee_budget: baseUnits,
  budget_spent: baseUnits,
  budget_remaining: baseUnits,
})

export const patchMeRequest = z.object({
  daily_fee_budget: decimal.nullable().optional(),
  telegram_chat_id: z.string().regex(/^-?\d+$/).nullable().optional(),
})

// -------------------------------------------------------------- listings

export const createListingRequest = z.object({
  name: z.string().min(1).max(80),
  type: agentTypeSchema,
  endpoint: z.string().url(),
  price: decimal,
  stake: decimal,
  description: z.string().max(500).optional(),
  payout_wallet: z.string().optional(),
})

export const listingResponse = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: agentTypeSchema,
  endpoint: z.string(),
  status: listingStatusSchema,
  last_error: z.string().nullable(),
  price: baseUnits,
  stake: baseUnits,
  reputation_bps: z.number().int().nullable(),
  scored_call_count: z.number().int(),
  paused_by_creator: z.boolean(),
  paused_by_stake: z.boolean(),
  payout_wallet: addressSchema.nullable(),
  owner_address: addressSchema.nullable(),
  creator_account_id: z.string(),
  agent_id: z.string().nullable(),
  registry_listing_id: z.string().nullable(),
  created_at: isoDate,
})

export const listingsResponse = listOf(listingResponse)

export const setPriceRequest = z.object({ price: decimal })
export const addStakeRequest = z.object({ amount: decimal })
export const setPausedRequest = z.object({ paused: z.boolean() })
export const intentAccepted = z.object({ intent_key: z.string() })

export const agentCard = z.object({
  name: z.string(),
  description: z.string().nullable(),
  type: agentTypeSchema,
  endpoint: z.string(),
  agent_id: z.string().nullable(),
  registry_listing_id: z.string().nullable(),
  payout_wallet: addressSchema.nullable(),
  schema_url: z.string(),
})

export const chainTxView = z.object({
  intent_key: z.string(),
  status: z.string(),
  tx_hash: txHash.nullable(),
  payload: z.record(z.string(), z.unknown()),
  created_at: isoDate,
  confirmed_at: isoDate.nullable(),
})

// -------------------------------------------------------------- workflows

export const workflowNodeRequest = z.object({
  type: agentTypeSchema,
  listing_id: z.string().min(1),
})

export const saveWorkflowRequest = z.object({
  name: z.string().min(1).max(80),
  symbol: z.string().min(5).max(20),
  order_cap_usdt: decimal.nullable(),
  nodes: z.array(workflowNodeRequest).min(1).max(5),
})

export const workflowResponse = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  order_cap_usdt: baseUnits.nullable(),
  nodes: z.array(
    z.object({
      node_index: z.number().int(),
      type: agentTypeSchema,
      listing_id: z.string(),
      provider: z.string(),
      price: baseUnits,
      status: listingStatusSchema,
    }),
  ),
  last_run_status: z.string().nullable(),
  created_at: isoDate,
})

export const chainViolation = z.object({
  node_index: z.number().int().nullable(),
  rule: z.string(),
  message: z.string(),
})

// ------------------------------------------------------------------- runs

export const createRunRequest = z.object({ workflow_id: z.string().min(1) })

export const settlementView = z.object({
  id: z.string(),
  call_id: z.string(),
  listing_id: z.string(),
  result: settlementResultSchema,
  not_scored_reason: notScoredReasonSchema.nullable(),
  mode: platformModeSchema,
  rule_label: z.string(),
  price_source: z.string(),
  start_price: decimal.nullable(),
  end_price: decimal.nullable(),
  change_24h_pct: z.number().nullable(),
  p_fill: decimal.nullable(),
  window_min: decimal.nullable(),
  window_max: decimal.nullable(),
  scored_at: isoDate,
  slash_amount: baseUnits.nullable(),
  slash_tx_hash: txHash.nullable(),
  refund_to: addressSchema.nullable(),
  reputation_tx_hash: txHash.nullable(),
})

export const callView = z.object({
  id: z.string(),
  kind: callKindSchema,
  node_index: z.number().int().nullable(),
  node_type: agentTypeSchema,
  listing_id: z.string(),
  provider: z.string(),
  status: callStatusSchema,
  locked_price: baseUnits,
  locked_pay_to: addressSchema,
  locked_asset: addressSchema,
  locked_network: z.string(),
  request: z.unknown().nullable(),
  response: z.unknown().nullable(),
  payment_required: z.unknown().nullable(),
  payment_tx_hash: txHash.nullable(),
  attempt: z.number().int(),
  reference_price: decimal.nullable(),
  reference_at: isoDate.nullable(),
  failure_reason: z.string().nullable(),
  skip_reason: skipReasonSchema.nullable(),
  started_at: isoDate.nullable(),
  ended_at: isoDate.nullable(),
  settlement: settlementView.nullable(),
})

export const runResponse = z.object({
  id: z.string(),
  workflow_id: z.string(),
  workflow_name: z.string(),
  symbol: z.string(),
  status: z.string(),
  failure_reason: z.string().nullable(),
  price_lock: priceLock,
  wallet_address: addressSchema.nullable(),
  total_cost: baseUnits,
  created_at: isoDate,
  started_at: isoDate.nullable(),
  ended_at: isoDate.nullable(),
  calls: z.array(callView),
})

export const runSummary = runResponse.omit({ calls: true, price_lock: true }).extend({
  nodes: z.array(z.object({ node_type: agentTypeSchema, status: callStatusSchema })),
})

export const runsResponse = listOf(runSummary)

export const paymentView = z.object({
  call_id: z.string(),
  run_id: z.string().nullable(),
  node_type: agentTypeSchema,
  provider: z.string(),
  amount: baseUnits,
  from: addressSchema.nullable(),
  to: addressSchema,
  status: callStatusSchema,
  payment_tx_hash: txHash.nullable(),
  started_at: isoDate.nullable(),
  ended_at: isoDate.nullable(),
  settlement_id: z.string().nullable(),
})

export const paymentsResponse = listOf(paymentView)
export const settlementsResponse = listOf(
  settlementView.extend({
    run_id: z.string().nullable(),
    node_type: agentTypeSchema,
    provider: z.string(),
  }),
)

// --------------------------------------------------------------- settings

export const publicSettings = z.object({
  mode: platformModeSchema,
  emergency_stop: z.boolean(),
})

export const operatorSettingsRequest = z.object({
  emergency_stop: z.boolean().optional(),
  mode: platformModeSchema.optional(),
  order_ceiling_usdt: decimal.optional(),
})

export const operatorAccountView = z.object({
  account_id: z.string(),
  email: z.email(),
  wallet_address: addressSchema.nullable(),
  daily_fee_budget: baseUnits,
  budget_spent: baseUnits,
})

export const operatorAccountsResponse = listOf(operatorAccountView)

export const healthResponse = z.object({
  ok: z.boolean(),
  database: z.boolean(),
  worker_seen_at: isoDate.nullable(),
})

export type CreateListingRequest = z.infer<typeof createListingRequest>
export type ListingResponse = z.infer<typeof listingResponse>
export type SaveWorkflowRequest = z.infer<typeof saveWorkflowRequest>
export type WorkflowResponse = z.infer<typeof workflowResponse>
export type RunResponse = z.infer<typeof runResponse>
export type RunSummary = z.infer<typeof runSummary>
export type CallView = z.infer<typeof callView>
export type SettlementView = z.infer<typeof settlementView>
export type PaymentView = z.infer<typeof paymentView>
export type MeResponse = z.infer<typeof meResponse>
export type PublicSettings = z.infer<typeof publicSettings>
export type ChainViolation = z.infer<typeof chainViolation>
export type AgentCard = z.infer<typeof agentCard>
