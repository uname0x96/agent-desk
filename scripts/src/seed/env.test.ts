import { describe, expect, it } from 'vitest'
import { SEED_AGENTS, seedAgent } from './agents.ts'
import { SeedEnvError, parseSeedEnv } from './env.ts'

/**
 * The seed's own environment: seven agent URLs, the web origin `--warm` starts
 * Runs against, and the Telegram chat id. No secret is read here, which is why
 * it is a module of its own rather than more of `scripts/src/env.ts`.
 */
describe('parseSeedEnv', () => {
  it('defaults every agent to its published compose port on localhost', () => {
    const env = parseSeedEnv({})
    expect(env.endpoints['binance-ticker']).toBe('http://localhost:4101')
    expect(env.endpoints['alpha-research']).toBe('http://localhost:4102')
    expect(env.endpoints['sloppy-research']).toBe('http://localhost:4103')
    expect(env.endpoints['guardrail-risk']).toBe('http://localhost:4104')
    expect(env.endpoints['spot-executor']).toBe('http://localhost:4105')
    expect(env.endpoints['telegram-notifier']).toBe('http://localhost:4106')
    expect(env.sloppyResearch2Url).toBe('http://localhost:4107')
    expect(env.webBaseUrl).toBe('http://localhost:3000')
  })

  it('has one endpoint per Seed Agent and no others', () => {
    const env = parseSeedEnv({})
    expect(Object.keys(env.endpoints).sort()).toEqual(SEED_AGENTS.map((a) => a.key).sort())
  })

  it('reads each agent from its own variable, so the worker can be given service names', () => {
    const env = parseSeedEnv({
      SEED_BINANCE_TICKER_URL: 'http://agent-binance-ticker:4101',
      SEED_ALPHA_RESEARCH_URL: 'http://agent-alpha-research:4102',
      SEED_SLOPPY_RESEARCH_2_URL: 'http://agent-sloppy-research-2:4107',
    })
    expect(env.endpoints['binance-ticker']).toBe('http://agent-binance-ticker:4101')
    expect(env.endpoints['alpha-research']).toBe('http://agent-alpha-research:4102')
    expect(env.sloppyResearch2Url).toBe('http://agent-sloppy-research-2:4107')
    // Untouched variables keep their default.
    expect(env.endpoints['guardrail-risk']).toBe('http://localhost:4104')
  })

  it('reads the variable name each Seed Agent declares', () => {
    const env = parseSeedEnv({ [seedAgent('guardrail-risk').endpointEnv]: 'https://risk.example' })
    expect(env.endpoints['guardrail-risk']).toBe('https://risk.example')
  })

  it('strips a trailing slash, so an endpoint is never listed twice under two spellings', () => {
    const env = parseSeedEnv({ SEED_WEB_BASE_URL: 'http://localhost:3000/' })
    expect(env.webBaseUrl).toBe('http://localhost:3000')
  })

  it('collects every malformed URL and names the key', () => {
    expect(() => parseSeedEnv({ SEED_ALPHA_RESEARCH_URL: 'agent-alpha-research:4102' })).toThrow(
      SeedEnvError,
    )
    try {
      parseSeedEnv({ SEED_ALPHA_RESEARCH_URL: 'not a url', SEED_WEB_BASE_URL: 'also not' })
    } catch (error) {
      expect((error as SeedEnvError).problems).toHaveLength(2)
      expect((error as SeedEnvError).problems[0]).toContain('SEED_ALPHA_RESEARCH_URL')
      expect((error as SeedEnvError).problems[1]).toContain('SEED_WEB_BASE_URL')
    }
  })
})

describe('SEED_TELEGRAM_CHAT_ID', () => {
  it('is null when it is absent or blank, which is a state the seed reports', () => {
    expect(parseSeedEnv({}).telegramChatId).toBeNull()
    expect(parseSeedEnv({ SEED_TELEGRAM_CHAT_ID: '   ' }).telegramChatId).toBeNull()
  })

  it('accepts a personal chat id and a negative group id', () => {
    expect(parseSeedEnv({ SEED_TELEGRAM_CHAT_ID: '123456789' }).telegramChatId).toBe('123456789')
    expect(parseSeedEnv({ SEED_TELEGRAM_CHAT_ID: '-1001234567890' }).telegramChatId).toBe(
      '-1001234567890',
    )
  })

  it('refuses anything that is not the integer the bot replied with', () => {
    // A pasted "@handle" or "chat id: 42" would be stored and then fail at the
    // Telegram API, which is a worse place to find out.
    for (const value of ['@builder', 'chat id: 42', '12 34', '1.5']) {
      expect(() => parseSeedEnv({ SEED_TELEGRAM_CHAT_ID: value })).toThrow(SeedEnvError)
    }
  })
})
