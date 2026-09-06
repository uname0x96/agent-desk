import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PaymentsResponse } from '@agent-desk/schemas'
import { ExplorerProvider } from '../../lib/explorer-context.tsx'
import { toPaymentView } from '../api/payments/payments-model.ts'
import { RUN_A, RUN_B, callFixtures, paymentRows } from './fixtures.ts'
import { NOT_SETTLED, NO_REFUND, settlementsHref } from './payment-groups.ts'
import { paymentsQueryKey } from './payments-query.ts'

/**
 * Story 5.2's rendering criteria: amounts as decimal tUSD, addresses
 * checksummed, the hash as an explorer link, "not settled", "no refund", the
 * Settlement link, and the per-Run subtotal on screen. Rendering the component
 * against a seeded cache checks the whole table at once, without a browser.
 */

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}))

const { PaymentsView } = await import('./payments-view.tsx')

const page: PaymentsResponse = {
  items: paymentRows(callFixtures).map(toPaymentView),
  next: null,
}

function render(body: PaymentsResponse): string {
  const client = new QueryClient()
  client.setQueryData(paymentsQueryKey({ runId: null }), body)
  return renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client,
      children: createElement(ExplorerProvider, {
        value: 'https://testnet.bscscan.com',
        children: createElement(PaymentsView, {}),
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

const markup = render(page)
const body = text(markup)

describe('the payments view', () => {
  it('groups the rows by Run and names each Run', () => {
    expect(body).toContain(RUN_A)
    expect(body).toContain(RUN_B)
    expect(markup).toContain(`/runs/${RUN_A}`)
  })

  it('prints a per-Run subtotal as decimal tUSD', () => {
    // Run A: 95000 base units; Run B: 10000.
    expect(body).toContain('Subtotal 0.095 tUSD')
    expect(body).toContain('Subtotal 0.01 tUSD')
  })

  it('names the Provider and the Node of every payment row', () => {
    for (const provider of [
      'Binance Ticker',
      'Alpha Research',
      'Guardrail Risk',
      'Binance Spot Executor',
      'Telegram Notifier',
      'Sloppy Research',
    ]) {
      expect(body).toContain(provider)
    }
  })

  it('renders amounts as decimals, never as base units', () => {
    expect(body).toContain('0.05')
    expect(body).toContain('0.005')
    expect(body).not.toContain('50000')
  })

  it('renders the from and to addresses checksummed (AD-13)', () => {
    // The wire carries these lower-case; EIP-55 puts the capitals back. The
    // cell truncates, so the full form is in the explorer href and the title.
    expect(markup).toContain('0xa71C3d90e5B28f4607c93D1a2b85e04f7D16c982')
    expect(markup).toContain('0x1e4A2F7d3c9B60518a7D3f2C4b8e91d0A6C73F52')
    expect(markup).not.toContain('0xa71c3d90e5b28f4607c93d1a2b85e04f7d16c982')
  })

  it('links every settled payment to the explorer by tx hash', () => {
    expect(markup).toContain('https://testnet.bscscan.com/tx/0xaaaaaaaa')
  })

  it(`reads "${NOT_SETTLED}" for a payment_failed row with no hash`, () => {
    expect(body).toContain(NOT_SETTLED)
  })

  it(`reads "${NO_REFUND}" on the failed_after_payment execution row`, () => {
    expect(body).toContain(NO_REFUND)
  })

  it('links the research and risk rows to their Settlement, filtered to the Run', () => {
    expect(markup).toContain(settlementsHref(RUN_A).replace(/&/g, '&amp;'))
    expect(body).toContain('Settlement pending')
  })

  it('shows the total paid across the page', () => {
    expect(body).toContain('0.105')
  })

  it('says so plainly when there is no payment yet', () => {
    expect(text(render({ items: [], next: null }))).toContain('No payment yet')
  })
})
