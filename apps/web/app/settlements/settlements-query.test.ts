import '../../lib/test-support.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import type { SettlementsPage } from '@agent-desk/schemas'
import { ApiError } from '../../lib/api.ts'
import {
  SETTLEMENTS_POLL_MS,
  parseFilter,
  settlementsHref,
  settlementsPath,
  settlementsQueryKey,
  settlementsQueryOptions,
  settlementsRefetchInterval,
} from './settlements-query.ts'
import { failedRiskSlashPending, settledFixture, settlementsFixture } from './fixtures.ts'

/**
 * Story 5.3: "the page refetches every 2 s until every visible `failed` row has
 * a `slash_tx_hash`". Driven through a real QueryObserver on fake timers, so
 * the React Query wiring is what is under test rather than a restatement of it.
 */

describe('the request the page makes', () => {
  it('carries both filters, so the route can scope the read', () => {
    expect(
      settlementsPath({ runId: 'run_01K4RWZ8QY7M3B0P5X2A9TGCVD', listingId: 'lst_01K4RWY4T1B6N9C3F8H2J5MDRX' }),
    ).toBe(
      '/api/settlements?limit=100&run_id=run_01K4RWZ8QY7M3B0P5X2A9TGCVD&listing_id=lst_01K4RWY4T1B6N9C3F8H2J5MDRX',
    )
  })

  it('omits a filter the Builder did not set', () => {
    expect(settlementsPath({ runId: null, listingId: null })).toBe('/api/settlements?limit=100')
  })

  it('sends the cursor of the previous page when there is one', () => {
    expect(settlementsPath({ runId: null, listingId: null }, 'stl_01K4RX40000000000000000004')).toBe(
      '/api/settlements?limit=100&cursor=stl_01K4RX40000000000000000004',
    )
  })

  it('keys the cache by the filter, so switching Runs does not reuse a page', () => {
    expect(settlementsQueryKey({ runId: 'run_1', listingId: null })).toEqual([
      'settlements',
      'run_1',
      'all',
    ])
    expect(settlementsQueryKey({ runId: null, listingId: null })).toEqual([
      'settlements',
      'all',
      'all',
    ])
  })
})

describe('the page URL', () => {
  it('carries the filters, so a filtered list can be linked and reloaded', () => {
    expect(settlementsHref({ runId: 'run_1', listingId: 'lst_1' })).toBe(
      '/settlements?run_id=run_1&listing_id=lst_1',
    )
  })

  it('stays clean when nothing is filtered', () => {
    expect(settlementsHref({ runId: null, listingId: null })).toBe('/settlements')
  })

  it('round-trips through parseFilter, and an empty value is no filter', () => {
    expect(parseFilter('run_1', 'lst_1')).toEqual({ runId: 'run_1', listingId: 'lst_1' })
    expect(parseFilter(null, null)).toEqual({ runId: null, listingId: null })
    expect(parseFilter('', '   ')).toEqual({ runId: null, listingId: null })
  })
})

describe('the stop condition', () => {
  it('keeps the 2 s beat while a failed row is still without its slash tx', () => {
    expect(settlementsRefetchInterval(settlementsFixture)).toBe(SETTLEMENTS_POLL_MS)
  })

  it('stops once every visible failed row has a slash tx hash', () => {
    expect(settlementsRefetchInterval(settledFixture)).toBe(false)
  })

  it('stops on a page with no failed row at all', () => {
    const passedOnly: SettlementsPage = {
      items: settlementsFixture.items.filter((row) => row.result !== 'failed'),
      next: null,
    }
    expect(settlementsRefetchInterval(passedOnly)).toBe(false)
  })

  it('keeps the beat while the first answer has not arrived', () => {
    expect(settlementsRefetchInterval(undefined)).toBe(SETTLEMENTS_POLL_MS)
  })
})

describe('the settlements query on a real QueryObserver', () => {
  let client: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(() => {
    client.clear()
    vi.useRealTimers()
  })

  function observe(fetcher: () => Promise<SettlementsPage>) {
    const observer = new QueryObserver(
      client,
      settlementsQueryOptions({ runId: null, listingId: null }, fetcher),
    )
    return observer.subscribe(() => {})
  }

  it('refetches every 2 s while a Slash is pending', async () => {
    const fetcher = vi.fn(async () => settlementsFixture)
    const unsubscribe = observe(fetcher)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SETTLEMENTS_POLL_MS)
    expect(fetcher).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(SETTLEMENTS_POLL_MS * 4)
    expect(fetcher).toHaveBeenCalledTimes(6)

    unsubscribe()
  })

  it('shows the landed Slash within two seconds, then stops asking', async () => {
    let answered = 0
    const fetcher = vi.fn(async () => {
      answered += 1
      return answered === 1 ? settlementsFixture : settledFixture
    })
    const unsubscribe = observe(fetcher)

    await vi.advanceTimersByTimeAsync(0)
    const pending = client.getQueryData<SettlementsPage>(['settlements', 'all', 'all'])
    expect(pending?.items.find((row) => row.id === failedRiskSlashPending.id)?.slash_tx_hash).toBeNull()

    await vi.advanceTimersByTimeAsync(SETTLEMENTS_POLL_MS)
    const settled = client.getQueryData<SettlementsPage>(['settlements', 'all', 'all'])
    expect(settled?.items.find((row) => row.id === failedRiskSlashPending.id)?.slash_tx_hash).toMatch(
      /^0x[0-9a-f]{64}$/,
    )
    expect(fetcher).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(SETTLEMENTS_POLL_MS * 10)
    expect(fetcher).toHaveBeenCalledTimes(2)

    unsubscribe()
  })

  it('keeps trying through a transient failure', async () => {
    const fetcher = vi.fn(async () => {
      throw new ApiError('internal_error', 'boom', 500)
    })
    const unsubscribe = observe(fetcher as unknown as () => Promise<SettlementsPage>)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SETTLEMENTS_POLL_MS * 3)
    expect(fetcher).toHaveBeenCalledTimes(4)

    unsubscribe()
  })

  it('stops when the visitor is not signed in, instead of hammering the route', async () => {
    const fetcher = vi.fn(async () => {
      throw new ApiError('unauthorized', 'sign in', 401)
    })
    const unsubscribe = observe(fetcher as unknown as () => Promise<SettlementsPage>)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SETTLEMENTS_POLL_MS * 10)
    expect(fetcher).toHaveBeenCalledTimes(1)

    unsubscribe()
  })
})
