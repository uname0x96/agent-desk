import { describe, expect, it, vi } from 'vitest'
import { createSettingsClient, SettingsUnavailableError, SETTINGS_PATH } from './settings.ts'

/**
 * `GET /api/internal/settings` is Story 2.2's route and does not exist yet, so
 * every case here is against the `internalSettings` schema this agent codes to.
 */

const SETTINGS = { emergency_stop: false, order_ceiling_usdt: '1000' }

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function client(fetchImpl: typeof globalThis.fetch, timeoutMs?: number) {
  return createSettingsClient({
    baseUrl: 'http://web:3000',
    token: 'test-internal-token',
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

describe('createSettingsClient', () => {
  it('calls the internal route with the bearer token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SETTINGS))
    const settings = await client(fetchImpl as never)()

    expect(settings).toEqual(SETTINGS)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`http://web:3000${SETTINGS_PATH}`)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-internal-token')
  })

  it('fails when the route answers 401', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 'unauthorized' } }, 401))
    await expect(client(fetchImpl as never)()).rejects.toThrow(SettingsUnavailableError)
  })

  it('fails when the route is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(client(fetchImpl as never)()).rejects.toThrow(/unreachable/)
  })

  it('fails when the body is off the internalSettings schema', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ emergency_stop: 'no' }))
    await expect(client(fetchImpl as never)()).rejects.toThrow(/off-schema/)
  })

  it('fails when the route outlives its deadline', async () => {
    const hanging = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as unknown as typeof globalThis.fetch
    // The same 3 s rule, shortened so the test does not wait for it.
    await expect(client(hanging, 40)()).rejects.toThrow(/timed out after 40 ms/)
  })

  it('lets the handler budget signal through rather than dressing it as a refusal', async () => {
    const hanging = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('handler budget expired')))
      })) as unknown as typeof globalThis.fetch
    const controller = new AbortController()
    const pending = client(hanging)(controller.signal)
    controller.abort()
    await expect(pending).rejects.not.toBeInstanceOf(SettingsUnavailableError)
  })
})
