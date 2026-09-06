import { describe, expect, it } from 'vitest'
import {
  PAYMENTS_PAGE_RUNS_DEFAULT,
  PAYMENTS_PAGE_RUNS_MAX,
  paymentsResponse,
} from '@agent-desk/schemas'
import { parsePageSize, parsePaymentsQuery, toPaymentView, toPaymentsPage } from './payments-model.ts'
import {
  RUN_A,
  RUN_B,
  callFixtures,
  paymentRows,
  runACalls,
  runBCalls,
} from '../../payments/fixtures.ts'

/**
 * `GET /api/payments`: the projection, the keyset cursor, and the query string.
 * All of it is pure, so none of it needs Postgres — what the database owns is
 * the filtering, which `query.ts` states in SQL with the same two constants
 * (`kind = 'run'`, `payment_payload is not null`).
 */

const rows = paymentRows(callFixtures)

describe('the projection (AD-3: a payment is a Call row)', () => {
  const view = toPaymentView(rows[0]!)

  it('carries every field FR-40 names', () => {
    expect(view).toEqual({
      call_id: 'call_PAYA0',
      run_id: RUN_A,
      node_type: 'data',
      provider: 'Binance Ticker',
      amount: '10000',
      from: '0xa71c3d90e5b28f4607c93d1a2b85e04f7d16c982',
      to: '0x1e4a2f7d3c9b60518a7d3f2c4b8e91d0a6c73f52',
      status: 'succeeded',
      payment_tx_hash: rows[0]!.paymentTxHash,
      started_at: '2026-09-06T09:00:00.000Z',
      ended_at: '2026-09-06T09:00:02.000Z',
      settlement_id: null,
    })
  })

  it('answers a body that parses as paymentsResponse (AD-14)', () => {
    const page = toPaymentsPage([RUN_A, RUN_B], rows, 20)
    expect(paymentsResponse.safeParse(page).success).toBe(true)
  })
})

describe('the page and its cursor', () => {
  it('orders by Run, newest first, then by Node inside the Run', () => {
    const page = toPaymentsPage([RUN_A, RUN_B], rows, 20)
    expect(page.items.map((item) => [item.run_id, item.node_type])).toEqual([
      [RUN_A, 'data'],
      [RUN_A, 'research'],
      [RUN_A, 'risk'],
      [RUN_A, 'execution'],
      [RUN_A, 'notify'],
      [RUN_B, 'data'],
      [RUN_B, 'research'],
    ])
  })

  it('sorts rows the query returned in any order', () => {
    const shuffled = [...rows].reverse()
    const page = toPaymentsPage([RUN_A, RUN_B], shuffled, 20)
    expect(page.items.map((item) => item.call_id)).toEqual(
      toPaymentsPage([RUN_A, RUN_B], rows, 20).items.map((item) => item.call_id),
    )
  })

  it('answers next = null when the extra Run is not there', () => {
    expect(toPaymentsPage([RUN_A, RUN_B], rows, 20).next).toBeNull()
  })

  /**
   * The cursor is a Run id, not a Call id: Story 5.2 prints a per-Run subtotal,
   * and a page that ended mid-Run would print one that is not the Run's cost.
   */
  it('cuts at a Run boundary and points the cursor at the last Run served', () => {
    const page = toPaymentsPage([RUN_A, RUN_B], rows, 1)
    expect(page.next).toBe(RUN_A)
    expect(new Set(page.items.map((item) => item.run_id))).toEqual(new Set([RUN_A]))
    expect(page.items).toHaveLength(paymentRows(runACalls).length)
  })

  it('never serves the extra Run, even when its rows were fetched', () => {
    const page = toPaymentsPage([RUN_A, RUN_B], rows, 1)
    expect(page.items.map((item) => item.run_id)).not.toContain(RUN_B)
  })

  it('resuming from the cursor serves the next Run and stops', () => {
    const second = toPaymentsPage([RUN_B], paymentRows(runBCalls), 1)
    expect(second.next).toBeNull()
    expect(second.items.map((item) => item.run_id)).toEqual([RUN_B, RUN_B])
  })

  it('answers an empty page, not a crash, when the account has no Run', () => {
    expect(toPaymentsPage([], [], 20)).toEqual({ items: [], next: null })
  })

  it('can serve no rows and still have a next, when the page of Runs paid nothing', () => {
    const page = toPaymentsPage([RUN_A, RUN_B], [], 1)
    expect(page).toEqual({ items: [], next: RUN_A })
  })
})

describe('the query string', () => {
  function query(search: string) {
    return parsePaymentsQuery(new URLSearchParams(search))
  }

  it('defaults to every Run, from the top of the list', () => {
    expect(query('')).toEqual({
      run_id: null,
      cursor: null,
      limit: PAYMENTS_PAGE_RUNS_DEFAULT,
    })
  })

  it('reads run_id and cursor', () => {
    expect(query(`run_id=${RUN_A}&cursor=${RUN_B}`)).toMatchObject({
      run_id: RUN_A,
      cursor: RUN_B,
    })
  })

  it('treats an empty parameter as absent, so ?run_id= is not a filter', () => {
    expect(query('run_id=&cursor=')).toMatchObject({ run_id: null, cursor: null })
  })

  it('clamps the page size instead of refusing it', () => {
    expect(query('limit=1').limit).toBe(1)
    expect(query('limit=9999').limit).toBe(PAYMENTS_PAGE_RUNS_MAX)
    expect(query('limit=0').limit).toBe(PAYMENTS_PAGE_RUNS_DEFAULT)
    expect(query('limit=nonsense').limit).toBe(PAYMENTS_PAGE_RUNS_DEFAULT)
    expect(parsePageSize(null)).toBe(PAYMENTS_PAGE_RUNS_DEFAULT)
  })
})
