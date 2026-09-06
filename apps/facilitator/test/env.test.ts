import { describe, expect, it } from 'vitest'
import { DEFAULT_FACILITATOR_PORT, parseFacilitatorEnv } from '../src/env.ts'

const RELAYER_KEY = `0x${'11'.repeat(32)}`

function base(): NodeJS.ProcessEnv {
  return {
    CHAIN_ID: '97',
    RPC_URLS: 'https://a.example/rpc, https://b.example/rpc',
    FACILITATOR_RELAYER_KEY: RELAYER_KEY,
    FACILITATOR_PORT: '4020',
    FACILITATOR_URL: 'http://facilitator:4020',
  }
}

describe('parseFacilitatorEnv', () => {
  it('accepts a complete environment and splits RPC_URLS', () => {
    const result = parseFacilitatorEnv(base())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.env.chainId).toBe(97)
    expect(result.env.rpcUrls).toEqual(['https://a.example/rpc', 'https://b.example/rpc'])
    expect(result.env.relayerKey).toBe(RELAYER_KEY)
    expect(result.env.port).toBe(4020)
    expect(result.env.facilitatorUrl).toBe('http://facilitator:4020')
  })

  it('defaults the port and derives a facilitator URL from it', () => {
    const { FACILITATOR_PORT: _port, FACILITATOR_URL: _url, ...rest } = base()
    const result = parseFacilitatorEnv(rest)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.env.port).toBe(DEFAULT_FACILITATOR_PORT)
    expect(result.env.facilitatorUrl).toBe(`http://localhost:${DEFAULT_FACILITATOR_PORT}`)
  })

  it('names every failing key at once', () => {
    const result = parseFacilitatorEnv({ CHAIN_ID: '1', RPC_URLS: '', FACILITATOR_RELAYER_KEY: 'nope' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toHaveLength(3)
    expect(result.issues.join('\n')).toContain('CHAIN_ID')
    expect(result.issues.join('\n')).toContain('RPC_URLS')
    expect(result.issues.join('\n')).toContain('FACILITATOR_RELAYER_KEY')
  })

  it('rejects a missing relayer key', () => {
    const { FACILITATOR_RELAYER_KEY: _key, ...rest } = base()
    const result = parseFacilitatorEnv(rest)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]).toContain('FACILITATOR_RELAYER_KEY')
  })

  it('rejects a non-http RPC entry', () => {
    const result = parseFacilitatorEnv({ ...base(), RPC_URLS: 'wss://a.example/rpc' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]).toContain('is not an http(s) URL')
  })

  it('rejects a chain other than 97', () => {
    const result = parseFacilitatorEnv({ ...base(), CHAIN_ID: '56' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]).toContain('only serves chain 97')
  })
})
