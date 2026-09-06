import { describe, expect, it } from 'vitest'
import { samples, typeSchemas, type NotifyInput } from '@agent-desk/schemas'
import {
  escapeHtml,
  renderNotification,
  shortHash,
  SUMMARY_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
} from './message.ts'

/** A 32-byte hash with a distinguishable head and tail. */
function hash(head: string, tail: string): string {
  return `0x${head}${'0'.repeat(64 - head.length - tail.length)}${tail}`
}

const TX_DATA = hash('a1b2c3d4', 'deadbeef')
const TX_RESEARCH = hash('b0b0b0b0', 'cafebabe')
const TX_EXEC = hash('c0ffee11', 'facefeed')
const EXPLORER = 'https://testnet.bscscan.com'

const RUN: NotifyInput = {
  run_id: 'run_01JAGENTDESK000000000001',
  recipient: { channel: 'telegram', address: '123456789' },
  summary: 'LONG BNBUSDT, reduced to 60 USDT, filled at 612.55',
  cost_table: [
    { node: 'data', provider: 'Binance Ticker', amount: '0.01', tx_hash: TX_DATA },
    { node: 'research', provider: 'Alpha Research', amount: '0.05', tx_hash: TX_RESEARCH },
    // The settlement hash is not known yet; the schema omits it (AD-14).
    { node: 'risk', provider: 'Guardrail Risk', amount: '0.02' },
    {
      node: 'execution',
      provider: 'Binance Spot Executor',
      amount: '0.01',
      tx_hash: TX_EXEC,
    },
    { node: 'notify', provider: 'Telegram Notifier', amount: '0.005' },
  ],
  tx_hashes: [TX_DATA, TX_RESEARCH, TX_EXEC],
  order: {
    status: 'FILLED',
    order_id: '123456789',
    filled_price: '612.55',
    filled_qty: '0.0979',
    ts: '2026-09-05T02:00:07Z',
  },
}

function link(tx: string, short: string): string {
  return `<a href="${EXPLORER}/tx/${tx}">${short}</a>`
}

describe('renderNotification', () => {
  it('renders the summary, every cost line, every tx hash, and the order block', () => {
    expect(renderNotification(RUN, { explorerUrl: EXPLORER })).toBe(
      [
        '<b>AgentDesk Run</b> <code>run_01JAGENTDESK000000000001</code>',
        '',
        'LONG BNBUSDT, reduced to 60 USDT, filled at 612.55',
        '',
        '<b>Cost</b>',
        `• data · Binance Ticker · 0.01 tUSD · ${link(TX_DATA, '0xa1b2c3d4…deadbeef')}`,
        `• research · Alpha Research · 0.05 tUSD · ${link(TX_RESEARCH, '0xb0b0b0b0…cafebabe')}`,
        '• risk · Guardrail Risk · 0.02 tUSD',
        `• execution · Binance Spot Executor · 0.01 tUSD · ${link(TX_EXEC, '0xc0ffee11…facefeed')}`,
        '• notify · Telegram Notifier · 0.005 tUSD',
        '',
        '<b>Transactions</b>',
        `• ${link(TX_DATA, '0xa1b2c3d4…deadbeef')}`,
        `• ${link(TX_RESEARCH, '0xb0b0b0b0…cafebabe')}`,
        `• ${link(TX_EXEC, '0xc0ffee11…facefeed')}`,
        '',
        '<b>Order</b> FILLED',
        'order_id 123456789',
        'filled_price 612.55',
        'filled_qty 0.0979',
      ].join('\n'),
    )
  })

  it('renders the REJECTED reason instead of the order fields', () => {
    const rejected = renderNotification(
      {
        ...RUN,
        order: { status: 'REJECTED', reason: 'emergency stop', ts: '2026-09-05T02:00:07Z' },
      },
      { explorerUrl: EXPLORER },
    )
    expect(rejected).toContain('<b>Order</b> REJECTED')
    expect(rejected).toContain('emergency stop')
    expect(rejected).not.toContain('order_id')
  })

  it('omits the order block when the Run had no execution Node', () => {
    const skipped = renderNotification(
      { ...RUN, order: undefined, summary: 'HOLD BNBUSDT, no order' },
      { explorerUrl: EXPLORER },
    )
    expect(skipped).toContain('HOLD BNBUSDT, no order')
    expect(skipped).not.toContain('<b>Order</b>')
  })

  it('renders the verification sample, which has no run id and empty tables', () => {
    const parsed = typeSchemas.notify.input.parse(samples.notify)
    const text = renderNotification(parsed, { explorerUrl: EXPLORER })
    expect(text).toBe(
      ['<b>AgentDesk</b>', '', 'AgentDesk listing verification call.'].join('\n'),
    )
  })

  it('renders a FILLED order that carries none of its optional fields', () => {
    // `notifyInput` parses `order` by shape only, so this input is accepted;
    // rendering must not print "undefined" into the chat.
    const text = renderNotification(
      { ...RUN, order: { status: 'FILLED', ts: '2026-09-05T02:00:07Z' } },
      { explorerUrl: EXPLORER },
    )
    expect(text).toContain('<b>Order</b> FILLED')
    expect(text).not.toContain('undefined')
  })

  it('escapes the three characters Telegram HTML reserves', () => {
    const text = renderNotification(
      {
        ...RUN,
        summary: 'signal <LONG> & size > 60',
        cost_table: [{ node: 'research', provider: 'A & B <Labs>', amount: '0.05' }],
        tx_hashes: [],
        order: undefined,
      },
      { explorerUrl: EXPLORER },
    )
    expect(text).toContain('signal &lt;LONG&gt; &amp; size &gt; 60')
    expect(text).toContain('• research · A &amp; B &lt;Labs&gt; · 0.05 tUSD')
    expect(text).not.toMatch(/[^&]<(?!\/?(b|a|code)\b)/)
  })

  it('honours the explorer base and falls back to BSC testnet', () => {
    const custom = renderNotification(
      { ...RUN, tx_hashes: [TX_DATA], cost_table: [], order: undefined },
      { explorerUrl: 'https://explorer.example.com/' },
    )
    expect(custom).toContain(`<a href="https://explorer.example.com/tx/${TX_DATA}">`)

    const fallback = renderNotification({
      ...RUN,
      tx_hashes: [TX_DATA],
      cost_table: [],
      order: undefined,
    })
    expect(fallback).toContain(`<a href="https://testnet.bscscan.com/tx/${TX_DATA}">`)
  })

  it('keeps the message inside the Bot API limit whatever the summary carries', () => {
    const text = renderNotification(
      { ...RUN, summary: 'x'.repeat(SUMMARY_LIMIT * 10) },
      { explorerUrl: EXPLORER },
    )
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT)
    expect(text).toContain('…')
    // Truncation must not cost the reader the cost table or the order.
    expect(text).toContain('<b>Cost</b>')
    expect(text).toContain('<b>Order</b> FILLED')
  })
})

describe('escapeHtml and shortHash', () => {
  it('escapes only &, < and >', () => {
    expect(escapeHtml(`a&b<c>d"e'f`)).toBe(`a&amp;b&lt;c&gt;d"e'f`)
  })

  it('shortens a 32-byte hash and leaves anything shorter alone', () => {
    expect(shortHash(TX_DATA)).toBe('0xa1b2c3d4…deadbeef')
    expect(shortHash('0xabc')).toBe('0xabc')
  })
})
