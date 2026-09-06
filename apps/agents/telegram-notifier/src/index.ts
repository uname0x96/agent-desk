import { createAgent } from '@agent-desk/agent-kit'
import { createLogger } from '@agent-desk/schemas/logger'
import { loadNotifierEnv } from './env.ts'
import { createNotifyHandler } from './handler.ts'
import { asGrammySignal, createBotTelegram, createNotifierBot, startPolling } from './telegram.ts'

/**
 * Story 2.6 / FR-32 / FR-44: the Telegram Notifier seed agent. Compose runs it
 * on :4106 with AGENT_PRICE=0.005; the 402, the validation, the budget and the
 * replay cache all belong to `createAgent` (AD-7).
 */

/**
 * `bot.init()` retries a network failure forever, so boot gives it a deadline
 * and exits instead of hanging without a `/health`. Compose restarts the
 * service, which is the retry.
 */
const BOOT_INIT_TIMEOUT_MS = 15_000

const env = loadNotifierEnv()
const logger = createLogger('agent-telegram-notifier')

const bot = createNotifierBot({ token: env.TELEGRAM_BOT_TOKEN, logger })

// An agent whose only job is the Bot API is useless with a token the Bot API
// refuses, so the token is proven here rather than at the first paid request —
// a request that would otherwise answer 500 and leave a Call unsettled.
try {
  await bot.init(asGrammySignal(AbortSignal.timeout(BOOT_INIT_TIMEOUT_MS)))
  logger.info({ bot: bot.botInfo.username }, 'telegram bot token accepted')
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error)
  logger.error({ reason }, 'the Bot API refused TELEGRAM_BOT_TOKEN')
  process.exit(1)
}

const agent = createAgent({
  type: 'notify',
  price: env.AGENT_PRICE,
  payTo: env.AGENT_PAYTO,
  facilitatorUrl: env.FACILITATOR_URL,
  internalToken: env.INTERNAL_TOKEN,
  chainId: env.CHAIN_ID,
  serviceName: 'agent-telegram-notifier',
  logger,
  handler: createNotifyHandler({
    telegram: createBotTelegram(bot),
    explorerUrl: env.EXPLORER_URL,
  }),
})

const { server } = await agent.listen(env.AGENT_PORT)

// AD-12: long polling, never a webhook. Off by default; compose sets it.
if (env.AGENT_TELEGRAM_POLL) await startPolling(bot, logger)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down')
    void bot.stop().finally(() => server.close(() => process.exit(0)))
  })
}
