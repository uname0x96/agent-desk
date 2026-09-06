import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MODE_CONSTANTS } from '@agent-desk/core/mode'
import { PRICE_SOURCE, type SettlementsPage } from '@agent-desk/schemas'
import { ExplorerProvider } from '../../lib/explorer-context.tsx'
import { settlementsQueryKey, type SettlementsFilter } from './settlements-query.ts'
import { SettlementsView } from './settlements-view.tsx'
import {
  BUILDER_WALLET,
  REPUTATION_TX,
  RUN_ID,
  SLASH_TX,
  failedRiskSlashPending,
  settledFixture,
  settlementsFixture,
} from './fixtures.ts'

/**
 * Story 5.3: each row renders the rule label verbatim, the prices used with
 * their source, the result, and — for a `failed` row — the Refund as decimal
 * tUSD, `refund_to`, the Slash tx hash as an explorer link and the Reputation
 * tx hash; a `failed` row whose Slash is still pending shows "slash pending";
 * a `not_scored` row shows its reason in words.
 *
 * Rendering the component against a seeded cache checks all of that at once,
 * without a browser.
 */

const NO_FILTER: SettlementsFilter = { runId: null, listingId: null }

function render(page: SettlementsPage, filter: SettlementsFilter = NO_FILTER): string {
  const client = new QueryClient()
  client.setQueryData(settlementsQueryKey(filter), page)
  return renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client,
      children: createElement(ExplorerProvider, {
        value: 'https://testnet.bscscan.com',
        children: createElement(SettlementsView, { filter }),
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

describe('the settlement view', () => {
  const markup = render(settlementsFixture)
  const body = text(markup)

  it('prints the rule label verbatim, so a demo row reads the demo rule', () => {
    // Both spellings on purpose: the literal is what Story 5.3 requires on the
    // screen, and the constant is what the worker actually writes on the row.
    expect(body).toContain('demo settlement rule: 24h trend')
    expect(body).toContain(MODE_CONSTANTS.demo.researchRuleLabel)
    expect(body).toContain(MODE_CONSTANTS.production.researchRuleLabel)
    expect(body).toContain('risk rule: 2% drawdown in window')
  })

  it('shows the Node, the Provider and the mode the row was scored under', () => {
    expect(body).toContain('Claude Analyst')
    expect(body).toContain('Volatility Guard')
    expect(body).toContain('demo mode')
    expect(body).toContain('production mode')
  })

  it('shows the prices the rule used, with their source', () => {
    expect(body).toContain('612.40')
    expect(body).toContain('1.732 %')
    expect(body).toContain('612.55')
    expect(body).toContain('598.10')
    expect(body).toContain(PRICE_SOURCE)
  })

  it('shows the result of every row', () => {
    expect(markup).toContain('data-status="passed"')
    expect(markup).toContain('data-status="failed"')
    expect(markup).toContain('data-status="not_scored"')
  })

  it('shows the Refund of a failed row as decimal tUSD', () => {
    // 25000 base units of a six-decimal token.
    expect(body).toContain('Refund (tUSD)')
    expect(body).toContain('0.025')
  })

  it('links refund_to, the Slash tx and the Reputation tx through the explorer', () => {
    expect(markup).toContain(
      `href="https://testnet.bscscan.com/address/0xa71C3d90e5B28f4607c93D1a2b85e04f7D16c982"`,
    )
    expect(BUILDER_WALLET).toBe('0xa71c3d90e5b28f4607c93d1a2b85e04f7d16c982')
    expect(markup).toContain(`href="https://testnet.bscscan.com/tx/${SLASH_TX}"`)
    expect(markup).toContain(`href="https://testnet.bscscan.com/tx/${REPUTATION_TX}"`)
  })

  it('says "slash pending" for a failed row whose Slash has not landed', () => {
    expect(body).toContain('slash pending')
    expect(failedRiskSlashPending.slash_tx_hash).toBeNull()
  })

  it('shows each not_scored reason in words', () => {
    expect(body).toContain('REJECT decision')
    expect(body).toContain('no fill')
    expect(body).toContain('no reference price')
  })

  it('links each row back to the Run it was scored in', () => {
    expect(markup).toContain(`href="/runs/${RUN_ID}"`)
  })

  it('says it is polling while a Slash is pending, and stops saying so once none is', () => {
    expect(body).toContain('Waiting for a Slash · every 2 s')
    const settled = text(render(settledFixture))
    expect(settled).toContain('Up to date. Polling stopped.')
    expect(settled).not.toContain('slash pending')
  })

  it('offers a way out of a filter that matched nothing', () => {
    const empty = render({ items: [], next: null }, { runId: RUN_ID, listingId: null })
    expect(text(empty)).toContain('Nothing scored under this filter.')
    expect(empty).toContain('href="/settlements"')
  })

  it('explains an empty unfiltered list without blaming the Builder', () => {
    const empty = text(render({ items: [], next: null }))
    expect(empty).toContain('No Call has been scored yet.')
  })
})
