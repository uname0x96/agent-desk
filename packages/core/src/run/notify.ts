import {
  toDecimalUsdt,
  validateInput,
  type AgentType,
  type CallStatus,
  type NotifyInput,
  type SkipReason,
} from '@agent-desk/schemas'
import { isCallPaid } from './machine.ts'
import {
  dataOutputOf,
  executionOutputOf,
  REFUSALS,
  researchOutputOf,
  riskOutputOf,
} from './inputs.ts'

/**
 * AD-4: `notify` is the terminal filter. It runs on every Run end — completed,
 * completed with no order, failed, or timed out — and its input is built from
 * the Run rather than from the Node before it (PRD addendum §1).
 *
 * Everything here is pure. The engine hands over what it already has on the
 * Run's rows; this file decides what the Builder is told:
 *
 *   - `cost_table` and `tx_hashes` list only Calls that were actually paid
 *     (AD-3's paid statuses), so a Run that failed at `risk` never claims to
 *     have paid for `execution` (FR-29);
 *   - `order` is the `execution` Call's own output and nothing else, so it is
 *     absent on every Run that failed before an order came back — which is
 *     every failed Run, since the only Node that can fail after the order is
 *     `notify` itself, and that Run's message is never delivered (FR-29);
 *   - `summary` ends with "no order" whenever the Workflow has an `execution`
 *     Node and no fill came back, which covers a `HOLD`, a `REJECT`, a
 *     `REJECTED` executor and a failure before the order (PRD addendum §1).
 */

/** What the terminal filter needs to know about one Call of the Run. */
export interface NotifyCallRecord {
  nodeIndex: number
  nodeType: AgentType
  /** `listings.name`, shown as Provider (FR-28). */
  provider: string
  /** Base units, from the Price Lock (AD-13). */
  lockedPrice: string
  status: CallStatus
  paymentTxHash?: string | null
  skipReason?: SkipReason | null
  /** The Type output of a `succeeded` Call. */
  response?: unknown
}

/** How the Run ended, as the summary has to say it. */
export type RunOutcome =
  | { kind: 'success' }
  | { kind: 'failed'; node: string; reason: string }
  | { kind: 'timed_out'; reason: string }

export interface NotifyContext {
  runId: string
  symbol: string
  /** `accounts.telegram_chat_id`; the Node is refused before payment without it. */
  telegramChatId?: string | null
  /** Every Call of the Run, in any order. */
  calls: readonly NotifyCallRecord[]
  outcome: RunOutcome
}

export type NotifyInputResult =
  | { ok: true; input: NotifyInput }
  | { ok: false; reason: string }

const TX_HASH = /^0x[0-9a-fA-F]{64}$/

/** Long enough to be useful in a chat message, short enough not to bury it. */
const REASON_LIMIT = 200

function trim(reason: string): string {
  return reason.length <= REASON_LIMIT ? reason : `${reason.slice(0, REASON_LIMIT - 1)}…`
}

function outputsOf(calls: readonly NotifyCallRecord[]): Partial<Record<AgentType, unknown>> {
  const outputs: Partial<Record<AgentType, unknown>> = {}
  for (const call of calls) {
    if (call.status === 'succeeded') outputs[call.nodeType] = call.response
  }
  return outputs
}

function riskPhrase(decision: string, size: string, reason: string): string {
  if (decision === 'REJECT') return `rejected by risk: ${trim(reason)}`
  if (decision === 'REDUCE') return `reduced to ${size} USDT`
  return `approved at ${size} USDT`
}

/**
 * The one sentence at the top of the Telegram message. The successful shape is
 * the PRD addendum's own example — "LONG BNBUSDT, reduced to 60 USDT, filled at
 * 612.55" — and every other ending is the same sentence with the part that did
 * not happen replaced by why.
 */
export function summarize(context: NotifyContext): string {
  const outputs = outputsOf(context.calls)
  const research = researchOutputOf(outputs)
  const risk = riskOutputOf(outputs)
  const order = executionOutputOf(outputs)
  const parts: string[] = []

  if (context.outcome.kind === 'failed') {
    parts.push(`${context.symbol} failed at ${context.outcome.node}`)
    parts.push(trim(context.outcome.reason))
  } else if (context.outcome.kind === 'timed_out') {
    parts.push(`${context.symbol} timed out`)
    parts.push(trim(context.outcome.reason))
  } else {
    const market = dataOutputOf(outputs)
    parts.push(
      research
        ? `${research.signal} ${context.symbol}`
        : market
          ? `${context.symbol} at ${market.price}`
          : context.symbol,
    )
    if (risk) parts.push(riskPhrase(risk.decision, risk.size_usdt, risk.reason))
    if (order?.status === 'FILLED') parts.push(`filled at ${order.filled_price ?? 'an unknown price'}`)
    if (order?.status === 'REJECTED') parts.push(`order rejected: ${trim(order.reason ?? 'no reason given')}`)
  }

  // PRD addendum §1: a Run whose `execution` Node did not fill ends with these
  // two words, whichever of the four ways it got there.
  const hasExecutionNode = context.calls.some((call) => call.nodeType === 'execution')
  if (hasExecutionNode && order?.status !== 'FILLED') parts.push('no order')

  return parts.join(', ')
}

export function buildNotifyInput(context: NotifyContext): NotifyInputResult {
  const address = context.telegramChatId
  if (address === null || address === undefined || address.trim() === '') {
    return { ok: false, reason: REFUSALS.noTelegramChatId }
  }

  const paid = [...context.calls]
    .sort((left, right) => left.nodeIndex - right.nodeIndex)
    .filter((call) => isCallPaid(call.status))

  const costTable = paid.map((call) => {
    const hash = call.paymentTxHash
    return {
      node: call.nodeType,
      provider: call.provider,
      amount: toDecimalUsdt(call.lockedPrice),
      // AD-14: omitted rather than null when the settlement hash is not known.
      ...(typeof hash === 'string' && TX_HASH.test(hash) ? { tx_hash: hash } : {}),
    }
  })

  const order = executionOutputOf(outputsOf(context.calls))

  const built = {
    run_id: context.runId,
    recipient: { channel: 'telegram', address },
    summary: summarize(context),
    cost_table: costTable,
    tx_hashes: costTable.flatMap((entry) => (entry.tx_hash === undefined ? [] : [entry.tx_hash])),
    ...(order ? { order } : {}),
  }

  const parsed = validateInput('notify', built)
  if (!parsed.ok) {
    const at = parsed.path === undefined || parsed.path === '' ? '' : ` at ${parsed.path}`
    return { ok: false, reason: `the engine built an invalid notify input: ${parsed.error}${at}` }
  }
  return { ok: true, input: parsed.value as NotifyInput }
}
