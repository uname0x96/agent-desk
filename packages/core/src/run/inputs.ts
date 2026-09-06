import {
  validateInput,
  type AgentType,
  type DataOutput,
  type ExecutionOutput,
  type ResearchOutput,
  type RiskOutput,
  type Side,
  type SkipReason,
} from '@agent-desk/schemas'
import { compareDecimal } from './decimal.ts'

/**
 * PRD addendum §1: the engine builds every Node's input; an Agent never sees a
 * body it did not ask for. The mapping is pure, so the five-Node chain is a
 * matter of reading the previous Node's output and the Run's own context.
 *
 * Four of the five Types are built here. The fifth, `notify`, is the terminal
 * filter (AD-4): it is fed from the whole Run rather than from the Node before
 * it, and lives in `notify.ts`.
 *
 * Two rules run alongside the mapping and are deliberately in the same file,
 * because both decide whether a Call is paid for at all:
 *
 *   - {@link skipReasonFor}, PRD FR-24: a `HOLD` signal skips `risk` and
 *     `execution`; a `REJECT` decision skips `execution`. A skipped Node is
 *     never requested and never paid.
 *   - the two AD-11 order guards, checked before the `execution` Call is paid:
 *     the per-Workflow Order Cap and the exchange minimum notional. Emergency
 *     Stop and the global ceiling are *not* checked here — the executor Agent
 *     answers `REJECTED` for those, and the Builder pays for that answer.
 *
 * Every built input is parsed with the Type's own input schema before it is
 * returned, so a mapping that drifts from `packages/schemas` fails the Call
 * before payment instead of buying a 400 from the Agent.
 */

/** AD-11 / PRD addendum §7: BNBUSDT's minimum notional on Binance Spot. */
export const EXCHANGE_MIN_NOTIONAL_USDT = '5'

/**
 * The refusal reasons the acceptance criteria fix word for word. They are
 * written to `calls.failure_reason` and read back by the Run view and by tests,
 * so they are constants rather than inline strings.
 */
export const REFUSALS = {
  /** Story 2.8: the `ExchangeBalance` read before the `risk` Node failed. */
  balanceUnavailable: 'exchange balance unavailable',
  orderCapExceeded: 'order cap exceeded',
  belowMinimumNotional: `below exchange minimum notional (${EXCHANGE_MIN_NOTIONAL_USDT} USDT)`,
  noTelegramChatId: 'no Telegram chat id linked',
  /**
   * `proposed_size_usdt` is the Order Cap (PRD addendum §1). A `risk` Node on a
   * Workflow without one has no proposed size to send, and guessing one would
   * be the engine inventing the number the Builder is protected by.
   */
  noOrderCap: 'no Order Cap on the Workflow',
} as const

export interface NodeInputContext {
  nodeType: AgentType
  /** The Workflow's symbol, e.g. "BNBUSDT". */
  symbol: string
  /** Outputs of the Nodes already `succeeded`, keyed by Type. */
  outputs: Partial<Record<AgentType, unknown>>
  /** FR-4, decimal USDT. */
  orderCapUsdt?: string | null
  /** Read through the `ExchangeBalance` port just before the `risk` Node. */
  balanceUsdt?: string | null
}

export type NodeInputResult = { ok: true; input: unknown } | { ok: false; reason: string }

function refuse(reason: string): NodeInputResult {
  return { ok: false, reason }
}

/** The last gate before a Call is paid for: the engine's own output, re-parsed. */
function checked(type: AgentType, input: unknown): NodeInputResult {
  const parsed = validateInput(type, input)
  if (!parsed.ok) {
    const at = parsed.path === undefined || parsed.path === '' ? '' : ` at ${parsed.path}`
    return refuse(`the engine built an invalid ${type} input: ${parsed.error}${at}`)
  }
  return { ok: true, input: parsed.value }
}

// ------------------------------------------------------- reading an output

/**
 * A `succeeded` Call's response was validated against its Type before it was
 * stored, but it comes back out of a JSONB column as `unknown`. These readers
 * narrow it without re-running the schema: they check only the fields the
 * mapping actually reads, and answer null for anything else, which the caller
 * turns into a refusal naming the missing Node.
 */
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export function dataOutputOf(outputs: NodeInputContext['outputs']): DataOutput | null {
  const value = record(outputs.data)
  if (!value) return null
  return typeof value.symbol === 'string' && typeof value.price === 'string' ? (value as unknown as DataOutput) : null
}

