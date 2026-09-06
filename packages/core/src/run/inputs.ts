import type { AgentType } from '@agent-desk/schemas'

/**
 * PRD addendum §1: the engine builds every Node's input; an Agent never sees a
 * body it did not ask for. The mapping is pure, so the chain of five Nodes in
 * Story 2.8 is a matter of filling in the remaining branches of one switch.
 *
 * Story 1.8 covers the `data` Node, which takes the Workflow's symbol and
 * nothing else. The other four are refused before payment rather than sent a
 * guessed body: `research` and `execution` need the previous Node's output,
 * `risk` additionally needs `balance_usdt` through the `ExchangeBalance` port,
 * and `notify` needs the account's Telegram chat id.
 */

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
  /** `accounts.telegram_chat_id`, for the terminal `notify` filter. */
  telegramChatId?: string | null
  runId?: string
}

export type NodeInputResult =
  | { ok: true; input: unknown }
  | { ok: false; reason: string }

export function buildNodeInput(context: NodeInputContext): NodeInputResult {
  switch (context.nodeType) {
    case 'data':
      return { ok: true, input: { symbol: context.symbol } }
    case 'research':
    case 'risk':
    case 'execution':
    case 'notify':
      return {
        ok: false,
        reason: `the engine does not build an input for a ${context.nodeType} Node yet`,
      }
  }
}
