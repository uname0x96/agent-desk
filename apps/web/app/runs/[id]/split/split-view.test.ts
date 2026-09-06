import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RunResponse, SettlementView } from '@agent-desk/schemas'
import { ExplorerProvider } from '../../../../lib/explorer-context.tsx'
import { completedRunFixture, runningRunFixture } from '../../../../lib/fixtures/run.ts'
import { runQueryKey } from '../../../../lib/run-polling.ts'
import { SplitView } from './split-view.tsx'

/**
 * Story 5.5. `split-model.test.ts` proves the decisions; this file proves the
 * two panes actually render them — that the JSON really is absent until a row
 * is opened, that the arrows carry their amounts and hashes as explorer links,
 * and that the header shows the Run status.
 *
 * Rendered against a seeded cache, exactly as the live Run view's test does, so
 * no browser and no network are involved.
 */
function render(run: RunResponse): string {
  const client = new QueryClient()
  client.setQueryData(runQueryKey(run.id), run)
  return renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client,
      children: createElement(ExplorerProvider, {
        value: 'https://testnet.bscscan.com',
        children: createElement(SplitView, { runId: run.id }),
      }),
    }),
  )
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&middot;|&#183;/g, '·')
    .replace(/\s+/g, ' ')
}

const SLASH_TX = '0x9a1c4f70b3e825d6094a7c1f3b60d28e45a9016c7f3b2d84e05c916a7b34f2d0'

const FAILED_SETTLEMENT: SettlementView = {
  id: 'stl_01K4RX0M7P2S5V8Y1B4E7H0KNQ',
  call_id: completedRunFixture.calls[1]!.id,
  listing_id: completedRunFixture.calls[1]!.listing_id,
  result: 'failed',
  not_scored_reason: null,
  mode: 'demo',
  rule_label: 'demo settlement rule: 24h trend',
  price_source: 'binance-public-market-data',
  start_price: '612.40',
  end_price: '618.10',
  change_24h_pct: 0.93,
  p_fill: null,
  window_min: null,
  window_max: null,
  scored_at: '2026-09-05T02:00:31Z',
  slash_amount: '25000',
  slash_tx_hash: SLASH_TX,
  refund_to: completedRunFixture.wallet_address,
  reputation_tx_hash: null,
}

const SETTLED_RUN: RunResponse = {
  ...completedRunFixture,
  calls: completedRunFixture.calls.map((call, index) =>
    index === 1 ? { ...call, settlement: FAILED_SETTLEMENT } : call,
  ),
}

describe('the split view header', () => {
  const body = text(render(runningRunFixture))

  it('shows the Run status, the Workflow and the Run id', () => {
    expect(body).toContain('running')
    expect(body).toContain('BNB momentum desk')
    expect(body).toContain(runningRunFixture.id)
  })

  it('says the two panes are polling on the same 2 s clock', () => {
    expect(body).toContain('live · every 2 s')
  })

  it('says the poll has stopped once the Run is finished', () => {
    expect(text(render(completedRunFixture))).toContain('final · polling stopped')
  })

  it('leaves room for the mode and Emergency Stop badges', () => {
    // `PlatformStatus` renders from `GET /api/settings/public`, which this
    // static render has no answer for; the header slot is what is checked here
    // and the badges themselves are Story 2.2's own test.
    expect(render(runningRunFixture)).toContain('Full Run view')
  })
})

describe('the left pane', () => {
  const markup = render(runningRunFixture)
  const body = text(markup)

  it('lists every Call in Node order with Provider, status and elapsed time', () => {
    expect(body).toContain('Agent log')
    expect(body).toContain('1. data')
    expect(body).toContain('Binance Ticker')
    expect(body).toContain('succeeded')
    expect(body).toContain('2. research')
    expect(body).toContain('Claude Analyst')
    expect(body).toContain('paid_awaiting_result')
    expect(body).toContain('3. risk')
    expect(body).toContain('Volatility Guard')

    expect(body.indexOf('1. data')).toBeLessThan(body.indexOf('2. research'))
    expect(body.indexOf('2. research')).toBeLessThan(body.indexOf('3. risk'))
  })

  it('keeps the request and response JSON collapsed by default', () => {
    // The payloads are not in the markup at all until a row is opened.
    expect(body).not.toContain('"volatility_24h_pct"')
    expect(body).not.toContain('"symbol": "BNBUSDT"')
  })

  it('offers every Call with a payload an expander, marked as closed', () => {
    const closed = markup.match(/aria-expanded="false"/g) ?? []
    // One per Call; the `pending` Call's button is present but disabled.
    expect(closed.length).toBe(runningRunFixture.calls.length)
    expect(markup).toContain('disabled=""')
  })
})

describe('the right pane', () => {
  const markup = render(SETTLED_RUN)
  const body = text(markup)

  it('draws one payment arrow per paid Call, to the payout wallet', () => {
    expect(body).toContain('Money flow')
    expect(body).toContain('Builder wallet')
    expect((markup.match(/data-arrow-kind="payment"/g) ?? []).length).toBe(3)
  })

  it('labels each arrow with the amount as decimal tUSD', () => {
    expect(body).toContain('0.01 tUSD')
    expect(body).toContain('0.025 tUSD')
  })

  it('links every tx hash through explorerLink()', () => {
    expect(markup).toContain(
      'href="https://testnet.bscscan.com/tx/0x2c4e8a1b90d7f36524ab8c0e91d5f7b23604ae8c19d2f5063b7a41c8e0d926f3"',
    )
    expect(markup).toContain(`href="https://testnet.bscscan.com/tx/${SLASH_TX}"`)
  })

  it('draws one arrow back for the scored Call whose Settlement failed', () => {
    expect((markup.match(/data-arrow-kind="refund"/g) ?? []).length).toBe(1)
    expect(body).toContain('Claude Analyst Stake')
    expect(body).toContain('held by the Registry')
  })

  it('shows the running totals of paid and refunded', () => {
    expect(body).toContain('Paid')
    expect(body).toContain('0.045 tUSD')
    expect(body).toContain('Refunded')
    expect(body).toContain('Net cost')
    expect(body).toContain('0.02 tUSD')
  })

  it('says so when nothing has moved yet', () => {
    const untouched = text(
      render({
        ...runningRunFixture,
        calls: runningRunFixture.calls.map((call) => ({ ...call, status: 'pending' as const })),
      }),
    )
    expect(untouched).toContain('Nothing has moved yet')
  })
})

describe('the frame', () => {
  it('is a fixed viewport with two equal panes that scroll inside themselves', () => {
    const markup = render(runningRunFixture)
    // The demo is recorded at 1280 x 720: the page itself must not scroll, and
    // neither pane may hand the page a horizontal scrollbar.
    expect(markup).toContain('h-[calc(100dvh-65px)]')
    expect(markup).toContain('grid min-h-0 flex-1 grid-cols-2 gap-4')
    expect((markup.match(/overflow-x-hidden overflow-y-auto/g) ?? []).length).toBe(2)
  })
})
