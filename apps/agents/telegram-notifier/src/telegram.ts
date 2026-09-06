import { Bot, GrammyError, HttpError } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import type { Logger } from '@agent-desk/schemas/logger'
import { escapeHtml } from './message.ts'

/**
 * The Bot API, behind one narrow port. AD-1 keeps the vendor SDK inside the
 * agent that needs it, and this is the only file in the agent's runtime that
 * touches grammY: the handler is testable against a fake `sendMessage`, and
 * the real grammY call path is testable against a local Bot API server.
 *
 * AD-12: updates reach this agent by long polling only. `bot.start()` is the
 * only entry point here and it clears any webhook during setup; nothing in
 * this agent ever calls `setWebhook`.
 */

/** AD-7: handlers keep external timeouts at or below 8 s. */
export const TELEGRAM_TIMEOUT_MS = 8_000

/**
 * grammY's Node build types every `AbortSignal` parameter against the
 * `abort-controller` polyfill, which is structurally incompatible with the
 * platform `AbortSignal` even though Node accepts one at runtime — the
 * deadline test in `telegram.test.ts` proves it does, against a real HTTP
 * request. This is that cast, once, with a name that says what it is.
 */
type GrammySignal = Parameters<Bot['api']['sendMessage']>[3]

export function asGrammySignal(signal: AbortSignal): GrammySignal {
  return signal as unknown as GrammySignal
}

export interface SentMessage {
  /** Telegram's own message id; becomes `message_ref` in the notify output. */
  message_id: number
}

export interface TelegramPort {
  sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<SentMessage>
}

/**
 * Anything that stops the message reaching the chat: a Bot API error, a chat
 * id the bot cannot message, an unreachable host, an expired deadline. Every
 * one of them is a 500 from `createAgent`, so the Call is never settled.
 */
export class TelegramDeliveryError extends Error {
  /** Telegram's `error_code` when the Bot API answered; undefined otherwise. */
  readonly errorCode: number | undefined

  constructor(message: string, errorCode?: number) {
    super(message)
    this.name = 'TelegramDeliveryError'
    this.errorCode = errorCode
  }
}

export interface BotTelegramOptions {
  timeoutMs?: number
}

/** Wraps a grammY `Bot` as the port the handler calls. */
export function createBotTelegram(bot: Bot, options: BotTelegramOptions = {}): TelegramPort {
  const timeoutMs = options.timeoutMs ?? TELEGRAM_TIMEOUT_MS
  return {
    async sendMessage(chatId, text, signal) {
      const deadline = AbortSignal.timeout(timeoutMs)
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
      try {
        const message = await bot.api.sendMessage(
          chatId,
          text,
          // The explorer links must not drag a bscscan preview card into the
          // chat behind the summary.
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
          asGrammySignal(combined),
        )
        return { message_id: message.message_id }
      } catch (error) {
        if (deadline.aborted) {
          throw new TelegramDeliveryError(`telegram timed out after ${timeoutMs} ms`)
        }
        // The handler budget expired, not Telegram: let the kit report that.
        if (signal?.aborted) throw error
        if (error instanceof GrammyError) {
          throw new TelegramDeliveryError(
            `telegram refused the message for chat ${chatId}: ${error.error_code} ${error.description}`,
            error.error_code,
          )
        }
        if (error instanceof HttpError) {
          throw new TelegramDeliveryError(`telegram is unreachable: ${error.message}`)
        }
        const reason = error instanceof Error ? error.message : String(error)
        throw new TelegramDeliveryError(`telegram send failed: ${reason}`)
      }
    },
  }
}

/**
 * FR-32 / addendum §7: one shared bot. The Builder starts it, the bot answers
 * with the chat id, the Builder pastes that into settings. `<code>` renders as
 * a tap-to-copy block in every Telegram client, which is the whole point of
 * this reply.
 */
export function renderStartReply(chatId: number | string): string {
  return [
    '<b>AgentDesk notifier</b> is connected to this chat.',
    '',
    'Your Telegram chat id is:',
    `<code>${escapeHtml(String(chatId))}</code>`,
    '',
    'Paste it into AgentDesk under Settings → Telegram chat id, and every Run summary will arrive here.',
  ].join('\n')
}

export interface NotifierBotOptions {
  token: string
  logger?: Logger
  /** Skips the `getMe` call at init; the tests pass it, production does not. */
  botInfo?: UserFromGetMe
  /** Bot API root. The tests point it at a local server; production omits it. */
  apiRoot?: string
}

/** A `Bot` with the `/start` command wired up. Nothing here starts polling. */
export function createNotifierBot(options: NotifierBotOptions): Bot {
  const config: ConstructorParameters<typeof Bot>[1] = {}
  if (options.botInfo !== undefined) config.botInfo = options.botInfo
  if (options.apiRoot !== undefined) config.client = { apiRoot: options.apiRoot }
  const bot = new Bot(options.token, config)

  bot.command('start', async (ctx) => {
    const chatId = ctx.chat.id
    options.logger?.info({ chat_id: chatId }, 'answering /start with the chat id')
    await ctx.reply(renderStartReply(chatId), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
  })

  bot.catch((error) => {
    options.logger?.error({ reason: error.message }, 'telegram update handler failed')
  })

  return bot
}

/**
 * AD-12: long polling, never a webhook. `init()` runs first so an invalid
 * `TELEGRAM_BOT_TOKEN` fails at boot rather than at the first `/start`; the
 * polling loop itself is left running in the background.
 */
export async function startPolling(bot: Bot, logger?: Logger): Promise<void> {
  await bot.init()
  bot
    .start({
      // A restart must not replay yesterday's /start commands.
      drop_pending_updates: true,
      allowed_updates: ['message'],
      onStart: (botInfo) => {
        logger?.info({ bot: botInfo.username }, 'telegram long polling started')
      },
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      logger?.error({ reason }, 'telegram long polling stopped')
    })
}
