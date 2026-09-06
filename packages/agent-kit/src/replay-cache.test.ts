import { describe, expect, it } from 'vitest'
import { ReplayCache, REPLAY_TTL_MS } from './replay-cache.ts'

describe('ReplayCache', () => {
  it('runs the factory once and replays the value', async () => {
    let calls = 0
    const cache = new ReplayCache<number>()
    const factory = async () => {
      calls += 1
      return 42
    }

    await expect(cache.run('sig', factory)).resolves.toEqual({ value: 42, cached: false })
    await expect(cache.run('sig', factory)).resolves.toEqual({ value: 42, cached: true })
    expect(calls).toBe(1)
  })

  it('collapses concurrent duplicates onto one in-flight attempt', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cache = new ReplayCache<string>()
    const factory = async () => {
      calls += 1
      await gate
      return 'once'
    }

    const both = Promise.all([cache.run('sig', factory), cache.run('sig', factory)])
    release?.()
    const [first, second] = await both

    expect(calls).toBe(1)
    expect(first).toEqual({ value: 'once', cached: false })
    expect(second).toEqual({ value: 'once', cached: true })
  })

  it('never caches a rejected attempt', async () => {
    let calls = 0
    const cache = new ReplayCache<string>()
    const factory = async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return 'recovered'
    }

    await expect(cache.run('sig', factory)).rejects.toThrow('boom')
    expect(cache.size).toBe(0)
    await expect(cache.run('sig', factory)).resolves.toEqual({
      value: 'recovered',
      cached: false,
    })
    expect(calls).toBe(2)
  })

  it('propagates a rejected in-flight attempt to the concurrent duplicate', async () => {
    const cache = new ReplayCache<string>()
    const factory = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      throw new Error('boom')
    }
    const first = cache.run('sig', factory)
    const second = cache.run('sig', factory)
    await expect(first).rejects.toThrow('boom')
    await expect(second).rejects.toThrow('boom')
  })

  it('keeps an entry for five minutes and drops it after', async () => {
    let now = 1_000
    let calls = 0
    const cache = new ReplayCache<number>({ now: () => now })
    const factory = async () => {
      calls += 1
      return calls
    }

    await cache.run('sig', factory)
    now += REPLAY_TTL_MS - 1
    await expect(cache.run('sig', factory)).resolves.toEqual({ value: 1, cached: true })

    now += 2
    await expect(cache.run('sig', factory)).resolves.toEqual({ value: 2, cached: false })
    expect(calls).toBe(2)
  })

  it('keys attempts by payment signature', async () => {
    let calls = 0
    const cache = new ReplayCache<number>()
    const factory = async () => {
      calls += 1
      return calls
    }
    await cache.run('sig-a', factory)
    await cache.run('sig-b', factory)
    expect(calls).toBe(2)
    expect(cache.size).toBe(2)
  })

  it('bounds retained entries', async () => {
    const cache = new ReplayCache<number>({ maxEntries: 2 })
    for (const key of ['a', 'b', 'c']) await cache.run(key, async () => 1)
    expect(cache.size).toBe(2)
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.peek('c')).toBe(1)
  })
})
