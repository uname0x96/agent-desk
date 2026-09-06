import { describe, expect, it } from 'vitest'
import { runResponse, type CallView, type RunResponse, type SettlementView } from '@agent-desk/schemas'
import { completedRunFixture, runningRunFixture } from '../../lib/fixtures/run.ts'
import {
  BUILDER_LABEL,
  NO_ROWS_EXPANDED,
  buildCallLog,
  buildSplitViewModel,
  callElapsed,
  isRowExpanded,
  moneyArrows,
  moneyTotals,
  orderCalls,
  toggleRow,
} from './split-model.ts'

/**
 * Story 5.5. Every acceptance criterion of the split view that is a decision
 * rather than a pixel is decided in `split-model.ts`, so this file is where
 * those criteria are proved:
 *
 *   - the left pane lists each Call in Node order with Provider, status and
 *     elapsed time, appending rows as Calls advance;
 *   - the request and response JSON is collapsed by default and expandable;
 *   - the right pane draws one arrow per paid Call to the payout wallet and
 *     one arrow back for a scored Call whose Settlement failed;
 *   - the arrows are labelled with the amount in base units (rendered as
 *     decimal tUSD, AD-13) and the tx hash;
 *   - the running totals of paid and refunded.
 *
 * The fixtures are the shared ones from `lib/fixtures/run.ts`, so the model is
 * exercised against a body that really satisfies `runResponse`.
 */

const NOW = new Date('2026-09-05T02:00:09Z')

const SLASH_TX = '0x9a1c4f70b3e825d6094a7c1f3b60d28e45a9016c7f3b2d84e05c916a7b34f2d0'
const CREATOR_WALLET = '0x5d2c81b0e37f94a6208d1c73b5e6f80a9c24173b'

/** Adds a Settlement to the Run's `research` Call without touching the fixture. */
function withSettlement(run: RunResponse, overrides: Partial<SettlementView>): RunResponse {
  return {
    ...run,
    calls: run.calls.map((call) =>
      call.node_type === 'research'
        ? {
            ...call,
            settlement: {
              id: 'stl_01K4RX0M7P2S5V8Y1B4E7H0KNQ',
              call_id: call.id,
              listing_id: call.listing_id,
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
              refund_to: run.wallet_address,
              reputation_tx_hash: null,
              ...overrides,
            },
          }
        : call,
    ),
  }
}

describe('the fixtures this file builds on', () => {
  it('still satisfy runResponse once a Settlement is attached', () => {
    expect(runResponse.safeParse(withSettlement(completedRunFixture, {})).success).toBe(true)
    expect(runResponse.safeParse(withSettlement(runningRunFixture, {})).success).toBe(true)
  })
})

// --------------------------------------------------------------- Call ordering

describe('orderCalls: the left pane is the chain, top to bottom', () => {
  it('puts the Calls in Node order however the body arrived', () => {
    const shuffled = [...runningRunFixture.calls].reverse()
    expect(orderCalls(shuffled).map((call) => call.node_index)).toEqual([0, 1, 2])
  })

  it('sorts a Call with no node_index last, since it has no place in the chain', () => {
    const verification: CallView = {
      ...runningRunFixture.calls[0]!,
      id: 'call_01K4RX1VERIFICATION0000000',
      kind: 'verification',
      node_index: null,
    }
    const ordered = orderCalls([verification, ...runningRunFixture.calls])
    expect(ordered.at(-1)?.id).toBe(verification.id)
  })

  it('breaks a tie on the id, which is a ULID and so already in creation order', () => {
    const first: CallView = { ...runningRunFixture.calls[0]!, id: 'call_A', node_index: 0 }
    const second: CallView = { ...runningRunFixture.calls[0]!, id: 'call_B', node_index: 0 }
    expect(orderCalls([second, first]).map((call) => call.id)).toEqual(['call_A', 'call_B'])
  })
})

// ---------------------------------------------------------------- elapsed time

