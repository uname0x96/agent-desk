import { describe, expect, it } from 'vitest'
import type { CallStatus, NotifyInput } from '@agent-desk/schemas'
import { buildNotifyInput, summarize, type NotifyCallRecord, type NotifyContext } from './notify.ts'
import { REFUSALS } from './inputs.ts'

/**
 * The terminal filter's input, which is the only thing the Builder actually
 * reads when a Run ends. Three rules are load-bearing and each has its own
 * assertions below: only paid Calls appear in the cost table, `order` is
 * present only on a successful Run, and a Run whose `execution` Node did not
 * fill ends its summary with "no order".
 */

const CHAT = '123456789'
const HASH_A = `0x${'a1'.repeat(32)}`
const HASH_B = `0x${'b2'.repeat(32)}`

const MARKET = {
  symbol: 'BNBUSDT',
  price: '612.40',
  change_24h_pct: -1.8,
  volatility_24h_pct: 3.2,
  ts: '2026-09-06T02:00:00Z',
}

const FILLED = {
  status: 'FILLED',
  order_id: '123456789',
  filled_price: '612.55',
  filled_qty: '0.0979',
  ts: '2026-09-06T02:00:07Z',
}

function call(
  nodeIndex: number,
  nodeType: NotifyCallRecord['nodeType'],
  overrides: Partial<NotifyCallRecord> = {},
): NotifyCallRecord {
  return {
    nodeIndex,
    nodeType,
    provider: `Provider ${nodeType}`,
    lockedPrice: '10000',
    status: 'succeeded' as CallStatus,
    paymentTxHash: null,
    skipReason: null,
    response: null,
    ...overrides,
  }
}

/** The good chain of PRD addendum §2, all five Nodes paid and filled. */
function fullChain(overrides: Partial<NotifyContext> = {}): NotifyContext {
  return {
    runId: 'run_01JABCDEF',
    symbol: 'BNBUSDT',
    telegramChatId: CHAT,
    outcome: { kind: 'success' },
    calls: [
      call(0, 'data', { provider: 'Binance Ticker', lockedPrice: '10000', response: MARKET, paymentTxHash: HASH_A }),
      call(1, 'research', {
        provider: 'Alpha Research',
        lockedPrice: '50000',
        response: { signal: 'LONG', confidence: 0.72, reason: 'Reclaimed the midpoint.' },
        paymentTxHash: HASH_B,
      }),
      call(2, 'risk', {
        provider: 'Guardrail Risk',
        lockedPrice: '20000',
        response: { decision: 'REDUCE', size_usdt: '60', reason: 'volatility above 3%' },
      }),
      call(3, 'execution', {
        provider: 'Binance Spot Executor',
        lockedPrice: '10000',
        response: FILLED,
      }),
      call(4, 'notify', { provider: 'Telegram Notifier', lockedPrice: '5000', status: 'pending' }),
    ],
    ...overrides,
  }
}

/** The same chain stopped by the Order Cap guard: nothing was ordered. */
function failedAtExecution(overrides: Partial<NotifyContext> = {}): NotifyContext {
  return fullChain({
    outcome: { kind: 'failed', node: 'execution', reason: 'order cap exceeded' },
    calls: fullChain().calls.map((entry) =>
      entry.nodeType === 'execution'
        ? call(3, 'execution', {
            provider: 'Binance Spot Executor',
            status: 'payment_failed',
            response: null,
          })
        : entry,
    ),
    ...overrides,
  })
}

function input(context: NotifyContext): NotifyInput {
  const result = buildNotifyInput(context)
  if (!result.ok) throw new Error(`expected an input, got a refusal: ${result.reason}`)
  return result.input
}

describe('the recipient', () => {
  it('is the account chat id on the telegram channel', () => {
    expect(input(fullChain()).recipient).toEqual({ channel: 'telegram', address: CHAT })
  })

  it('refuses before payment when the account has no chat id linked', () => {
    for (const chatId of [null, undefined, '', '  ']) {
      const result = buildNotifyInput(fullChain({ telegramChatId: chatId }))
      expect(result).toEqual({ ok: false, reason: REFUSALS.noTelegramChatId })
    }
  })
})

describe('the cost table', () => {
  it('lists the paid Calls in node order with decimal amounts and known hashes', () => {
    expect(input(fullChain()).cost_table).toEqual([
      { node: 'data', provider: 'Binance Ticker', amount: '0.01', tx_hash: HASH_A },
      { node: 'research', provider: 'Alpha Research', amount: '0.05', tx_hash: HASH_B },
      { node: 'risk', provider: 'Guardrail Risk', amount: '0.02' },
      { node: 'execution', provider: 'Binance Spot Executor', amount: '0.01' },
    ])
  })

  it('never lists the notify Call itself; its own hash cannot be known yet', () => {
    expect(input(fullChain()).cost_table.some((entry) => entry.node === 'notify')).toBe(false)
  })

  it('lists tx_hashes only for hashes that are known', () => {
    expect(input(fullChain()).tx_hashes).toEqual([HASH_A, HASH_B])
  })

  it('omits skipped and refused Calls, and keeps every Call that was paid', () => {
    const context = fullChain({
      outcome: { kind: 'failed', node: 'execution', reason: 'order cap exceeded' },
      calls: [
        call(0, 'data', { provider: 'Binance Ticker', paymentTxHash: HASH_A }),
        call(1, 'research', { provider: 'Sloppy Research', lockedPrice: '30000', paymentTxHash: HASH_B }),
        call(2, 'risk', { provider: 'Guardrail Risk', lockedPrice: '20000', status: 'failed_after_payment' }),
        call(3, 'execution', { provider: 'Binance Spot Executor', status: 'payment_failed' }),
        call(4, 'notify', { provider: 'Telegram Notifier', lockedPrice: '5000', status: 'pending' }),
      ],
    })
    expect(input(context).cost_table.map((entry) => entry.node)).toEqual([
      'data',
      'research',
      'risk',
    ])
  })

  it('is empty on a Run that failed at its first Node', () => {
    const context = fullChain({
      outcome: { kind: 'failed', node: 'data', reason: 'the unpaid request timed out after 15 s' },
      calls: [
        call(0, 'data', { status: 'payment_failed' }),
        call(1, 'notify', { status: 'pending' }),
      ],
    })
    expect(input(context).cost_table).toEqual([])
    expect(input(context).tx_hashes).toEqual([])
  })
})

