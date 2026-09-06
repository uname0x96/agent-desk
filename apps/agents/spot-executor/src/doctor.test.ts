import { describe, expect, it, vi } from 'vitest'
import { DEMO_BASE_URL, TESTNET_BASE_URL } from './binance-exchange.ts'
import { checkExchangeBalance, checkExchangeHosts, pingExchangeHost } from './doctor.ts'

/**
 * The checks `scripts/src/doctor.ts` imports. Nothing here reaches Binance:
 * `pingExchangeHost` takes a `fetchImpl`, and the balance check without
 * credentials is exactly the case the demo laptop is in today.
 */

function okFetch() {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }))
}

describe('pingExchangeHost', () => {
  it('passes on a 200 from /api/v3/ping', async () => {
    const fetchImpl = okFetch()
    const check = await pingExchangeHost(TESTNET_BASE_URL, { fetchImpl: fetchImpl as never })

    expect(check).toEqual({ name: 'exchange testnet.binance.vision', ok: true, detail: 'reachable' })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://testnet.binance.vision/api/v3/ping')
  })

  it('fails with the status rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }))
    const check = await pingExchangeHost(DEMO_BASE_URL, { fetchImpl: fetchImpl as never })
    expect(check).toMatchObject({ ok: false, detail: 'answered 503' })
  })

  it('fails with the reason rather than throwing when the host is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const check = await pingExchangeHost(TESTNET_BASE_URL, { fetchImpl: fetchImpl as never })
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('unreachable')
  })

  it('keeps every name inside the doctor 34-character column', async () => {
    const checks = await checkExchangeHosts({ fetchImpl: okFetch() as never })
    expect(checks.map((check) => check.name)).toEqual([
      'exchange testnet.binance.vision',
      'exchange demo-api.binance.com',
    ])
    for (const check of checks) expect(check.name.length).toBeLessThanOrEqual(34)
  })
})

describe('checkExchangeBalance', () => {
  it('fails naming the missing key when no credentials are configured', async () => {
    // Exactly the state of this repository today: the key pair is empty.
    const check = await checkExchangeBalance({})

    expect(check).toMatchObject({ name: 'platform exchange account USDT', ok: false })
    expect(check.detail).toContain('EXCHANGE_API_KEY')
    expect(check.name.length).toBeLessThanOrEqual(34)
  })

  it('names the demo key when demo mode is configured without one', async () => {
    const check = await checkExchangeBalance({ EXCHANGE_BASE_URL: DEMO_BASE_URL })
    expect(check.detail).toContain('EXCHANGE_DEMO_API_KEY')
  })

  it('does not send the reader after PLATFORM_INTERNAL_URL, which it never reads', async () => {
    const check = await checkExchangeBalance({})
    expect(check.detail).not.toContain('PLATFORM_INTERNAL_URL')
  })
})
