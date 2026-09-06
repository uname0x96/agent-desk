import type { AgentHandler } from '@agent-desk/agent-kit'
import type { NotifyOutput } from '@agent-desk/schemas'
import { renderNotification } from './message.ts'
import type { TelegramPort } from './telegram.ts'

/**
 * FR-32: one paid request, one Telegram message, one `message_ref`.
 *
 * There is no channel check here on purpose. `notifyInput.recipient.channel`
 * is `z.literal('telegram')`, so `createAgent` rejects any other channel with
 * 400 `validation_failed` before the handler runs; a second check would be
 * unreachable code claiming to do the work the schema already does.
 *
 * Every failure below — a Bot API error, a chat id the bot cannot message, an
 * expired deadline — throws, and `createAgent` turns a throw into a 500. The
 * x402 middleware settles only a response under 400, so a failed delivery is
 * never paid for.
 */

export interface NotifyHandlerOptions {
  telegram: TelegramPort
  /** This agent's `EXPLORER_URL`; the tx links are built from it. */
  explorerUrl?: string
}

export function createNotifyHandler(options: NotifyHandlerOptions): AgentHandler<'notify'> {
  return async (input, context): Promise<NotifyOutput> => {
    const text = renderNotification(input, { explorerUrl: options.explorerUrl })
    const sent = await options.telegram.sendMessage(
      input.recipient.address,
      text,
      context.signal,
    )
    context.logger.info(
      { run_id: input.run_id, chat_id: input.recipient.address, message_ref: sent.message_id },
      'telegram message delivered',
    )
    return { delivered: true, channel: 'telegram', message_ref: String(sent.message_id) }
  }
}