describe('callElapsed', () => {
  const [data, research, risk] = runningRunFixture.calls as [CallView, CallView, CallView]

  it('measures a finished Call between its own two timestamps', () => {
    // 02:00:01 -> 02:00:04.
    expect(callElapsed(data, NOW)).toEqual({ label: '3.0 s', live: false })
  })

  it('measures a Call still in flight against the clock, and says so', () => {
    // Paid at 02:00:04, no answer yet; the clock reads 02:00:09.
    expect(callElapsed(research, NOW)).toEqual({ label: '5.0 s', live: true })
  })

  it('keeps ticking as the clock moves, which is what the pane re-renders', () => {
    const later = callElapsed(research, new Date('2026-09-05T02:00:12Z'))
    expect(later).toEqual({ label: '8.0 s', live: true })
  })

  it('shows no time for a Call the engine has not reached', () => {
    expect(callElapsed(risk, NOW)).toEqual({ label: '—', live: false })
  })

  it('never shows a terminal Call as still running', () => {
    const skipped: CallView = { ...risk, status: 'skipped', started_at: '2026-09-05T02:00:05Z' }
    expect(callElapsed(skipped, NOW)).toEqual({ label: '—', live: false })
  })

  it('prints sub-second Calls in milliseconds', () => {
    const quick: CallView = {
      ...data,
      started_at: '2026-09-05T02:00:01.000Z',
      ended_at: '2026-09-05T02:00:01.412Z',
    }
    expect(callElapsed(quick, NOW).label).toBe('412 ms')
  })
})

// ------------------------------------------------------------------- left pane

