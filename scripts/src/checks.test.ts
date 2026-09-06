import { describe, expect, it } from 'vitest'
import {
  checkFloors,
  checkPublicBaseUrl,
  checkWorkerHeartbeat,
  classifyPublicBaseUrl,
  failures,
  formatChecks,
  probeRpc,
  WORKER_HEARTBEAT_MAX_AGE_MS,
} from './checks.ts'

describe('checkFloors', () => {
  const target = { label: 'Platform Wallet', address: '0xabc', floorBnb: '0.05' }

  it('passes at the floor and fails below it, naming the shortfall', async () => {
    const [atFloor] = await checkFloors([target], async () => 50_000_000_000_000_000n)
    expect(atFloor?.ok).toBe(true)

    const [below] = await checkFloors([target], async () => 49_000_000_000_000_000n)
    expect(below?.ok).toBe(false)
    expect(below?.detail).toContain('short 0.001 BNB')
  })

  it('turns an unreadable balance into a failed check rather than a throw', async () => {
    const [check] = await checkFloors([target], async () => {
      throw new Error('RPC down')
    })
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('RPC down')
  })
})

describe('checkWorkerHeartbeat', () => {
  const now = new Date('2026-09-06T12:00:00Z')

  it('fails when the worker has never run', () => {
    expect(checkWorkerHeartbeat(null, now).ok).toBe(false)
  })

  it('accepts a beat inside the window and refuses one outside it', () => {
    const inside = new Date(now.getTime() - WORKER_HEARTBEAT_MAX_AGE_MS + 1_000)
    const outside = new Date(now.getTime() - WORKER_HEARTBEAT_MAX_AGE_MS - 1_000)
    expect(checkWorkerHeartbeat(inside, now).ok).toBe(true)
    expect(checkWorkerHeartbeat(outside, now).ok).toBe(false)
  })
})

describe('classifyPublicBaseUrl', () => {
  it.each([
    ['', 'empty'],
    ['http://localhost:3000', 'loopback'],
    ['http://127.0.0.1:3000', 'loopback'],
    ['http://[::1]:3000', 'loopback'],
    ['https://abc-def.trycloudflare.com', 'trycloudflare'],
    ['http://web:3000', 'docker-internal'],
    ['http://host.docker.internal:3000', 'docker-internal'],
    ['https://agentdesk.example.com', 'public'],
    ['not a url', 'unparsable'],
  ])('classifies %s as %s', (url, expected) => {
    expect(classifyPublicBaseUrl(url)).toBe(expected)
  })
})

describe('checkPublicBaseUrl', () => {
  it('only fails once an identity is on chain', () => {
    expect(checkPublicBaseUrl('http://localhost:3000', 0).ok).toBe(true)
    expect(checkPublicBaseUrl('http://localhost:3000', 1).ok).toBe(false)
  })

  it('accepts an unset value as the AD-2 data: URI fallback', () => {
    const check = checkPublicBaseUrl('', 3)
    expect(check.ok).toBe(true)
    expect(check.detail).toContain('data: URI')
  })

  it('accepts a public host with identities on chain', () => {
    expect(checkPublicBaseUrl('https://agentdesk.example.com', 3).ok).toBe(true)
  })
})

describe('probeRpc', () => {
  it('fails a node that serves another chain', async () => {
    const check = await probeRpc('http://127.0.0.1:1/never', 97, 50)
    expect(check.ok).toBe(false)
  })
})

describe('formatting', () => {
  it('marks each line PASS or FAIL and counts the failures', () => {
    const checks = [
      { name: 'a', ok: true, detail: 'fine' },
      { name: 'b', ok: false, detail: 'broken' },
    ]
    expect(formatChecks(checks)).toContain('PASS')
    expect(formatChecks(checks)).toContain('FAIL')
    expect(failures(checks)).toHaveLength(1)
  })
})
