import { describe, expect, it } from 'vitest'
import { parseNotifierEnv } from './env.ts'

const VALID = {
  AGENT_PORT: '4106',
  AGENT_PRICE: '0.005',
  AGENT_PAYTO: '0x2222222222222222222222222222222222222222',
  FACILITATOR_URL: 'http://facilitator:4020',
  INTERNAL_TOKEN: 'token',
  TELEGRAM_BOT_TOKEN: '7000000001:AAH-fake-token-for-tests',
}

describe('parseNotifierEnv', () => {
  it('accepts the compose variables and applies the defaults', () => {
    const parsed = parseNotifierEnv({ ...VALID, AGENT_TELEGRAM_POLL: 'true' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toMatchObject({
      AGENT_PORT: 4106,
      AGENT_PRICE: '0.005',
      CHAIN_ID: 97,
      TELEGRAM_BOT_TOKEN: VALID.TELEGRAM_BOT_TOKEN,
      AGENT_TELEGRAM_POLL: true,
      EXPLORER_URL: 'https://testnet.bscscan.com',
    })
  })

  it('leaves long polling off when AGENT_TELEGRAM_POLL is absent (AD-12: compose sets it)', () => {
    const parsed = parseNotifierEnv(VALID)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.AGENT_TELEGRAM_POLL).toBe(false)
  })

  it('refuses to boot without TELEGRAM_BOT_TOKEN', () => {
    const parsed = parseNotifierEnv({ ...VALID, TELEGRAM_BOT_TOKEN: '' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues).toContain('TELEGRAM_BOT_TOKEN: required')
  })

  it('refuses a token that is not <bot_id>:<secret>', () => {
    const parsed = parseNotifierEnv({ ...VALID, TELEGRAM_BOT_TOKEN: '@agentdesk_demo_bot' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues).toEqual([
      'TELEGRAM_BOT_TOKEN: must look like <bot_id>:<secret> from BotFather',
    ])
  })

  it('names every failed key at once, shared and agent-specific together', () => {
    const parsed = parseNotifierEnv({ AGENT_TELEGRAM_POLL: 'maybe', EXPLORER_URL: 'nope' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues).toEqual([
      'AGENT_PORT: required',
      'AGENT_PRICE: required',
      'AGENT_PAYTO: required',
      'FACILITATOR_URL: required',
      'INTERNAL_TOKEN: required',
      'TELEGRAM_BOT_TOKEN: required',
      'AGENT_TELEGRAM_POLL: must be true or false, got maybe',
      'EXPLORER_URL: must be an absolute URL, got nope',
    ])
  })

  it('strips a trailing slash from EXPLORER_URL', () => {
    const parsed = parseNotifierEnv({ ...VALID, EXPLORER_URL: 'https://explorer.example.com/' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.EXPLORER_URL).toBe('https://explorer.example.com')
  })
})