describe('buildCallLog: Provider, status, elapsed time, request and response', () => {
  const rows = buildCallLog(runningRunFixture, NOW)

  it('has one row per Call, in Node order, labelled like the live Run view', () => {
    expect(rows.map((row) => row.node_label)).toEqual(['1. data', '2. research', '3. risk'])
    expect(rows.map((row) => row.position)).toEqual([1, 2, 3])
  })

  it('carries the Provider, the status and the elapsed time of each Call', () => {
    expect(rows.map((row) => row.provider)).toEqual([
      'Binance Ticker',
      'Claude Analyst',
      'Volatility Guard',
    ])
    expect(rows.map((row) => row.status)).toEqual(['succeeded', 'paid_awaiting_result', 'pending'])
    expect(rows.map((row) => row.elapsed.label)).toEqual(['3.0 s', '5.0 s', '—'])
  })

  it('carries the amount as base units, for the view to render as decimal tUSD', () => {
    expect(rows.map((row) => row.amount)).toEqual(['10000', '25000', '10000'])
  })

  it('carries the request and response payloads verbatim', () => {
    expect(rows[0]?.request).toEqual({ symbol: 'BNBUSDT' })
    expect(rows[0]?.response).toMatchObject({ symbol: 'BNBUSDT', price: '612.40' })
    expect(rows[1]?.has_request).toBe(true)
    expect(rows[1]?.has_response).toBe(false)
  })

  it('marks a Call with neither payload as nothing to expand', () => {
    expect(rows[2]?.expandable).toBe(false)
    expect(rows[0]?.expandable).toBe(true)
  })

  it('appends rows as Calls advance, keeping the earlier ones intact', () => {
    const finished = buildCallLog(completedRunFixture, NOW)
    expect(finished).toHaveLength(rows.length)
    expect(finished.map((row) => row.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(finished[0]?.call_id).toBe(rows[0]?.call_id)
  })

  it('names which Calls have been paid for', () => {
    // `pending` has not: the money leaves the wallet at signing time (AD-3).
    expect(rows.map((row) => row.paid)).toEqual([true, true, false])
  })
})

// --------------------------------------------------------- collapsed by default

describe('the request and response JSON is collapsed by default', () => {
  it('opens no row at all to begin with', () => {
    const rows = buildCallLog(runningRunFixture, NOW)
    for (const row of rows) {
      expect(isRowExpanded(NO_ROWS_EXPANDED, row.call_id)).toBe(false)
    }
  })

  it('expands and collapses the row the Builder clicked, and only that one', () => {
    const [first, second] = buildCallLog(runningRunFixture, NOW)
    const opened = toggleRow(NO_ROWS_EXPANDED, first!.call_id)
    expect(isRowExpanded(opened, first!.call_id)).toBe(true)
    expect(isRowExpanded(opened, second!.call_id)).toBe(false)

    const closed = toggleRow(opened, first!.call_id)
    expect(isRowExpanded(closed, first!.call_id)).toBe(false)
  })

  it('leaves a row the Builder opened open when the poll appends the next one', () => {
    const rows = buildCallLog(runningRunFixture, NOW)
    const opened = toggleRow(NO_ROWS_EXPANDED, rows[0]!.call_id)

    const later = buildCallLog(completedRunFixture, NOW)
    expect(isRowExpanded(opened, later[0]!.call_id)).toBe(true)
    expect(isRowExpanded(opened, later[2]!.call_id)).toBe(false)
  })

  it('never mutates the set it was given', () => {
    const opened = toggleRow(NO_ROWS_EXPANDED, 'call_x')
    expect(NO_ROWS_EXPANDED.size).toBe(0)
    expect(opened.size).toBe(1)
  })
})

// ------------------------------------------------------------------ right pane

describe('moneyArrows: one arrow out per paid Call', () => {
  const arrows = moneyArrows(runningRunFixture)

  it('draws an arrow for every paid Call and for no other', () => {
    // data succeeded and research is paid_awaiting_result; risk is pending.
    expect(arrows).toHaveLength(2)
    expect(arrows.map((arrow) => arrow.kind)).toEqual(['payment', 'payment'])
    expect(arrows.map((arrow) => arrow.node_label)).toEqual(['1. data', '2. research'])
  })

  it('runs from the Builder wallet to the Listing payout wallet', () => {
    const [first] = arrows
    expect(first?.from).toEqual({ label: BUILDER_LABEL, address: runningRunFixture.wallet_address })
    expect(first?.to).toEqual({
      label: 'Binance Ticker',
      address: runningRunFixture.calls[0]?.locked_pay_to,
    })
  })

  it('labels the arrow with the locked price and the payment tx hash', () => {
    expect(arrows[0]?.amount).toBe('10000')
    expect(arrows[0]?.tx_hash).toBe(runningRunFixture.calls[0]?.payment_tx_hash)
    expect(arrows[0]?.pending).toBe(false)
  })

  it('shows a payment whose settlement has not produced a hash yet as pending', () => {
    // `paid_awaiting_result`: signed and committed, no PAYMENT-RESPONSE yet.
    expect(arrows[1]?.amount).toBe('25000')
    expect(arrows[1]?.tx_hash).toBeNull()
    expect(arrows[1]?.pending).toBe(true)
  })

  it('draws no arrow for a Call that was refused before any payment', () => {
    const refused: RunResponse = {
      ...runningRunFixture,
      calls: runningRunFixture.calls.map((call) => ({ ...call, status: 'price_mismatch' as const })),
    }
    expect(moneyArrows(refused)).toEqual([])
  })
})

describe('moneyArrows: the Refund arrow back to the Builder', () => {
  it('is drawn only for a scored Call whose Settlement failed', () => {
    const run = withSettlement(completedRunFixture, {})
    const arrows = moneyArrows(run)
    const refunds = arrows.filter((arrow) => arrow.kind === 'refund')

    expect(refunds).toHaveLength(1)
    expect(refunds[0]?.node_label).toBe('2. research')
    expect(refunds[0]?.to).toEqual({ label: BUILDER_LABEL, address: run.wallet_address })
    expect(refunds[0]?.amount).toBe('25000')
    expect(refunds[0]?.tx_hash).toBe(SLASH_TX)
  })

  it('follows its own payment arrow, so the pane reads out then back', () => {
    const arrows = moneyArrows(withSettlement(completedRunFixture, {}))
    expect(arrows.map((arrow) => `${arrow.kind} ${arrow.node_label}`)).toEqual([
      'payment 1. data',
      'payment 2. research',
      'refund 2. research',
      'payment 3. risk',
    ])
  })

  it.each(['passed', 'not_scored'] as const)('is not drawn for a %s Settlement', (result) => {
    const run = withSettlement(completedRunFixture, {
      result,
      slash_amount: null,
      slash_tx_hash: null,
      ...(result === 'not_scored' ? { not_scored_reason: 'no_reference_price' as const } : {}),
    })
    expect(moneyArrows(run).filter((arrow) => arrow.kind === 'refund')).toEqual([])
  })

  it('is not drawn for a Call that was never scored at all', () => {
    expect(moneyArrows(completedRunFixture).filter((arrow) => arrow.kind === 'refund')).toEqual([])
  })

  it('takes the Refund out of the Stake, not out of the payout wallet', () => {
    // FR-35 slashes the Agent's Stake, held by AgentDeskRegistry; naming the
    // Creator's wallet as the source would claim a transfer that never happened.
    const run = withSettlement(completedRunFixture, { refund_to: CREATOR_WALLET })
    const refund = moneyArrows(run).find((arrow) => arrow.kind === 'refund')
    expect(refund?.from).toEqual({ label: 'Claude Analyst Stake', address: null })
    expect(refund?.to.address).toBe(CREATOR_WALLET)
  })

  it('shows the locked price, unconfirmed, while the Slash is still pending', () => {
    const run = withSettlement(completedRunFixture, { slash_amount: null, slash_tx_hash: null })
    const refund = moneyArrows(run).find((arrow) => arrow.kind === 'refund')
    expect(refund?.amount).toBe('25000')
    expect(refund?.amount_confirmed).toBe(false)
    expect(refund?.pending).toBe(true)
  })

  it('shows the clamped amount from the Slashed event once it is known', () => {
    const run = withSettlement(completedRunFixture, { slash_amount: '7000' })
    const refund = moneyArrows(run).find((arrow) => arrow.kind === 'refund')
    expect(refund?.amount).toBe('7000')
    expect(refund?.amount_confirmed).toBe(true)
    expect(refund?.pending).toBe(false)
  })
})

// --------------------------------------------------------------- running totals

describe('moneyTotals', () => {
  it('totals only what has actually been paid while the Run is in flight', () => {
    const totals = moneyTotals(moneyArrows(runningRunFixture))
    expect(totals).toEqual({
      paid: '35000',
      refunded: '0',
      net: '35000',
      payment_count: 2,
      refund_count: 0,
    })
  })

  it('agrees with the Run total_cost the live Run view shows', () => {
    // Both sums are `locked_price` over the AD-3 paid statuses, so the split
    // view and the Run view never print two different numbers for one Run.
    // Only the finished fixture is asserted: `runningRunFixture.total_cost` is
    // hand-written as "10000" and leaves out its own `paid_awaiting_result`
    // Call, which is not what `readRun` would return for those rows.
    expect(moneyTotals(moneyArrows(completedRunFixture)).paid).toBe(completedRunFixture.total_cost)
  })

  it('subtracts the Refund, which is the point of the demo', () => {
    const totals = moneyTotals(moneyArrows(withSettlement(completedRunFixture, {})))
    expect(totals).toEqual({
      paid: '45000',
      refunded: '25000',
      net: '20000',
      payment_count: 3,
      refund_count: 1,
    })
  })

  it('is zero on a Run that has paid nothing', () => {
    expect(moneyTotals([])).toEqual({
      paid: '0',
      refunded: '0',
      net: '0',
      payment_count: 0,
      refund_count: 0,
    })
  })
})

// ------------------------------------------------------------- the whole model

describe('buildSplitViewModel', () => {
  it('gives both panes one body to read, and the header its status', () => {
    const model = buildSplitViewModel(runningRunFixture, NOW)
    expect(model.run_id).toBe(runningRunFixture.id)
    expect(model.workflow_name).toBe('BNB momentum desk')
    expect(model.symbol).toBe('BNBUSDT')
    expect(model.status).toBe('running')
    expect(model.builder_wallet).toBe(runningRunFixture.wallet_address)
    expect(model.calls).toHaveLength(3)
    expect(model.arrows).toHaveLength(2)
    expect(model.totals.paid).toBe('35000')
  })

  it('is live while the Run is running and not once it has ended', () => {
    expect(buildSplitViewModel(runningRunFixture, NOW).live).toBe(true)
    expect(buildSplitViewModel(completedRunFixture, NOW).live).toBe(false)
    expect(
      buildSplitViewModel({ ...runningRunFixture, status: 'failed at research' }, NOW).live,
    ).toBe(false)
  })

  it('carries the failure reason the header prints', () => {
    const failed = buildSplitViewModel(
      { ...runningRunFixture, status: 'failed at data', failure_reason: 'price mismatch' },
      NOW,
    )
    expect(failed.status).toBe('failed at data')
    expect(failed.failure_reason).toBe('price mismatch')
  })
})