export function researchOutputOf(outputs: NodeInputContext['outputs']): ResearchOutput | null {
  const value = record(outputs.research)
  if (!value) return null
  const { signal, confidence } = value
  if (signal !== 'LONG' && signal !== 'SHORT' && signal !== 'HOLD') return null
  return typeof confidence === 'number' ? (value as unknown as ResearchOutput) : null
}

export function riskOutputOf(outputs: NodeInputContext['outputs']): RiskOutput | null {
  const value = record(outputs.risk)
  if (!value) return null
  const { decision, size_usdt: size } = value
  if (decision !== 'APPROVE' && decision !== 'REDUCE' && decision !== 'REJECT') return null
  return typeof size === 'string' ? (value as unknown as RiskOutput) : null
}

export function executionOutputOf(outputs: NodeInputContext['outputs']): ExecutionOutput | null {
  const value = record(outputs.execution)
  if (!value) return null
  const { status } = value
  return status === 'FILLED' || status === 'REJECTED' ? (value as unknown as ExecutionOutput) : null
}

// ----------------------------------------------------------- skip decision

/** PRD addendum §1: the engine derives the side. `HOLD` never reaches an order. */
export function sideFor(signal: ResearchOutput['signal']): Side | null {
  if (signal === 'LONG') return 'BUY'
  if (signal === 'SHORT') return 'SELL'
  return null
}

/**
 * FR-24: whether this Node is skipped, and why, given what the Nodes before it
 * answered. Null means the Node runs.
 *
 * A `risk` Node skipped for `hold` leaves no risk output behind, so the
 * `execution` Node that follows falls through to the same `hold` reason rather
 * than to a missing-decision refusal — which is exactly what the criteria ask
 * for: a `HOLD` signal marks *both* `skipped` with `hold`.
 */
export function skipReasonFor(
  nodeType: AgentType,
  outputs: NodeInputContext['outputs'],
): SkipReason | null {
  if (nodeType !== 'risk' && nodeType !== 'execution') return null
  if (researchOutputOf(outputs)?.signal === 'HOLD') return 'hold'
  if (nodeType === 'execution' && riskOutputOf(outputs)?.decision === 'REJECT') return 'reject'
  return null
}

// ------------------------------------------------------------ the mapping

export function buildNodeInput(context: NodeInputContext): NodeInputResult {
  switch (context.nodeType) {
    case 'data':
      return checked('data', { symbol: context.symbol })

    case 'research': {
      const market = dataOutputOf(context.outputs)
      if (!market) return refuse('the research Node has no data output to read')
      return checked('research', { symbol: context.symbol, market })
    }

    case 'risk': {
      const market = dataOutputOf(context.outputs)
      if (!market) return refuse('the risk Node has no data output to read')
      const research = researchOutputOf(context.outputs)
      if (!research) return refuse('the risk Node has no research output to read')

      const proposed = context.orderCapUsdt
      if (proposed === null || proposed === undefined || proposed === '') {
        return refuse(REFUSALS.noOrderCap)
      }
      // The balance is read through the `ExchangeBalance` port just before this
      // Node (AD-11); a failed read arrives here as null and is refused before
      // anything is signed.
      const balance = context.balanceUsdt
      if (balance === null || balance === undefined || balance === '') {
        return refuse(REFUSALS.balanceUnavailable)
      }

      return checked('risk', {
        symbol: context.symbol,
        signal: research.signal,
        confidence: research.confidence,
        proposed_size_usdt: proposed,
        balance_usdt: balance,
        market,
      })
    }

    case 'execution': {
      const research = researchOutputOf(context.outputs)
      if (!research) return refuse('the execution Node has no research output to read')
      const risk = riskOutputOf(context.outputs)
      if (!risk) return refuse('the execution Node has no risk output to read')

      const side = sideFor(research.signal)
      if (!side) return refuse(`a ${research.signal} signal has no side to trade`)

      const size = risk.size_usdt
      // AD-11: the engine enforces the per-Workflow Order Cap and the exchange
      // minimum, and nothing else. Both refuse before payment.
      const cap = context.orderCapUsdt
      if (cap === null || cap === undefined || cap === '') return refuse(REFUSALS.noOrderCap)
      if (compareDecimal(size, cap) > 0) return refuse(REFUSALS.orderCapExceeded)
      if (compareDecimal(size, EXCHANGE_MIN_NOTIONAL_USDT) < 0) {
        return refuse(REFUSALS.belowMinimumNotional)
      }

      return checked('execution', { symbol: context.symbol, side, size_usdt: size })
    }

    case 'notify':
      // AD-4: `notify` is the terminal filter, fed from the Run rather than
      // from the Node before it. `buildNotifyInput` is its builder.
      return refuse('a notify Node is the terminal filter; its input comes from the Run')
  }
}