describe('the order block', () => {
  it('carries the execution output on a successful Run', () => {
    expect(input(fullChain()).order).toEqual(FILLED)
  })

  it('is absent on a Run that failed before the order (FR-29)', () => {
    const context = failedAtExecution()
    expect(input(context).order).toBeUndefined()
  })

  it('is absent when the execution Node was skipped', () => {
    const context = fullChain({
      calls: fullChain().calls.map((entry) =>
        entry.nodeType === 'execution'
          ? call(3, 'execution', { status: 'skipped', skipReason: 'reject', response: null })
          : entry,
      ),
    })
    expect(input(context).order).toBeUndefined()
  })
})

describe('the summary', () => {
  it('reads like the PRD addendum example on a filled Run', () => {
    expect(summarize(fullChain())).toBe('LONG BNBUSDT, reduced to 60 USDT, filled at 612.55')
  })

  it('names the size on an APPROVE', () => {
    const context = fullChain({
      calls: fullChain().calls.map((entry) =>
        entry.nodeType === 'risk'
          ? call(2, 'risk', { response: { decision: 'APPROVE', size_usdt: '10', reason: 'within limits' } })
          : entry,
      ),
    })
    expect(summarize(context)).toBe('LONG BNBUSDT, approved at 10 USDT, filled at 612.55')
  })

  it('ends with "no order" when risk rejected and execution was skipped', () => {
    const context = fullChain({
      calls: fullChain().calls.map((entry) => {
        if (entry.nodeType === 'risk') {
          return call(2, 'risk', {
            response: { decision: 'REJECT', size_usdt: '0', reason: 'confident counter-trend signal' },
          })
        }
        if (entry.nodeType === 'execution') {
          return call(3, 'execution', { status: 'skipped', skipReason: 'reject', response: null })
        }
        return entry
      }),
    })
    expect(summarize(context)).toBe(
      'LONG BNBUSDT, rejected by risk: confident counter-trend signal, no order',
    )
    expect(summarize(context).endsWith('no order')).toBe(true)
  })

  it('ends with "no order" on a HOLD, where risk and execution were both skipped', () => {
    const context = fullChain({
      calls: [
        call(0, 'data', { response: MARKET }),
        call(1, 'research', { response: { signal: 'HOLD', confidence: 0.5, reason: 'flat' } }),
        call(2, 'risk', { status: 'skipped', skipReason: 'hold', response: null }),
        call(3, 'execution', { status: 'skipped', skipReason: 'hold', response: null }),
        call(4, 'notify', { status: 'pending' }),
      ],
    })
    expect(summarize(context)).toBe('HOLD BNBUSDT, no order')
  })

  it('carries the executor refusal reason and ends with "no order"', () => {
    const context = fullChain({
      calls: fullChain().calls.map((entry) =>
        entry.nodeType === 'execution'
          ? call(3, 'execution', {
              response: { status: 'REJECTED', reason: 'emergency stop', ts: '2026-09-06T02:00:07Z' },
            })
          : entry,
      ),
    })
    expect(summarize(context)).toBe(
      'LONG BNBUSDT, reduced to 60 USDT, order rejected: emergency stop, no order',
    )
  })

  it('names the failed Node and its reason (FR-29)', () => {
    expect(summarize(failedAtExecution())).toBe(
      'BNBUSDT failed at execution, order cap exceeded, no order',
    )
  })

  it('says so when the Run timed out', () => {
    const context = failedAtExecution({
      outcome: { kind: 'timed_out', reason: 'the Run exceeded its 120 s budget' },
    })
    expect(summarize(context)).toBe(
      'BNBUSDT timed out, the Run exceeded its 120 s budget, no order',
    )
  })

  it('says nothing about an order when the Workflow has no execution Node', () => {
    const context = fullChain({
      calls: [
        call(0, 'data', { response: MARKET }),
        call(1, 'research', { response: { signal: 'LONG', confidence: 0.72, reason: 'up' } }),
        call(2, 'notify', { status: 'pending' }),
      ],
    })
    expect(summarize(context)).toBe('LONG BNBUSDT')
  })

  it('falls back to the market price when there is only a data Node', () => {
    const context = fullChain({
      calls: [call(0, 'data', { response: MARKET }), call(1, 'notify', { status: 'pending' })],
    })
    expect(summarize(context)).toBe('BNBUSDT at 612.40')
  })

  it('is always something the notify input schema accepts', () => {
    const long = 'x'.repeat(4000)
    const context = fullChain({ outcome: { kind: 'failed', node: 'risk', reason: long } })
    const result = buildNotifyInput(context)
    expect(result.ok).toBe(true)
    expect(summarize(context).length).toBeLessThan(400)
  })
})

describe('the run id', () => {
  it('is the id of the Run the message summarises', () => {
    expect(input(fullChain()).run_id).toBe('run_01JABCDEF')
  })
})
