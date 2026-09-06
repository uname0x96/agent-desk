import { describe, expect, it } from 'vitest'
import { ApiError, apiFetch, errorMessage } from './api.ts'
import { runResponse } from '@agent-desk/schemas'
import { z } from 'zod'

/** The typed fetch helper: schema-parsed answers, envelope-shaped failures. */

function stubFetch(response: Response | (() => Promise<never>)) {
  const original = globalThis.fetch
  globalThis.fetch = (typeof response === 'function'
    ? response
    : async () => response.clone()) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

const okBody = z.object({ ok: z.boolean() })

describe('apiFetch', () => {
  it('parses the answer with the schema that defines it', async () => {
    const restore = stubFetch(
      new Response(JSON.stringify({ ok: true, extra: 'stripped' }), { status: 200 }),
    )
    await expect(apiFetch('/api/health', okBody)).resolves.toEqual({ ok: true })
    restore()
  })

  it('raises the shared envelope code, not the status', async () => {
    const restore = stubFetch(
      new Response(JSON.stringify({ error: { code: 'refused_budget', message: 'short by 0.02' } }), {
        status: 409,
      }),
    )
    await expect(apiFetch('/api/runs', okBody)).rejects.toMatchObject({
      code: 'refused_budget',
      message: 'short by 0.02',
      status: 409,
    })
    restore()
  })

  it('falls back to the status when there is no envelope, so a 404 is still not_found', async () => {
    const restore = stubFetch(new Response('<html>404</html>', { status: 404 }))
    await expect(apiFetch('/api/runs/nope', runResponse)).rejects.toMatchObject({
      code: 'not_found',
    })
    restore()
  })

  it('refuses an answer that does not match its schema', async () => {
    const restore = stubFetch(new Response(JSON.stringify({ ok: 'yes' }), { status: 200 }))
    await expect(apiFetch('/api/health', okBody)).rejects.toMatchObject({
      code: 'malformed_response',
    })
    restore()
  })

  it('reports an unreachable server as a network error', async () => {
    const restore = stubFetch(async () => {
      throw new TypeError('failed to fetch')
    })
    await expect(apiFetch('/api/health', okBody)).rejects.toMatchObject({ code: 'network_error' })
    restore()
  })
})

describe('errorMessage', () => {
  it('prefers the message the API sent', () => {
    expect(errorMessage(new ApiError('not_found', 'no such Run', 404))).toBe('no such Run')
    expect(errorMessage('something odd')).toBe('Something went wrong.')
  })
})
