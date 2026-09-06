import { describe, expect, it } from 'vitest'
import { AgentEnvError } from './errors.ts'
import { parseAgentEnv, requireEnv } from './env.ts'

const VALID = {
  AGENT_PORT: '4101',
  AGENT_PRICE: '0.01',
  AGENT_PAYTO: '0x2222222222222222222222222222222222222222',
  FACILITATOR_URL: 'http://facilitator:4020',
  INTERNAL_TOKEN: 'token',
}

describe('parseAgentEnv', () => {
  it('accepts the documented agent variables and applies the defaults', () => {
    const parsed = parseAgentEnv(VALID)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toEqual({
      AGENT_PORT: 4101,
      AGENT_PRICE: '0.01',
      AGENT_PAYTO: VALID.AGENT_PAYTO,
      FACILITATOR_URL: 'http://facilitator:4020',
      INTERNAL_TOKEN: 'token',
      CHAIN_ID: 97,
      LOG_LEVEL: 'info',
      MARKET_DATA_URL: 'https://data-api.binance.vision',
    })
  })

  it('names every missing key at once', () => {
    const parsed = parseAgentEnv({})
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues).toEqual([
      'AGENT_PORT: required',
      'AGENT_PRICE: required',
      'AGENT_PAYTO: required',
      'FACILITATOR_URL: required',
      'INTERNAL_TOKEN: required',
    ])
  })

  it('refuses a price that is not a decimal USDT string', () => {
    const parsed = parseAgentEnv({ ...VALID, AGENT_PRICE: '1,00' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues[0]).toContain('AGENT_PRICE')
  })

  it('refuses a payTo that is not an address', () => {
    const parsed = parseAgentEnv({ ...VALID, AGENT_PAYTO: '0xnope' })
    expect(parsed.ok).toBe(false)
  })

  it('refuses a port outside the TCP range and a relative facilitator URL', () => {
    expect(parseAgentEnv({ ...VALID, AGENT_PORT: '70000' }).ok).toBe(false)
    expect(parseAgentEnv({ ...VALID, FACILITATOR_URL: '/facilitator' }).ok).toBe(false)
  })

  it('strips a trailing slash from URLs', () => {
    const parsed = parseAgentEnv({
      ...VALID,
      FACILITATOR_URL: 'http://facilitator:4020/',
      MARKET_DATA_URL: 'https://data-api.binance.vision/',
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.FACILITATOR_URL).toBe('http://facilitator:4020')
    expect(parsed.value.MARKET_DATA_URL).toBe('https://data-api.binance.vision')
  })
})

describe('requireEnv', () => {
  it('returns the requested keys', () => {
    expect(requireEnv({ ANTHROPIC_API_KEY: 'sk-x' }, 'ANTHROPIC_API_KEY')).toEqual({
      ANTHROPIC_API_KEY: 'sk-x',
    })
  })

  it('throws an AgentEnvError naming every missing key', () => {
    expect(() => requireEnv({}, 'A', 'B')).toThrow(AgentEnvError)
    try {
      requireEnv({}, 'A', 'B')
    } catch (error) {
      expect((error as AgentEnvError).issues).toEqual(['A: required', 'B: required'])
    }
  })
})
