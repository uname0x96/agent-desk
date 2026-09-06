import { z } from 'zod'

/**
 * The five standard Type contracts (FR-15, PRD addendum section 1, normative).
 * All amounts are decimal strings in USDT. All timestamps are ISO 8601 UTC.
 * Unknown fields in a response are ignored: Zod strips them by default.
 */

export const AGENT_TYPES = ['data', 'research', 'risk', 'execution', 'notify'] as const
export type AgentType = (typeof AGENT_TYPES)[number]
export const agentTypeSchema = z.enum(AGENT_TYPES)

/** Non-negative decimal amount, e.g. "612.40". */
export const decimalAmount = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, 'must be a non-negative decimal string')

export const symbolSchema = z.string().regex(/^[A-Z0-9]{5,20}$/, 'must be an uppercase trading symbol')
export const isoTimestamp = z.iso.datetime({ offset: false })

// ---------------------------------------------------------------- data

export const dataInput = z.object({ symbol: symbolSchema })

export const dataOutput = z.object({
  symbol: symbolSchema,
  price: decimalAmount,
  change_24h_pct: z.number(),
  volatility_24h_pct: z.number().min(0),
  ts: isoTimestamp,
})

// ------------------------------------------------------------ research

export const SIGNALS = ['LONG', 'SHORT', 'HOLD'] as const
export type Signal = (typeof SIGNALS)[number]
export const signalSchema = z.enum(SIGNALS)

export const researchInput = z.object({ symbol: symbolSchema, market: dataOutput })

export const researchOutput = z.object({
  signal: signalSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
})

// ---------------------------------------------------------------- risk

export const DECISIONS = ['APPROVE', 'REDUCE', 'REJECT'] as const
export type Decision = (typeof DECISIONS)[number]
export const decisionSchema = z.enum(DECISIONS)

export const riskInput = z.object({
  symbol: symbolSchema,
  signal: signalSchema,
  confidence: z.number().min(0).max(1),
  proposed_size_usdt: decimalAmount,
  balance_usdt: decimalAmount,
  market: dataOutput,
})

export const riskOutput = z.object({
  decision: decisionSchema,
  size_usdt: decimalAmount,
  reason: z.string().min(1).max(500),
})

// ----------------------------------------------------------- execution

export const SIDES = ['BUY', 'SELL'] as const
export type Side = (typeof SIDES)[number]
export const sideSchema = z.enum(SIDES)

export const executionInput = z.object({
  symbol: symbolSchema,
  side: sideSchema,
  size_usdt: decimalAmount,
})

export const executionOutput = z.object({
  status: z.enum(['FILLED', 'REJECTED']),
  order_id: z.string().min(1).optional(),
  filled_price: decimalAmount.optional(),
  filled_qty: decimalAmount.optional(),
  reason: z.string().min(1).max(500).optional(),
  ts: isoTimestamp,
})

// -------------------------------------------------------------- notify

export const costTableEntry = z.object({
  node: agentTypeSchema,
  provider: z.string().min(1),
  amount: decimalAmount,
  /** Omitted when the settlement hash is not yet known (PRD addendum section 1). */
  tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
})

export const notifyInput = z.object({
  run_id: z.string().nullable(),
  recipient: z.object({ channel: z.literal('telegram'), address: z.string().min(1) }),
  summary: z.string().min(1),
  cost_table: z.array(costTableEntry),
  tx_hashes: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)),
  order: executionOutput.optional(),
})

export const notifyOutput = z.object({
  delivered: z.boolean(),
  channel: z.literal('telegram'),
  message_ref: z.string().min(1),
})

// ------------------------------------------------------------ registry

export const typeSchemas = {
  data: { input: dataInput, output: dataOutput },
  research: { input: researchInput, output: researchOutput },
  risk: { input: riskInput, output: riskOutput },
  execution: { input: executionInput, output: executionOutput },
  notify: { input: notifyInput, output: notifyOutput },
} as const

export type TypeInput<T extends AgentType> = z.infer<(typeof typeSchemas)[T]['input']>
export type TypeOutput<T extends AgentType> = z.infer<(typeof typeSchemas)[T]['output']>

export type DataOutput = z.infer<typeof dataOutput>
export type ResearchOutput = z.infer<typeof researchOutput>
export type RiskOutput = z.infer<typeof riskOutput>
export type ExecutionOutput = z.infer<typeof executionOutput>
export type NotifyInput = z.infer<typeof notifyInput>
export type NotifyOutput = z.infer<typeof notifyOutput>
export type RiskInput = z.infer<typeof riskInput>
export type ResearchInput = z.infer<typeof researchInput>
export type ExecutionInput = z.infer<typeof executionInput>
export type DataInput = z.infer<typeof dataInput>
