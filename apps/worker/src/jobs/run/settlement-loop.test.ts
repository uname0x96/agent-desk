import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MODE_CONSTANTS } from '@agent-desk/core/mode'
import { startPollingLoop } from './settlement-loop.ts'

/**
 * AD-9's `setTimeout` chain, on fake timers.
 *
 * The database side of the loop is in `settlement-loop.integration.test.ts`;
 * this file is about the timer, because the three things that make it a chain
 * rather than an interval are timing properties and nothing else:
 *
 *   - the next sleep is whatever the tick just asked for, so the mode read at
 *     tick time governs the wait and nothing caches it (AD-10);
 *   - the next tick is scheduled only after the last one settles, so a slow
 *     sweep can never overlap the one behind it;
 *   - a throwing tick does not end the chain.
 */

const DEMO = MODE_CONSTANTS.demo.settlementPollMs
const PRODUCTION = MODE_CONSTANTS.production.settlementPollMs

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Lets the pending microtasks of one tick run before the timers move on. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('the polling loop', () => {
  it('runs the first tick at once, so a booting worker sweeps before it waits', async () => {
    const tick = vi.fn(() => Promise.resolve(PRODUCTION))

    const stop = startPollingLoop({ tick, fallbackSleepMs: PRODUCTION })
    await settle()

    expect(tick).toHaveBeenCalledTimes(1)
    stop()
  })

  it('sleeps exactly what the tick asked for', async () => {
    const tick = vi.fn(() => Promise.resolve(DEMO))
    const stop = startPollingLoop({ tick, fallbackSleepMs: PRODUCTION })
    await settle()

    await vi.advanceTimersByTimeAsync(DEMO - 1)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(tick).toHaveBeenCalledTimes(2)

    stop()
  })

  it('honours a mode flip on the next iteration, caching nothing', async () => {
    // AD-10: the Operator moves `platform_settings.mode` from production to
    // demo, and the loop speeds from a minute to two seconds without a restart.
    const sleeps = [PRODUCTION, DEMO, DEMO]
    const tick = vi.fn(() => Promise.resolve(sleeps.shift() ?? DEMO))
    const stop = startPollingLoop({ tick, fallbackSleepMs: PRODUCTION })
    await settle()

    await vi.advanceTimersByTimeAsync(PRODUCTION)
    expect(tick).toHaveBeenCalledTimes(2)
    // The second tick read `demo`, so the third comes two seconds later.
    await vi.advanceTimersByTimeAsync(DEMO)
    expect(tick).toHaveBeenCalledTimes(3)

    stop()
  })

  it('never overlaps two ticks, however long one runs', async () => {
    let running = 0
    let overlapped = false
    const tick = vi.fn(async () => {
      running += 1
      if (running > 1) overlapped = true
      // Four poll intervals inside one tick: an interval would have fired three
      // more by now.
      await vi.advanceTimersByTimeAsync(DEMO * 4)
      running -= 1
      return DEMO
    })

    const stop = startPollingLoop({ tick, fallbackSleepMs: DEMO })
    await vi.advanceTimersByTimeAsync(DEMO * 10)

    expect(overlapped).toBe(false)
    stop()
  })

  it('keeps ticking after a tick throws, and reports it', async () => {
    const errors: unknown[] = []
    let call = 0
    const tick = vi.fn(() => {
      call += 1
      if (call === 1) return Promise.reject(new Error('the database is restarting'))
      return Promise.resolve(DEMO)
    })

    const stop = startPollingLoop({
      tick,
      fallbackSleepMs: DEMO,
      onError: (error) => errors.push(error),
    })
    await settle()

    expect(errors).toHaveLength(1)
    // The chain survived: the failed tick fell back to the given sleep.
    await vi.advanceTimersByTimeAsync(DEMO)
    expect(tick).toHaveBeenCalledTimes(2)

    stop()
  })

  it('stops on demand and schedules nothing more', async () => {
    const tick = vi.fn(() => Promise.resolve(DEMO))
    const stop = startPollingLoop({ tick, fallbackSleepMs: DEMO })
    await settle()
    expect(tick).toHaveBeenCalledTimes(1)

    stop()

    await vi.advanceTimersByTimeAsync(DEMO * 10)
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('schedules nothing when it is stopped while a tick is in flight', async () => {
    // Assigned synchronously by the executor, which TypeScript cannot see, so
    // the binding is declared rather than narrowed from `null`.
    let release!: () => void
    const inFlight = new Promise<void>((resolve) => {
      release = resolve
    })
    const tick = vi.fn(async () => {
      await inFlight
      return DEMO
    })

    const stop = startPollingLoop({ tick, fallbackSleepMs: DEMO })
    await settle()
    stop()
    release()
    await settle()

    await vi.advanceTimersByTimeAsync(DEMO * 10)
    expect(tick).toHaveBeenCalledTimes(1)
  })
})
