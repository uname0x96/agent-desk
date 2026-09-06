import { describe, expect, it } from 'vitest'
import { KeyedMutex, Mutex } from './mutex.ts'

/**
 * AD-5: one async mutex per wallet. These pin the two properties the signing
 * policy relies on — a critical section is never entered twice at once, and
 * waiters run in the order they arrived — because a policy that reads a spend
 * and then signs is only correct if nothing else can read the same spend in
 * between.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Mutex', () => {
  it('serialises overlapping critical sections', async () => {
    const mutex = new Mutex()
    const events: string[] = []

    const section = (name: string) =>
      mutex.run(async () => {
        events.push(`${name}:enter`)
        await tick()
        events.push(`${name}:exit`)
      })

    await Promise.all([section('a'), section('b'), section('c')])

    // Never `a:enter, b:enter` — every enter is followed by its own exit.
    expect(events).toEqual([
      'a:enter',
      'a:exit',
      'b:enter',
      'b:exit',
      'c:enter',
      'c:exit',
    ])
  })

  it('releases the lock when the critical section throws', async () => {
    const mutex = new Mutex()
    await expect(mutex.run(async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')

    // A leaked lock would hang here rather than fail.
    await expect(mutex.run(async () => 'second')).resolves.toBe('second')
    expect(mutex.locked).toBe(false)
  })

  it('reports that it is held while a section runs', async () => {
    const mutex = new Mutex()
    let observed = false
    await mutex.run(async () => {
      observed = mutex.locked
    })
    expect(observed).toBe(true)
    expect(mutex.locked).toBe(false)
  })
})

describe('KeyedMutex', () => {
  it('does not serialise across different wallets', async () => {
    const locks = new KeyedMutex()
    let insideA = false
    let overlapped = false

    const a = locks.run('wal_A', async () => {
      insideA = true
      await tick()
      await tick()
      insideA = false
    })
    const b = locks.run('wal_B', async () => {
      overlapped = insideA
    })

    await Promise.all([a, b])
    expect(overlapped).toBe(true)
    expect(locks.size).toBe(2)
  })

  it('serialises two sections on the same wallet', async () => {
    const locks = new KeyedMutex()
    let concurrent = 0
    let peak = 0

    const section = () =>
      locks.run('wal_A', async () => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await tick()
        concurrent -= 1
      })

    await Promise.all([section(), section(), section()])
    expect(peak).toBe(1)
    expect(locks.size).toBe(1)
  })
})
