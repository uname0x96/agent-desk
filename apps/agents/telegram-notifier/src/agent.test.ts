import { afterEach, describe, expect, it } from 'vitest'
import { createAgent, type Agent } from '@agent-desk/agent-kit'
import {
  buildPaymentSignatureHeader,
  requestPaid,
  requestUnpaid,
  StubFacilitator,
} from '@agent-desk/agent-kit/testing'
import { getDeployment, X402_HEADERS, type NotifyInput } from '@agent-desk/schemas'
import { createNotifyHandler } from './handler.ts'
import { createBotTelegram, createNotifierBot } from './telegram.ts'
import { DEFAULT_MESSAGE_ID, startMockBotApi, type MockBotApi } from './mock-bot-api.ts'

/**
 * The Telegram Notifier end to end against a stub facilitator and a local Bot
 * API server. The chain half is `packages/agent-kit/scripts/paid-request.ts`;
 * the Telegram half against api.telegram.org cannot run until someone creates
 * the bot and fills in `TELEGRAM_BOT_TOKEN`.
 */

const PAY_TO = '0x3333333333333333333333333333333333333333'
const TOKEN = '7000000001:AAH-fake-token-for-tests'
const EXPLORER = 'https://testnet.bscscan.com'
const TX = `0x${'ab'.repeat(32)}`

const INPUT: NotifyInput = {
  run_id: 'run_01JAGENTDESK000000000001',
  recipient: { channel: 'telegram', address: '123456789' },
  summary: 'LONG BNBUSDT, reduced to 60 USDT, filled at 612.55',
  cost_table: [{ node: 'research', provider: 'Alpha Research', amount: '0.05', tx_hash: TX }],
  tx_hashes: [TX],
  order: {
    status: 'FILLED',
    order_id: '123456789',
    filled_price: '612.55',
    filled_qty: '0.0979',
    ts: '2026-09-05T02:00:07Z',
  },
}

const running: { agent: Agent<'notify'>; api: MockBotApi }[] = []

async function start(facilitator = new StubFacilitator()) {
  const api = await startMockBotApi()
  const bot = createNotifierBot({ token: TOKEN, apiRoot: api.apiRoot })
  await bot.init()
  const agent = createAgent({
    type: 'notify',
    price: '0.005',
    payTo: PAY_TO,
    facilitatorUrl: 'http://facilitator.test:4020',
    internalToken: 'test-internal-token',
    facilitatorClient: facilitator,
    logger: { info() {}, warn() {}, error() {} } as never,
    handler: createNotifyHandler({
      telegram: createBotTelegram(bot),
      explorerUrl: EXPLORER,
    }),
  })
  running.push({ agent, api })
  const { port } = await agent.listen(0)
  return { agent, api, facilitator, baseUrl: `http://127.0.0.1:${port}` }
}

afterEach(async () => {
  while (running.length > 0) {
    const started = running.pop()
    if (!started) continue
    await started.agent.close()
    await started.api.close()
  }
})

