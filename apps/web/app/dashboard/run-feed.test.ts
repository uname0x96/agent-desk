import '../../lib/test-support.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { RUN_FEED_DEFAULT_LIMIT, type RunSummary } from '@agent-desk/schemas'
import { ApiError } from '../../lib/api.ts'
import {
  IDLE_POLL_MS,
  RUNNING_POLL_MS,
  runFeedPath,
  runFeedQueryOptions,
  runFeedRefetchInterval,
  type RunFeedPage,
} from './run-feed.ts'

/**
 * Story 5.1 / AD-12: the feed refetches every 2 s while any listed Run is
 * `running` and every 10 s otherwise, so a Run that has just started is at the
 * top of the page within two seconds. The interval choice is a pure function,
 * and the wiring that applies it is driven through a real QueryObserver on
 * fake timers, so both halves are under test.
 */

function run(status: string, id = 'run_01'): RunSummary {
  return {
    id,
    workflow_id: 'wf_01K4RWZ0N3F8H2S6C1E7YQAB4M',
    workflow_name: 'BNB momentum desk',
    symbol: 'BNBUSDT',
    status,
    failure_reason: null,
    wallet_address: '0xa71c3d90e5b28f4607c93d1a2b85e04f7d16c982',
    total_cost: '10000',
    created_at: '2026-09-05T02:00:00.000Z',
    started_at: '2026-09-05T02:00:01.000Z',
    ended_at: null,
    nodes: [{ node_type: 'data', status: 'succeeded' }],
  }
}

const page = (items: RunSummary[]): RunFeedPage => ({ items, next: null })

describe('the request the dashboard makes', () => {
  it('asks for the default page size', () => {
    expect(runFeedPath()).toBe(`/api/runs?limit=${RUN_FEED_DEFAULT_LIMIT}`)
  })

  it('carries a cursor when there is one, so the next page is one request away', () => {
    expect(runFeedPath(5, 'run_02')).toBe('/api/runs?limit=5&cursor=run_02')
  })
})

describe('the poll interval', () => {
  it('is 2 s while any listed Run is running', () => {
    expect(runFeedRefetchInterval(page([run('completed'), run('running', 'run_02')]))).toBe(
      RUNNING_POLL_MS,
    )
    expect(RUNNING_POLL_MS).toBe(2_000)
  })

  it('is 10 s once every listed Run has finished', () => {
    const finished = page([
      run('completed'),
      run('completed, no order', 'run_02'),
      run('failed at research', 'run_03'),
      run('timed out', 'run_04'),
    ])
    expect(runFeedRefetchInterval(finished)).toBe(IDLE_POLL_MS)
    expect(IDLE_POLL_MS).toBe(10_000)
  })

  it('is 10 s for an account with no Runs at all', () => {
    expect(runFeedRefetchInterval(page([]))).toBe(IDLE_POLL_MS)
  })

  it('is 2 s before the first page arrives, because the new Run is not in it yet', () => {
    expect(runFeedRefetchInterval(undefined)).toBe(RUNNING_POLL_MS)
  })
})

describe('the feed query on a real QueryObserver', () => {
  let client: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(() => {
    client.clear()
    vi.useRealTimers()
  })

  it('refetches on the 2 s beat while a Run is running', async () => {
    const fetcher = vi.fn().mockResolvedValue(page([run('running')]))
    const observer = new QueryObserver(client, runFeedQueryOptions(fetcher))
    const stop = observer.subscribe(() => {})

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS)
    expect(fetcher).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS)
    expect(fetcher).toHaveBeenCalledTimes(3)

    stop()
  })

  it('drops to the 10 s beat once nothing is running', async () => {
    const fetcher = vi.fn().mockResolvedValue(page([run('completed')]))
    const observer = new QueryObserver(client, runFeedQueryOptions(fetcher))
    const stop = observer.subscribe(() => {})

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS - RUNNING_POLL_MS)
    expect(fetcher).toHaveBeenCalledTimes(2)

    stop()
  })

  it('keeps asking after a reachability failure, which is what a blip needs', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('network_error', 'down', 0))
      .mockResolvedValue(page([run('running')]))
    const observer = new QueryObserver(client, runFeedQueryOptions(fetcher))
    const stop = observer.subscribe(() => {})

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS)
    expect(fetcher).toHaveBeenCalledTimes(2)

    stop()
  })

  it('stops once the answer is that there is no session', async () => {
    const fetcher = vi.fn().mockRejectedValue(new ApiError('unauthorized', 'signed out', 401))
    const observer = new QueryObserver(client, runFeedQueryOptions(fetcher))
    const stop = observer.subscribe(() => {})

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 3)
    expect(fetcher).toHaveBeenCalledTimes(1)

    stop()
  })
})
