import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PublicSettings, RunSummary } from '@agent-desk/schemas'
import { publicSettingsQueryKey } from '../../lib/session-query.ts'
import { DashboardView } from './dashboard-view.tsx'
import { runFeedQueryKey, type RunFeedPage } from './run-feed.ts'

/**
 * Story 5.1: each row renders the Run's fields with the cost as decimal tUSD, a
 * status badge carrying the PRD status text verbatim, and links to
 * `/runs/<id>` and `/runs/<id>/split`; the page links to the five Builder
 * surfaces plus `/operator` for an Operator only, and carries the mode and
 * Emergency Stop badge.
 *
 * Rendering the component against a seeded cache checks all of that at once,
 * without a browser.
 */

const WALLET = '0xa71c3d90e5b28f4607c93d1a2b85e04f7d16c982'

const runningRun: RunSummary = {
  id: 'run_01K4RWZ8QY7M3B0P5X2A9TGCVD',
  workflow_id: 'wf_01K4RWZ0N3F8H2S6C1E7YQAB4M',
  workflow_name: 'BNB momentum desk',
  symbol: 'BNBUSDT',
  status: 'running',
  failure_reason: null,
  wallet_address: WALLET,
  // 45000 base units, which is 0.045 tUSD and nothing else (AD-13).
  total_cost: '45000',
  created_at: '2026-09-05T02:00:00.000Z',
  started_at: '2026-09-05T02:00:01.000Z',
  ended_at: null,
  nodes: [
    { node_type: 'data', status: 'succeeded' },
    { node_type: 'research', status: 'paid_awaiting_result' },
    { node_type: 'risk', status: 'pending' },
  ],
}

const failedRun: RunSummary = {
  ...runningRun,
  id: 'run_01K4RWY0AB7M3B0P5X2A9TGCVD',
  workflow_name: 'ETH breakout desk',
  status: 'failed at research',
  failure_reason: 'price mismatch: locked 10000, 402 asked 12000',
  total_cost: '10000',
  ended_at: '2026-09-05T02:00:09.000Z',
  nodes: [
    { node_type: 'data', status: 'succeeded' },
    { node_type: 'research', status: 'price_mismatch' },
    { node_type: 'notify', status: 'succeeded' },
  ],
}

const settings: PublicSettings = { mode: 'demo', emergency_stop: true }

function render(
  page: RunFeedPage,
  options: { isOperator?: boolean } = {},
): string {
  const client = new QueryClient()
  client.setQueryData(runFeedQueryKey, page)
  client.setQueryData(publicSettingsQueryKey, settings)
  return renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client,
      children: createElement(DashboardView, { isOperator: options.isOperator ?? false }),
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

const feed: RunFeedPage = { items: [runningRun, failedRun], next: null }

describe('the dashboard', () => {
  const markup = render(feed)
  const body = text(markup)

  it('lists each Run with its Workflow name and its id', () => {
    expect(body).toContain('BNB momentum desk')
    expect(body).toContain(runningRun.id)
    expect(body).toContain('ETH breakout desk')
    expect(body).toContain(failedRun.id)
  })

  it('renders the status with the PRD wording verbatim', () => {
    expect(markup).toContain('data-status="running"')
    expect(markup).toContain('data-status="failed at research"')
    expect(body).toContain('failed at research')
  })

  it('shows the failure reason of a Run that failed', () => {
    expect(body).toContain('price mismatch: locked 10000, 402 asked 12000')
  })

  it('renders the cost as decimal tUSD, never as base units (AD-13)', () => {
    expect(body).toContain('0.045')
    expect(body).toContain('0.01')
    expect(body).toContain('tUSD')
    expect(body).not.toContain('45000')
  })

  it('shows the Node Types in chain order with each Call status', () => {
    expect(body).toContain('1. data')
    expect(body).toContain('2. research')
    expect(body).toContain('3. risk')
    expect(markup).toContain('data-status="paid_awaiting_result"')
    expect(markup).toContain('data-status="price_mismatch"')
    // The chain is ordered on screen, not just in the array.
    expect(body.indexOf('1. data')).toBeLessThan(body.indexOf('2. research'))
    expect(body.indexOf('2. research')).toBeLessThan(body.indexOf('3. risk'))
  })

  it('shows the three timestamps', () => {
    expect(body).toContain('2026-09-05 02:00:00 UTC')
    expect(body).toContain('2026-09-05 02:00:01 UTC')
    expect(body).toContain('2026-09-05 02:00:09 UTC')
    expect(body).toContain('still running')
  })

  it('links every Run to its live view and to its cost split', () => {
    expect(markup).toContain(`href="/runs/${runningRun.id}"`)
    expect(markup).toContain(`href="/runs/${runningRun.id}/split"`)
    expect(markup).toContain(`href="/runs/${failedRun.id}"`)
    expect(markup).toContain(`href="/runs/${failedRun.id}/split"`)
  })

  it('links the Builder surfaces', () => {
    for (const href of ['/marketplace', '/workflows', '/payments', '/settlements', '/settings']) {
      expect(markup).toContain(`href="${href}"`)
    }
  })

  it('does not link /operator for a Builder', () => {
    expect(markup).not.toContain('href="/operator"')
  })

  it('links /operator for an Operator', () => {
    expect(render(feed, { isOperator: true })).toContain('href="/operator"')
  })

  it('carries the mode and the Emergency Stop badge', () => {
    expect(body).toContain('demo mode')
    expect(body).toContain('Emergency Stop')
  })

  it('says it is on the 2 s beat while a Run is running', () => {
    expect(body).toContain('Live · every 2 s')
  })

  it('says it is on the 10 s beat once nothing is running', () => {
    const quiet = text(
      render({ items: [{ ...failedRun, status: 'completed' }], next: null }),
    )
    expect(quiet).toContain('Live · every 10 s')
    expect(quiet).not.toContain('Live · every 2 s')
  })

  it('tells an account with no Runs how to get one', () => {
    const empty = text(render({ items: [], next: null }))
    expect(empty).toContain('No Runs yet.')
    expect(empty).toContain('Build a Workflow')
  })
})
