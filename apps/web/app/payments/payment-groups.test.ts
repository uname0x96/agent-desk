import { describe, expect, it } from 'vitest'
import { sumBaseUnits, type PaymentView } from '@agent-desk/schemas'
import { toPaymentView } from '../api/payments/payments-model.ts'
import {
  NOT_SETTLED,
  NO_REFUND,
  groupByRun,
  pageTotal,
  paymentProof,
  refundNote,
  runSubtotal,
  settlementsHref,
} from './payment-groups.ts'
import {
  PAID_STATUSES,
  RUN_A,
  RUN_B,
  callFixtures,
  paymentRows,
  runACalls,
  runBCalls,
  type CallFixture,
} from './fixtures.ts'

/**
 * Story 5.2's acceptance criteria, over fixture rows.
 *
 * The rows go through the same projection the route uses (`toPaymentView` on
 * the Calls that carry a `payment_payload`), so what is under test is the whole
 * path from a `calls` row to a number on screen, not a hand-built page body.
 */

const items: PaymentView[] = paymentRows(callFixtures).map(toPaymentView)

/**
 * Story 5.1's definition, restated here on purpose: `total_cost` is
 * `locked_price` summed over the Calls in `paid_awaiting_result`, `succeeded`
 * and `failed_after_payment`. Applied to the raw Run rather than to the page,
 * so the assertion below compares two independent paths to the same number.
 */
function totalCost(calls: readonly CallFixture[]): string {
  return sumBaseUnits(
    calls.filter((call) => PAID_STATUSES.includes(call.status)).map((call) => call.lockedPrice),
  ).toString()
}

describe('the per-Run subtotal (Story 5.2: equals the Run total_cost of Story 5.1)', () => {
  const groups = groupByRun(items)

  it('matches total_cost for a Run that paid every Node it reached', () => {
    const group = groups.find((entry) => entry.runId === RUN_A)!
    expect(group.subtotal).toBe(totalCost(runACalls))
    // 0.01 + 0.05 + 0.02 + 0.01 + 0.005, in base units.
    expect(group.subtotal).toBe('95000')
  })

  it('matches total_cost for a Run whose authorisation the chain never used', () => {
    const group = groups.find((entry) => entry.runId === RUN_B)!
    expect(group.subtotal).toBe(totalCost(runBCalls))
    // Only the `data` Call moved money: the `research` Call is `payment_failed`
    // and the `risk` Call is `price_mismatch`.
    expect(group.subtotal).toBe('10000')
  })

  it('leaves a payment_failed row on the page but out of the subtotal', () => {
    const group = groups.find((entry) => entry.runId === RUN_B)!
    expect(group.items.map((item) => item.status)).toContain('payment_failed')
    expect(group.paidCount).toBe(1)
  })

  it('never counts a Call that signed nothing, because it is not a payment at all', () => {
    expect(items.map((item) => item.call_id)).not.toContain('call_PAYB2')
  })

  it('adds the subtotals up to the page total', () => {
    expect(pageTotal(groups)).toBe('105000')
  })

  it('is zero, not an error, for a Run whose every payment failed', () => {
    const failedOnly = runBCalls.filter((call) => call.status === 'payment_failed')
    expect(runSubtotal(paymentRows(failedOnly).map(toPaymentView))).toBe('0')
  })
})

describe('grouping by Run', () => {
  const groups = groupByRun(items)

  it('makes one group per Run, in the order the route sent them', () => {
    expect(groups.map((group) => group.runId)).toEqual([RUN_A, RUN_B])
  })

  it('keeps Node order inside a Run, which is the order the money moved in', () => {
    const group = groups.find((entry) => entry.runId === RUN_A)!
    expect(group.items.map((item) => item.node_type)).toEqual([
      'data',
      'research',
      'risk',
      'execution',
      'notify',
    ])
  })

  it('puts every payment row in exactly one group', () => {
    expect(groups.flatMap((group) => group.items)).toHaveLength(items.length)
  })

  it('carries the Provider, the from and to addresses and the amount through', () => {
    const first = groups[0]!.items[0]!
    expect(first.provider).toBe('Binance Ticker')
    expect(first.amount).toBe('10000')
    expect(first.from).toBe('0xa71c3d90e5b28f4607c93d1a2b85e04f7d16c982')
    expect(first.to).toBe('0x1e4a2f7d3c9b60518a7d3f2c4b8e91d0a6c73f52')
  })

  it('is empty for an empty page rather than throwing', () => {
    expect(groupByRun([])).toEqual([])
    expect(pageTotal([])).toBe('0')
  })
})

describe('the transaction cell', () => {
  const byId = new Map(items.map((item) => [item.call_id, item]))

  it('links the hash when the payment settled', () => {
    expect(paymentProof(byId.get('call_PAYA0')!)).toEqual({
      kind: 'tx',
      hash: byId.get('call_PAYA0')!.payment_tx_hash,
    })
  })

  it(`reads "${NOT_SETTLED}" when there is no hash and the status is payment_failed`, () => {
    expect(paymentProof(byId.get('call_PAYB1')!)).toEqual({ kind: 'not_settled' })
  })

  it('says the receipt is still coming while the Call is paid_awaiting_result', () => {
    const inFlight: PaymentView = {
      ...byId.get('call_PAYA0')!,
      status: 'paid_awaiting_result',
      payment_tx_hash: null,
    }
    expect(paymentProof(inFlight)).toEqual({ kind: 'awaiting' })
  })
})

describe('the refund cell (FR-38)', () => {
  const byId = new Map(items.map((item) => [item.call_id, item]))

  it(`reads "${NO_REFUND}" on a failed_after_payment execution row`, () => {
    expect(refundNote(byId.get('call_PAYA3')!)).toEqual({ kind: 'no_refund' })
  })

  it(`reads "${NO_REFUND}" on a failed_after_payment data or notify row too`, () => {
    for (const nodeType of ['data', 'notify'] as const) {
      const row: PaymentView = {
        ...byId.get('call_PAYA3')!,
        node_type: nodeType,
      }
      expect(refundNote(row)).toEqual({ kind: 'no_refund' })
    }
  })

  it('says nothing about a refund on an unscored row that succeeded', () => {
    expect(refundNote(byId.get('call_PAYA0')!)).toEqual({ kind: 'none' })
    expect(refundNote(byId.get('call_PAYA4')!)).toEqual({ kind: 'none' })
  })

  it('links a settled research row to its Settlement, filtered to the Run', () => {
    expect(refundNote(byId.get('call_PAYA1')!)).toEqual({
      kind: 'settlement',
      href: settlementsHref(RUN_A),
      pending: false,
    })
    expect(settlementsHref(RUN_A)).toBe(`/settlements?run_id=${RUN_A}`)
  })

  it('links a scored risk row that has no settlements row yet, and says it is pending', () => {
    expect(refundNote(byId.get('call_PAYA2')!)).toEqual({
      kind: 'settlement',
      href: settlementsHref(RUN_A),
      pending: true,
    })
  })

  it('offers no Settlement for a research row AD-9 will never score', () => {
    // `payment_failed`: the Call never reached `succeeded` or
    // `failed_after_payment`, so no `settlements` row is ever written for it.
    expect(refundNote(byId.get('call_PAYB1')!)).toEqual({ kind: 'none' })
  })
})