describe('agent-telegram-notifier', () => {
  it('answers 402 at AGENT_PRICE=0.005 with the AD-6 binding', async () => {
    const { baseUrl } = await start()
    const unpaid = await requestUnpaid(baseUrl, INPUT)

    expect(unpaid.status).toBe(402)
    expect(unpaid.paymentRequired.accepts).toEqual([
      {
        scheme: 'exact',
        network: 'eip155:97',
        asset: getDeployment(97).tusd.address.toLowerCase(),
        amount: '5000',
        payTo: PAY_TO,
        maxTimeoutSeconds: 15,
        extra: { name: 'tUSD', version: '1' },
      },
    ])
  })

  it('posts one formatted message and answers delivered with the message id', async () => {
    const { baseUrl, api, facilitator } = await start()
    const unpaid = await requestUnpaid(baseUrl, INPUT)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const startedAt = Date.now()
    const paid = await requestPaid(baseUrl, INPUT, signature)
    const elapsed = Date.now() - startedAt

    expect(paid.status).toBe(200)
    expect(paid.body).toEqual({
      delivered: true,
      channel: 'telegram',
      message_ref: String(DEFAULT_MESSAGE_ID),
    })
    expect(paid.headers.get(X402_HEADERS.response)).toBeTruthy()
    expect(facilitator.settleCalls).toBe(1)
    // "the message arrives within ten seconds of the request"; the kit's
    // budget is the ceiling, this is the measurement.
    expect(elapsed).toBeLessThan(10_000)

    const sent = api.callsTo('sendMessage')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.payload.chat_id).toBe('123456789')
    const text = String(sent[0]?.payload.text)
    expect(text).toContain('LONG BNBUSDT, reduced to 60 USDT, filled at 612.55')
    expect(text).toContain('• research · Alpha Research · 0.05 tUSD')
    expect(text).toContain(`<a href="${EXPLORER}/tx/${TX}">`)
    expect(text).toContain('<b>Order</b> FILLED')
    expect(text).toContain('order_id 123456789')
    expect(text).toContain('filled_price 612.55')
    expect(text).toContain('filled_qty 0.0979')
  })

  it('answers 500 and never settles when the Bot API refuses the chat id', async () => {
    const { baseUrl, api, facilitator } = await start()
    api.on('sendMessage', () => ({
      ok: false,
      error_code: 400,
      description: 'Bad Request: chat not found',
    }))
    const unpaid = await requestUnpaid(baseUrl, INPUT)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(baseUrl, INPUT, signature)

    expect(paid.status).toBe(500)
    expect(paid.body).toMatchObject({ error: { code: 'internal_error' } })
    expect((paid.body as { error: { message: string } }).error.message).toContain(
      'chat not found',
    )
    expect(facilitator.settleCalls).toBe(0)
  })

  it('answers 500 and never settles when the bot is blocked by the user', async () => {
    const { baseUrl, api, facilitator } = await start()
    api.on('sendMessage', () => ({
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    }))
    const unpaid = await requestUnpaid(baseUrl, INPUT)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(baseUrl, INPUT, signature)

    expect(paid.status).toBe(500)
    expect(facilitator.settleCalls).toBe(0)
  })

  it('answers 400 for a channel other than telegram', async () => {
    const { baseUrl, api, facilitator } = await start()
    const unpaid = await requestUnpaid(baseUrl, INPUT)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(
      baseUrl,
      { ...INPUT, recipient: { channel: 'email', address: 'builder@example.com' } },
      signature,
    )

    expect(paid.status).toBe(400)
    expect(paid.body).toMatchObject({ error: { code: 'validation_failed' } })
    expect(api.callsTo('sendMessage')).toHaveLength(0)
    expect(facilitator.settleCalls).toBe(0)
  })

  it('delivers the verification sample, which has no run id and empty tables', async () => {
    const { baseUrl, api } = await start()
    const verification = {
      run_id: null,
      recipient: { channel: 'telegram', address: '000000000' },
      summary: 'AgentDesk listing verification call.',
      cost_table: [],
      tx_hashes: [],
    }
    const unpaid = await requestUnpaid(baseUrl, verification)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const paid = await requestPaid(baseUrl, verification, signature)

    expect(paid.status).toBe(200)
    expect(String(api.callsTo('sendMessage')[0]?.payload.text)).toBe(
      ['<b>AgentDesk</b>', '', 'AgentDesk listing verification call.'].join('\n'),
    )
  })

  it('sends one message per payment, however often the signature arrives', async () => {
    const { baseUrl, api, facilitator } = await start()
    const unpaid = await requestUnpaid(baseUrl, INPUT)
    const signature = buildPaymentSignatureHeader(unpaid.paymentRequired.accepts[0]!)

    const first = await requestPaid(baseUrl, INPUT, signature)
    const replay = await requestPaid(baseUrl, INPUT, signature)

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(first.body)
    expect(api.callsTo('sendMessage')).toHaveLength(1)
    expect(facilitator.settleCalls).toBe(2)
  })

  it('answers /health and /schema', async () => {
    const { baseUrl } = await start()
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200)
    const schema = await (await fetch(`${baseUrl}/schema`)).json()
    expect(schema).toMatchObject({ type: 'notify', payment: { amount: '5000' } })
  })
})
