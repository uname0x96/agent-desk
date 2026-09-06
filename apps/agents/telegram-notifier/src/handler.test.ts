import { describe, expect, it, vi } from 'vitest'
import type { AgentHandlerContext } from '@agent-desk/agent-kit'
import type { NotifyInput } from '@agent-desk/schemas'
import { createNotifyHandler } from './handler.ts'
import { TelegramDeliveryError, type TelegramPort } from './telegram.ts'

const INPUT: NotifyInput = {
  run_id: 'run_01JAGENTDESK000000000001',
  recipient: { channel: 'telegram', address: '123456789' },
  summary: 'LONG BNBUSDT, reduced to 60 USDT, filled at 612.55',
  cost_table: [{ node: 'research', provider: 'Alpha Research', amount: '0.05' }],
  tx_hashes: [`0x${'ab'.repeat(32)}`],
}

function context(signal = new AbortController().signal): AgentHandlerContext {
  return {
    signal,
    logger: { info() {}, warn() {}, error() {} } as never,
    paymentSignature: 'stub-signature',
  }
}

describe('createNotifyHandler', () => {
  it('posts one message to recipient.address and answers with its id', async () => {
    const sendMessage = vi.fn<TelegramPort['sendMessage']>(async () => ({ message_id: 4521 }))
    const telegram: TelegramPort = { sendMessage }

    const output = await createNotifyHandler({ telegram, explorerUrl: 'https://x.test' })(
      INPUT,
      context(),
    )

    expect(output).toEqual({ delivered: true, channel: 'telegram', message_ref: '4521' })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]?.[0]).toBe('123456789')
    const text = String(sendMessage.mock.calls[0]?.[1])
    expect(text).toContain('LONG BNBUSDT, reduced to 60 USDT, filled at 612.55')
    expect(text).toContain('• research · Alpha Research · 0.05 tUSD')
    expect(text).toContain(`https://x.test/tx/0x${'ab'.repeat(32)}`)
  })

  it('passes the handler budget signal through to the transport', async () => {
    const sendMessage = vi.fn<TelegramPort['sendMessage']>(async () => ({ message_id: 1 }))
    const controller = new AbortController()

    await createNotifyHandler({ telegram: { sendMessage } })(INPUT, context(controller.signal))

    expect(sendMessage.mock.calls[0]?.[2]).toBe(controller.signal)
  })

  it('lets a delivery failure through so the kit answers 500 and never settles', async () => {
    const telegram: TelegramPort = {
      sendMessage: () =>
        Promise.reject(
          new TelegramDeliveryError('telegram refused the message for chat 999: 400 x', 400),
        ),
    }

    await expect(createNotifyHandler({ telegram })(INPUT, context())).rejects.toThrow(
      'telegram refused the message',
    )
  })
})
