import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RunResponse } from '@agent-desk/schemas'
import { ExplorerProvider } from '../../../lib/explorer-context.tsx'
import { completedRunFixture, runningRunFixture } from '../../../lib/fixtures/run.ts'
import { runQueryKey } from '../../../lib/run-polling.ts'
import { RunView } from './run-view.tsx'

/**
 * FR-28: the Run view must show the Price Lock and, per Call, the Node,
 * Provider, status, amount, tx hash, request, response and both timestamps.
 * Rendering the component against a seeded cache checks the whole list at
 * once, without a browser.
 */
function render(run: RunResponse): string {
  const client = new QueryClient()
  client.setQueryData(runQueryKey(run.id), run)
  return renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client,
      children: createElement(ExplorerProvider, {
        value: 'https://testnet.bscscan.com',
        children: createElement(RunView, { runId: run.id }),
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

describe('the Run view', () => {
  const markup = render(runningRunFixture)
  const body = text(markup)

  it('names the Run, its Workflow and its status', () => {
    expect(body).toContain('BNB momentum desk')
    expect(body).toContain(runningRunFixture.id)
    expect(body).toContain('running')
  })

  it('shows the Price Lock: one row per Node with Provider, price and pay-to', () => {
    expect(body).toContain('Price Lock')
    for (const node of runningRunFixture.price_lock.nodes) {
      expect(body).toContain(node.provider)
      expect(body).toContain(`${node.node_index + 1}. ${node.node_type}`)
    }
    // Base units rendered as decimals: 10000 -> 0.01, 25000 -> 0.025.
    expect(body).toContain('0.01')
    expect(body).toContain('0.025')
    expect(body).toContain('0.045 tUSD')
  })

  it('shows every Call with its status, amount and both timestamps', () => {
    for (const call of runningRunFixture.calls) {
      expect(body).toContain(call.status)
      expect(body).toContain(call.provider)
    }
    expect(body).toContain('2026-09-05 02:00:01 UTC')
    expect(body).toContain('2026-09-05 02:00:04 UTC')
  })

  it('prints the request and response JSON', () => {
    expect(body).toContain('"symbol": "BNBUSDT"')
    expect(body).toContain('"price": "612.40"')
    expect(body).toContain('no response yet')
  })

  it('links every address and hash through explorerLink(), checksummed', () => {
    // EIP-55 mixed case, not the lower-case form the API returns.
    expect(markup).toContain(
      'href="https://testnet.bscscan.com/address/0x1e4A2F7d3c9B60518a7D3f2C4b8e91d0A6C73F52"',
    )
    expect(markup).toContain(
      'href="https://testnet.bscscan.com/tx/0x2c4e8a1b90d7f36524ab8c0e91d5f7b23604ae8c19d2f5063b7a41c8e0d926f3"',
    )
  })

  it('says it is polling while the Run is running', () => {
    expect(body).toContain('Live · every 2 s')
  })

  it('says the poll has stopped once the Run is finished', () => {
    const finished = text(render(completedRunFixture))
    expect(finished).toContain('Final. Polling stopped.')
    expect(finished).not.toContain('Live · every 2 s')
  })

  it('shows the failure reason when the Run failed', () => {
    const failed = text(
      render({
        ...runningRunFixture,
        status: 'failed at data',
        failure_reason: 'price mismatch: locked 10000, 402 asked 12000',
      }),
    )
    expect(failed).toContain('failed at data')
    expect(failed).toContain('price mismatch: locked 10000, 402 asked 12000')
  })
})
