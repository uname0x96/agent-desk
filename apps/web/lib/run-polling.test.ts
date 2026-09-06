import './test-support.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { runResponse, type RunResponse } from '@agent-desk/schemas'
import { ApiError } from './api.ts'
import { completedRunFixture, runningRunFixture } from './fixtures/run.ts'
import { POLL_INTERVAL_MS, runQueryOptions, runRefetchInterval, shouldKeepPolling } from './run-polling.ts'

/**
 * AD-12: the Run view polls every 2 s while the Run is `running` and stops
 * once it is not. The behaviour is driven through a real QueryObserver on fake
 * timers, so it is the actual React Query wiring under test, not a restatement
 * of the policy.
 */

describe('the fixtures', () => {
  it('satisfy runResponse, so the page renders against the real contract', () => {
    expect(runResponse.safeParse(runningRunFixture).success).toBe(true)
    expect(runResponse.safeParse(completedRunFixture).success).toBe(true)
  })
})

describe('runRefetchInterval', () => {
  it('polls every 2 s before the first answer arrives', () => {
    expect(runRefetchInterval(undefined)).toBe(2_000)
    expect(POLL_INTERVAL_MS).toBe(2_000)
  })

  it('polls every 2 s while the Run is running', () => {
    expect(runRefetchInterval(runningRunFixture)).toBe(2_000)
  })

  it.each(['completed', 'completed, no order', 'timed out', 'failed at data'])(
    'stops once the Run is %s',
    (status) => {
      expect(runRefetchInterval({ ...runningRunFixture, status })).toBe(false)
    },
  )
})

describe('shouldKeepPolling', () => {
  it('gives up on a Run that cannot be reached by asking again', () => {
    expect(shouldKeepPolling(new ApiError('not_found', 'no such Run', 404))).toBe(false)
    expect(shouldKeepPolling(new ApiError('unauthorized', 'sign in', 401))).toBe(false)
    expect(shouldKeepPolling(new ApiError('forbidden', 'not yours', 403))).toBe(false)
  })

  it('keeps trying through a transient failure', () => {
    expect(shouldKeepPolling(new ApiError('network_error', 'offline', 0))).toBe(true)
    expect(shouldKeepPolling(new ApiError('internal_error', 'boom', 500))).toBe(true)
  })
})

describe('the run query on a real QueryObserver', () => {
  let client: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(() => {
    client.clear()
    vi.useRealTimers()
  })

  function observe(fetcher: (runId: string) => Promise<RunResponse>) {
    const observer = new QueryObserver(client, runQueryOptions('run_test', fetcher))
    const unsubscribe = observer.subscribe(() => {})
    return unsubscribe
  }

  it('refetches every 2 s while the Run is running', async () => {
    const fetcher = vi.fn(async () => runningRunFixture)
    const unsubscribe = observe(fetcher)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(fetcher).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(fetcher).toHaveBeenCalledTimes(3)

    unsubscribe()
  })

  it('shows a status change within two seconds and then stops polling', async () => {
    let answered = 0
    const fetcher = vi.fn(async () => {
      answered += 1
      return answered <= 2 ? runningRunFixture : completedRunFixture
    })
    const unsubscribe = observe(fetcher)

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(client.getQueryData(['run', 'run_test'])).toMatchObject({ status: 'running' })

    // The third answer is the terminal one; it lands one poll interval later.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(client.getQueryData(['run', 'run_test'])).toMatchObject({ status: 'completed' })

    // And nothing is asked again, however long the page stays open.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 20)
    expect(fetcher).toHaveBeenCalledTimes(3)

    unsubscribe()
  })

  it('never polls a Run that was already finished when the page opened', async () => {
    const fetcher = vi.fn(async () => completedRunFixture)
    const unsubscribe = observe(fetcher)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10)
    expect(fetcher).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it('stops polling a Run that does not exist', async () => {
    const fetcher = vi.fn(async () => {
      throw new ApiError('not_found', 'no such Run', 404)
    })
    const unsubscribe = observe(fetcher as unknown as () => Promise<RunResponse>)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10)
    expect(fetcher).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it('keeps polling through a transient failure', async () => {
    let answered = 0
    const fetcher = vi.fn(async () => {
      answered += 1
      if (answered === 1) throw new ApiError('internal_error', 'boom', 500)
      return runningRunFixture
    })
    const unsubscribe = observe(fetcher)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(client.getQueryData(['run', 'run_test'])).toMatchObject({ status: 'running' })

    unsubscribe()
  })
})
