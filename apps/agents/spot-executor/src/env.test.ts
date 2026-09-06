import { describe, expect, it } from 'vitest'
import { DEMO_BASE_URL, TESTNET_BASE_URL } from './binance-exchange.ts'
import {
  credentialKeysFor,
  exchangeModeFor,
  normalizePrivateKey,
  parseExchangeEnv,
  parseExecutorEnv,
  parseFullEnv,
} from './env.ts'

const AGENT_KEYS = {
  AGENT_PORT: '4105',
  AGENT_PRICE: '0.01',
  AGENT_PAYTO: '0x3333333333333333333333333333333333333333',
  FACILITATOR_URL: 'http://facilitator:4020',
  INTERNAL_TOKEN: 'test-internal-token',
  PLATFORM_INTERNAL_URL: 'http://web:3000',
}

const TESTNET_KEYS = {
  EXCHANGE_API_KEY: 'testnet-api-key',
  EXCHANGE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----',
}

const DEMO_KEYS = {
  EXCHANGE_DEMO_API_KEY: 'demo-api-key',
  EXCHANGE_DEMO_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nBBBB\\n-----END PRIVATE KEY-----',
}

describe('exchange mode', () => {
  it('reads Spot Demo Mode off the base URL alone', () => {
    expect(exchangeModeFor(TESTNET_BASE_URL)).toBe('testnet')
    expect(exchangeModeFor(DEMO_BASE_URL)).toBe('demo')
    expect(exchangeModeFor('https://demo-api.binance.com/')).toBe('demo')
  })

  it('names the key pair each mode reads', () => {
    expect(credentialKeysFor('testnet')).toEqual({
      apiKey: 'EXCHANGE_API_KEY',
      privateKey: 'EXCHANGE_PRIVATE_KEY',
    })
    expect(credentialKeysFor('demo')).toEqual({
      apiKey: 'EXCHANGE_DEMO_API_KEY',
      privateKey: 'EXCHANGE_DEMO_PRIVATE_KEY',
    })
  })
})

describe('parseExecutorEnv', () => {
  it('defaults to Spot Testnet and its key pair', () => {
    const parsed = parseExecutorEnv({ ...AGENT_KEYS, ...TESTNET_KEYS })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.EXCHANGE_BASE_URL).toBe(TESTNET_BASE_URL)
    expect(parsed.value.EXCHANGE_MODE).toBe('testnet')
    expect(parsed.value.EXCHANGE_API_KEY).toBe('testnet-api-key')
  })

  it('switches to Spot Demo Mode and its own key pair on EXCHANGE_BASE_URL alone', () => {
    const parsed = parseExecutorEnv({
      ...AGENT_KEYS,
      ...TESTNET_KEYS,
      ...DEMO_KEYS,
      EXCHANGE_BASE_URL: DEMO_BASE_URL,
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.EXCHANGE_BASE_URL).toBe(DEMO_BASE_URL)
    expect(parsed.value.EXCHANGE_MODE).toBe('demo')
    // The testnet pair is present and deliberately ignored.
    expect(parsed.value.EXCHANGE_API_KEY).toBe('demo-api-key')
    expect(parsed.value.EXCHANGE_PRIVATE_KEY).toContain('BBBB')
  })

  it('names the demo keys when demo mode is selected without them', () => {
    const parsed = parseExecutorEnv({
      ...AGENT_KEYS,
      ...TESTNET_KEYS,
      EXCHANGE_BASE_URL: DEMO_BASE_URL,
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues.join('\n')).toContain('EXCHANGE_DEMO_API_KEY')
    expect(parsed.issues.join('\n')).toContain('EXCHANGE_DEMO_PRIVATE_KEY')
  })

  it('unescapes a PEM carried through a dotenv file', () => {
    const parsed = parseExecutorEnv({ ...AGENT_KEYS, ...TESTNET_KEYS })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.EXCHANGE_PRIVATE_KEY.split('\n')).toHaveLength(3)
  })

  it('leaves a key file path untouched', () => {
    expect(normalizePrivateKey('/run/secrets/exchange.pem')).toBe('/run/secrets/exchange.pem')
  })

  it('checks the exchange half on its own for the doctor and the order script', () => {
    const parsed = parseExchangeEnv({ ...TESTNET_KEYS })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.EXCHANGE_MODE).toBe('testnet')
  })

  it('requires PLATFORM_INTERNAL_URL, without which every order refuses', () => {
    const parsed = parseExecutorEnv({ ...TESTNET_KEYS })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues).toContain('PLATFORM_INTERNAL_URL: required')
  })
})

describe('parseFullEnv', () => {
  it('reports the shared keys and the exchange keys in one failure', () => {
    const parsed = parseFullEnv({})
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    const text = parsed.issues.join('\n')
    expect(text).toContain('AGENT_PORT: required')
    expect(text).toContain('FACILITATOR_URL: required')
    expect(text).toContain('EXCHANGE_API_KEY')
    expect(text).toContain('PLATFORM_INTERNAL_URL: required')
  })

  it('passes with the full compose environment', () => {
    const parsed = parseFullEnv({ ...AGENT_KEYS, ...TESTNET_KEYS })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.AGENT_PORT).toBe(4105)
    expect(parsed.value.EXCHANGE_MODE).toBe('testnet')
  })
})
