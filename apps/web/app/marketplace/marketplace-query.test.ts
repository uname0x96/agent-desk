import '../../lib/test-support.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { ApiError } from '../../lib/api.ts'
import { marketplaceFixture } from '../../components/marketplace/fixtures.ts'
import {
  MARKETPLACE_POLL_MS,
  listingsPath,
  marketplaceHref,
  marketplaceQueryKey,
  marketplaceQueryOptions,
  parseView,
  type ListingsPage,
} from './marketplace-query.ts'

/**
 * Story 3.5: the list refetches every 5 s while the page is open, so a Listing
 * that turned `active` or a Reputation written on chain shows within five
 * seconds of `refreshListingFromChain`. Driven through a real QueryObserver on
 * fake timers, so the React Query wiring is what is under test.
 */

const page: ListingsPage = { items: [...marketplaceFixture], next: null }

describe('the request the page makes', () => {
  it('asks for the Type and the sort, so the route can order server-side', () => {
    expect(listingsPath({ type: 'research', sort: 'price' })).toBe(
      '/api/listings?limit=100&sort=price&type=research',
    )
  })

  it('omits the Type when the Builder is looking at every Type', () => {
    expect(listingsPath({ type: null, sort: 'reputation' })).toBe(
      '/api/listings?limit=100&sort=reputation',
    )
  })

  it('keys the cache by the view, so switching filters does not reuse a page', () => {
    expect(marketplaceQueryKey({ type: 'risk', sort: 'price' })).toEqual([
      'marketplace',
      'risk',
      'price',
    ])
    expect(marketplaceQueryKey({ type: null, sort: 'reputation' })).toEqual([
      'marketplace',
      'all',
      'reputation',
    ])
  })
})

describe('the page URL', () => {
  it('carries the filter and the sort, so a view can be linked and reloaded', () => {
    expect(marketplaceHref({ type: 'risk', sort: 'price' })).toBe('/marketplace?type=risk&sort=price')
  })

  it('stays clean at the defaults', () => {
    expect(marketplaceHref({ type: null, sort: 'reputation' })).toBe('/marketplace')
  })

  it('round-trips through parseView', () => {
    expect(parseView('risk', 'price')).toEqual({ type: 'risk', sort: 'price' })
    expect(parseView(null, null)).toEqual({ type: null, sort: 'reputation' })
    expect(parseView('nonsense', 'nonsense')).toEqual({ type: null, sort: 'reputation' })
  })
})

describe('the marketplace query on a real QueryObserver', () => {
  let client: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(() => {
    client.clear()
    vi.useRealTimers()
  })

  function observe(fetcher: () => Promise<ListingsPage>) {
    const observer = new QueryObserver(
      client,
      marketplaceQueryOptions({ type: null, sort: 'reputation' }, fetcher),
    )
    return observer.subscribe(() => {})
  }

  it('refetches every 5 s for as long as the page is open', async () => {
    const fetcher = vi.fn(async () => page)
    const unsubscribe = observe(fetcher)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(MARKETPLACE_POLL_MS)
    expect(fetcher).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(MARKETPLACE_POLL_MS * 4)
    expect(fetcher).toHaveBeenCalledTimes(6)

    unsubscribe()
  })

  it('shows a Listing that turned active within five seconds', async () => {
    const paused = { ...marketplaceFixture[0]!, status: 'paused' as const, paused_by_creator: true }
    let answered = 0
    const fetcher = vi.fn(async () => {
      answered += 1
      return answered === 1
        ? { items: [paused], next: null }
        : { items: [{ ...paused, status: 'active' as const, paused_by_creator: false }], next: null }
    })
    const unsubscribe = observe(fetcher)

    await vi.advanceTimersByTimeAsync(0)
    expect(client.getQueryData(['marketplace', 'all', 'reputation'])).toMatchObject({
      items: [{ status: 'paused' }],
    })

    await vi.advanceTimersByTimeAsync(MARKETPLACE_POLL_MS)
    expect(client.getQueryData(['marketplace', 'all', 'reputation'])).toMatchObject({
      items: [{ status: 'active' }],
    })

    unsubscribe()
  })

  it('keeps trying through a transient failure', async () => {
    const fetcher = vi.fn(async () => {
      throw new ApiError('internal_error', 'boom', 500)
    })
    const unsubscribe = observe(fetcher as unknown as () => Promise<ListingsPage>)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(MARKETPLACE_POLL_MS * 3)
    expect(fetcher).toHaveBeenCalledTimes(4)

    unsubscribe()
  })

  it('stops when the visitor is not signed in, instead of hammering the route', async () => {
    const fetcher = vi.fn(async () => {
      throw new ApiError('unauthorized', 'sign in', 401)
    })
    const unsubscribe = observe(fetcher as unknown as () => Promise<ListingsPage>)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(MARKETPLACE_POLL_MS * 10)
    expect(fetcher).toHaveBeenCalledTimes(1)

    unsubscribe()
  })
})
