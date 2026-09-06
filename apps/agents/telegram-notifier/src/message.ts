import type { NotifyInput } from '@agent-desk/schemas'
import { explorerLink } from './explorer.ts'

/**
 * FR-32: the one message the notifier posts. It carries `summary`, one line
 * per `cost_table` entry, every `tx_hashes` entry as an explorer link, and the
 * order block when `order` is present.
 *
 * Rendered as Telegram HTML rather than MarkdownV2: HTML needs three
 * characters escaped instead of eighteen, so a summary written by an LLM is
 * far less likely to make the Bot API answer 400 — and a 400 here is a 500
 * that leaves the Call unsettled.
 */

/** Telegram refuses a `sendMessage` longer than this. */
export const TELEGRAM_MESSAGE_LIMIT = 4096

/**
 * `summary` is the only unbounded field in the input schema, so it is the only
 * one that can push the message past the limit on its own.
 */
export const SUMMARY_LIMIT = 1000

export interface RenderOptions {
  /** Explorer base for the tx links; this agent's `EXPLORER_URL`. */
  explorerUrl?: string
}

/** The three characters Telegram's HTML mode reserves. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/** `0x1234abcd…9876fedc` — the full hash stays in the link target. */
export function shortHash(hash: string): string {
  return hash.length <= 20 ? hash : `${hash.slice(0, 10)}…${hash.slice(-8)}`
}

function txLink(hash: string, explorerUrl?: string): string {
  const href = explorerLink('tx', hash, explorerUrl)
  return `<a href="${href}">${escapeHtml(shortHash(hash))}</a>`
}

/**
 * Drops whole lines from the end until the message fits. Cutting mid-string
 * could split an HTML tag and make the Bot API refuse the whole message, so
 * the unit of truncation is a line. With five Nodes this never triggers; it
 * exists so an oversized input cannot turn into a 400.
 */
function fitToLimit(lines: string[]): string {
  const kept = [...lines]
  while (kept.length > 1 && kept.join('\n').length > TELEGRAM_MESSAGE_LIMIT) {
    kept.pop()
  }
  const text = kept.join('\n')
  return text.length > TELEGRAM_MESSAGE_LIMIT ? text.slice(0, TELEGRAM_MESSAGE_LIMIT) : text
}

export function renderNotification(input: NotifyInput, options: RenderOptions = {}): string {
  const { explorerUrl } = options
  const lines: string[] = []

  // The verification Call sends `run_id: null` (AD-14), so the header carries
  // the run id only when there is one.
  lines.push(
    input.run_id === null
      ? '<b>AgentDesk</b>'
      : `<b>AgentDesk Run</b> <code>${escapeHtml(input.run_id)}</code>`,
  )
  lines.push('')
  lines.push(escapeHtml(truncate(input.summary, SUMMARY_LIMIT)))

  if (input.cost_table.length > 0) {
    lines.push('')
    lines.push('<b>Cost</b>')
    for (const entry of input.cost_table) {
      const parts = [
        escapeHtml(entry.node),
        escapeHtml(entry.provider),
        `${escapeHtml(entry.amount)} tUSD`,
      ]
      if (entry.tx_hash !== undefined) parts.push(txLink(entry.tx_hash, explorerUrl))
      lines.push(`• ${parts.join(' · ')}`)
    }
  }

  if (input.tx_hashes.length > 0) {
    lines.push('')
    lines.push('<b>Transactions</b>')
    for (const hash of input.tx_hashes) lines.push(`• ${txLink(hash, explorerUrl)}`)
  }

  const order = input.order
  if (order !== undefined) {
    lines.push('')
    lines.push(`<b>Order</b> ${escapeHtml(order.status)}`)
    if (order.status === 'FILLED') {
      // The notify input parses `order` by shape alone, so a caller can send a
      // FILLED order without the three fields. Render what is there.
      if (order.order_id !== undefined) lines.push(`order_id ${escapeHtml(order.order_id)}`)
      if (order.filled_price !== undefined)
        lines.push(`filled_price ${escapeHtml(order.filled_price)}`)
      if (order.filled_qty !== undefined)
        lines.push(`filled_qty ${escapeHtml(order.filled_qty)}`)
    } else if (order.reason !== undefined) {
      lines.push(escapeHtml(order.reason))
    }
  }

  return fitToLimit(lines)
}
