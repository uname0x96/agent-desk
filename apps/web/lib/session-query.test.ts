import './test-support.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { publicSettings, type PublicSettings } from '@agent-desk/schemas'
import { ApiError } from './api.ts'
import {
  SETTINGS_POLL_INTERVAL_MS,
  isSignedOut,
  meQueryOptions,
  publicSettingsQueryOptions,
} from './session-query.ts'

/**
 * Story 2.2, last criterion: the dashboard header shows the mode and an
 * Emergency Stop badge from `GET /api/settings/public`, polled every 2 s
 * (AD-12). The poll is driven through a real QueryObserver on fake timers, so
 * the wiring is under test rather than a restatement of the policy.
 */

const PRODUCTION: PublicSettings = { mode: 'production', emergency_stop: false }
const STOPPED: PublicSettings = { mode: 'demo', emergency_stop: true }

describe('the fixtures', () => {
  it('satisfy publicSettings, so the header renders against the real contract', () => {
    expect(publicSettings.safeParse(PRODUCTION).success).toBe(true)
    expect(publicSettings.safeParse(STOPPED).success).toBe(true)
  })
})

describe('isSignedOut', () => {
  it('recognises the ordinary 401 and nothing else', () => {
    expect(isSignedOut(new ApiError('unauthorized', 'sign in first', 401))).toBe(true)
    expect(isSignedOut(new ApiError('internal_error', 'boom', 500))).toBe(false)
    expect(isSignedOut(new Error('boom'))).toBe(false)
  })
})

describe('the settings query on a real QueryObserver', () => {
  let client: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(() => {
    client.clear()
    vi.useRealTimers()
  })

  function observe(enabled: boolean, fetcher: () => Promise<PublicSettings>) {
    const observer = new QueryObserver(client, publicSettingsQueryOptions(enabled, fetcher))
    return observer.subscribe(() => {})
  }

  it('is 2 s, the same clock the Run view polls on', () => {
    expect(SETTINGS_POLL_INTERVAL_MS).toBe(2_000)
  })

  it('refetches every 2 s while there is a session', async () => {
    const fetcher = vi.fn(async () => PRODUCTION)
    const unsubscribe = observe(true, fetcher)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SETTINGS_POLL_INTERVAL_MS)
    expect(fetcher).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(SETTINGS_POLL_INTERVAL_MS)
    expect(fetcher).toHaveBeenCalledTimes(3)

    unsubscribe()
  })

  it('shows an Operator flip within one poll interval', async () => {
    let answered = 0
    const fetcher = vi.fn(async () => {
      answered += 1
      return answered === 1 ? PRODUCTION : STOPPED
    })
    const unsubscribe = observe(true, fetcher)

    await vi.advanceTimersByTimeAsync(0)
    expect(client.getQueryData(['settings', 'public'])).toEqual(PRODUCTION)

    await vi.advanceTimersByTimeAsync(SETTINGS_POLL_INTERVAL_MS)
    expect(client.getQueryData(['settings', 'public'])).toEqual(STOPPED)

    unsubscribe()
  })

  it('asks nothing at all while signed out', async () => {
    const fetcher = vi.fn(async () => PRODUCTION)
    const unsubscribe = observe(false, fetcher)

    await vi.advanceTimersByTimeAsync(SETTINGS_POLL_INTERVAL_MS * 5)
    expect(fetcher).not.toHaveBeenCalled()

    unsubscribe()
  })

  it('stops polling once the answer is 401, instead of hammering the route', async () => {
    const fetcher = vi.fn(async () => {
      throw new ApiError('unauthorized', 'sign in first', 401)
    })
    const unsubscribe = observe(true, fetcher)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SETTINGS_POLL_INTERVAL_MS * 10)
    expect(fetcher).toHaveBeenCalledTimes(1)

    unsubscribe()
  })
})

describe('the me query', () => {
  it('does not retry a 401, so a signed-out header settles at once', () => {
    const options = meQueryOptions()
    expect(options.retry(0, new ApiError('unauthorized', 'sign in first', 401))).toBe(false)
    expect(options.retry(0, new ApiError('internal_error', 'boom', 500))).toBe(true)
  })
})
