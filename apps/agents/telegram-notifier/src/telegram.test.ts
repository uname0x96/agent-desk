import { afterEach, describe, expect, it } from 'vitest'
import type { Bot } from 'grammy'
import type { Update } from 'grammy/types'
import {
  createBotTelegram,
  createNotifierBot,
  renderStartReply,
  startPolling,
  TelegramDeliveryError,
} from './telegram.ts'
import { DEFAULT_MESSAGE_ID, startMockBotApi, type MockBotApi } from './mock-bot-api.ts'

/**
 * The grammY half, driven against a local Bot API server. Nothing here reaches
 * api.telegram.org: `TELEGRAM_BOT_TOKEN` is empty on this laptop and no bot has
 * been created yet, so the live path is unproven and these tests stand in for
 * it. What they do cover is the real grammY client: the JSON it posts, the
 * errors it raises, and the long-polling loop.
 */

const TOKEN = '7000000001:AAH-fake-token-for-tests'
const CHAT_ID = '123456789'

const open: { bot: Bot; api: MockBotApi | null }[] = []

async function boot(): Promise<{ bot: Bot; api: MockBotApi }> {
  const api = await startMockBotApi()
  const bot = createNotifierBot({ token: TOKEN, apiRoot: api.apiRoot })
  await bot.init()
  open.push({ bot, api })
  return { bot, api }
}

function startUpdate(chatId: number, updateId = 1): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      date: 1_788_674_230,
      chat: { id: chatId, type: 'private', first_name: 'Builder' },
      from: { id: chatId, is_bot: false, first_name: 'Builder' },
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the bot')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(async () => {
  while (open.length > 0) {
    const started = open.pop()
    if (!started) continue
    await started.bot.stop()
    await started.api?.close()
  }
})

describe('createBotTelegram', () => {
  it('posts one HTML message with previews off and returns the message id', async () => {
    const { bot, api } = await boot()

    const sent = await createBotTelegram(bot).sendMessage(CHAT_ID, '<b>hello</b>')

    expect(sent).toEqual({ message_id: DEFAULT_MESSAGE_ID })
    expect(api.callsTo('sendMessage')).toHaveLength(1)
    expect(api.callsTo('sendMessage')[0]?.payload).toEqual({
      chat_id: CHAT_ID,
      text: '<b>hello</b>',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
  })

  it('turns a chat id the bot cannot message into a delivery error', async () => {
    const { bot, api } = await boot()
    api.on('sendMessage', () => ({
      ok: false,
      error_code: 400,
      description: 'Bad Request: chat not found',
    }))

    await expect(createBotTelegram(bot).sendMessage('999', 'hi')).rejects.toThrow(
      'telegram refused the message for chat 999: 400 Bad Request: chat not found',
    )
  })

  it('turns a blocked bot into a delivery error carrying the Bot API code', async () => {
    const { bot, api } = await boot()
    api.on('sendMessage', () => ({
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    }))

    const error = await createBotTelegram(bot)
      .sendMessage(CHAT_ID, 'hi')
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TelegramDeliveryError)
    expect((error as TelegramDeliveryError).errorCode).toBe(403)
  })

  it('turns an unreachable Bot API into a delivery error', async () => {
    const { bot, api } = await boot()
    // Close the server out from under the client, keeping the same apiRoot.
    await api.close()

    await expect(createBotTelegram(bot).sendMessage(CHAT_ID, 'hi')).rejects.toMatchObject({
      name: 'TelegramDeliveryError',
      message: expect.stringContaining('telegram is unreachable'),
    })
  })

  it('gives up on its own deadline rather than burning the handler budget', async () => {
    const { bot, api } = await boot()
    // Never settles; the mock destroys the connection when the server closes.
    api.on('sendMessage', () => new Promise(() => {}))

    // The same AD-7 rule as production, shortened so the test does not wait.
    await expect(
      createBotTelegram(bot, { timeoutMs: 60 }).sendMessage(CHAT_ID, 'hi'),
    ).rejects.toThrow('telegram timed out after 60 ms')
  })

  it('rethrows a handler budget abort instead of blaming Telegram', async () => {
    const { bot, api } = await boot()
    api.on('sendMessage', () => new Promise(() => {}))

    const error = await createBotTelegram(bot)
      .sendMessage(CHAT_ID, 'hi', AbortSignal.abort())
      .catch((caught: unknown) => caught)

    expect(error).not.toBeInstanceOf(TelegramDeliveryError)
  })
})

describe('the /start affordance', () => {
  it('puts the chat id in a copy-pasteable block', () => {
    const reply = renderStartReply(123456789)
    expect(reply).toContain('<code>123456789</code>')
    expect(reply).toContain('Settings')
  })

  it('answers a /start update with that chat id', async () => {
    const { bot, api } = await boot()

    await bot.handleUpdate(startUpdate(123456789))

    const reply = api.callsTo('sendMessage')[0]?.payload
    expect(reply).toMatchObject({ chat_id: 123456789, parse_mode: 'HTML' })
    expect(String(reply?.text)).toContain('<code>123456789</code>')
  })
})

describe('startPolling', () => {
  it('long-polls for the /start update and never sets a webhook (AD-12)', async () => {
    const api = await startMockBotApi()
    let delivered = false
    api.on('getUpdates', async () => {
      if (delivered) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { ok: true, result: [] }
      }
      delivered = true
      return { ok: true, result: [startUpdate(987654321, 42)] }
    })
    const bot = createNotifierBot({ token: TOKEN, apiRoot: api.apiRoot })
    open.push({ bot, api })

    await startPolling(bot)
    await waitFor(() => api.callsTo('sendMessage').length > 0)

    expect(String(api.callsTo('sendMessage')[0]?.payload.text)).toContain(
      '<code>987654321</code>',
    )
    expect(api.callsTo('getUpdates').length).toBeGreaterThan(0)
    // grammY clears a stale webhook during setup; it must never set one.
    expect(api.callsTo('deleteWebhook')).toHaveLength(1)
    expect(api.callsTo('setWebhook')).toHaveLength(0)
  })
})
