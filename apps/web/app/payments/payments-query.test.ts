import '../../lib/test-support.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import type { PaymentsResponse } from '@agent-desk/schemas'
import { ApiError } from '../../lib/api.ts'
import { toPaymentView } from '../api/payments/payments-model.ts'
import { RUN_A, callFixtures, paymentRows } from './fixtures.ts'
import {
  PAYMENTS_IDLE_POLL_MS,
  PAYMENTS_LIVE_POLL_MS,
  PAYMENTS_PAGE_SIZE,
  paymentsHref,
  paymentsPath,
  paymentsQueryKey,
  paymentsQueryOptions,
  paymentsRefetchInterval,
  parsePaymentsView,
} from './payments-query.ts'

/**
 * AD-12: the page polls, nothing pushes. A payment that lands mid-Run has to
 * show its hash without a reload, so the beat is 2 s while any row is
 * `paid_awaiting_result` and slow otherwise. Driven through a real
 * QueryObserver on fake timers, so the React Query wiring is what is tested.
 */

const settled: PaymentsResponse = {
  items: paymentRows(callFixtures).map(toPaymentView),
  next: null,
}
const inFlight: PaymentsResponse = {
  items: settled.items.map((item, index) =>
    index === 0 ? { ...item, status: 'paid_awaiting_result' as const, payment_tx_hash: null } : item,
  ),
  next: null,
}

describe('the request the page makes', () => {
  it('asks for a page of Runs', () => {
    expect(paymentsPath({ runId: null })).toBe(`/api/payments?limit=${PAYMENTS_PAGE_SIZE}`)
  })

  it('carries ?run_id= when the view is narrowed to one Run', () => {
    expect(paymentsPath({ runId: RUN_A })).toBe(
      `/api/payments?limit=${PAYMENTS_PAGE_SIZE}&run_id=${RUN_A}`,
    )
  })

  it('keys the cache by the view, so a filtered page does not reuse the full one', () => {
    expect(paymentsQueryKey({ runId: null })).toEqual(['payments', 'all'])
    expect(paymentsQueryKey({ runId: RUN_A })).toEqual(['payments', RUN_A])
  })

  it('round-trips the page URL', () => {
    expect(paymentsHref(null)).toBe('/payments')
    expect(paymentsHref(RUN_A)).toBe(`/payments?run_id=${RUN_A}`)
    expect(parsePaymentsView(RUN_A)).toEqual({ runId: RUN_A })
    expect(parsePaymentsView('')).toEqual({ runId: null })
    expect(parsePaymentsView(null)).toEqual({ runId: null })
  })
})

describe('the poll interval', () => {
  it('is 2 s while a payment is in flight', () => {
    expect(paymentsRefetchInterval(inFlight)).toBe(PAYMENTS_LIVE_POLL_MS)
  })

  it('drops to 10 s once every payment has settled or failed', () => {
    expect(paymentsRefetchInterval(settled)).toBe(PAYMENTS_IDLE_POLL_MS)
  })

  it('starts on the fast beat before the first answer', () => {
    expect(paymentsRefetchInterval(undefined)).toBe(PAYMENTS_LIVE_POLL_MS)
  })
})

describe('the payments query on a real QueryObserver', () => {
  let client: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(() => {
    client.clear()
    vi.useRealTimers()
  })

  function observe(fetcher: () => Promise<PaymentsResponse>) {
    const observer = new QueryObserver(client, paymentsQueryOptions({ runId: null }, fetcher))
    return observer.subscribe(() => {})
  }

  it('shows a hash that landed within two seconds of it settling', async () => {
    let answered = 0
    const fetcher = vi.fn(async () => {
      answered += 1
      return answered === 1 ? inFlight : settled
    })
    const unsubscribe = observe(fetcher)

    const firstRow = () =>
      (client.getQueryData(['payments', 'all']) as PaymentsResponse).items[0]

    await vi.advanceTimersByTimeAsync(0)
    expect(firstRow()).toMatchObject({ status: 'paid_awaiting_result', payment_tx_hash: null })

    await vi.advanceTimersByTimeAsync(PAYMENTS_LIVE_POLL_MS)
    expect(firstRow()).toMatchObject({ status: 'succeeded' })
    expect(fetcher).toHaveBeenCalledTimes(2)

    // Nothing is in flight any more, so the next beat is the slow one.
    await vi.advanceTimersByTimeAsync(PAYMENTS_LIVE_POLL_MS)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(PAYMENTS_IDLE_POLL_MS)
    expect(fetcher).toHaveBeenCalledTimes(3)

    unsubscribe()
  })

  it('stops when the visitor is not signed in, instead of hammering the route', async () => {
    const fetcher = vi.fn(async () => {
      throw new ApiError('unauthorized', 'sign in', 401)
    })
    const unsubscribe = observe(fetcher as unknown as () => Promise<PaymentsResponse>)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(PAYMENTS_IDLE_POLL_MS * 5)
    expect(fetcher).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it('keeps trying through a transient failure', async () => {
    const fetcher = vi.fn(async () => {
      throw new ApiError('internal_error', 'boom', 500)
    })
    const unsubscribe = observe(fetcher as unknown as () => Promise<PaymentsResponse>)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(PAYMENTS_LIVE_POLL_MS * 2)
    expect(fetcher).toHaveBeenCalledTimes(3)

    unsubscribe()
  })
})
