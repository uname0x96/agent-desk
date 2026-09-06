import { describe, expect, it } from 'vitest'
import { isId, toBaseUnits } from '@agent-desk/schemas'
import {
  SEED_AGENTS,
  SEED_AGENT_KEYS,
  SLOPPY_RESEARCH_2,
  assertSeedAgents,
  formatSeedAgentVerdicts,
  seedAgent,
  unhealthySeedAgents,
  type ListedAgentRow,
} from './agents.ts'

/**
 * The PRD addendum §2 table, transcribed here a second time on purpose.
 *
 * `agents.ts` is what the seed lists from; this is what the addendum says. If
 * someone changes a price in one place the two stop matching and this test
 * fails, which is the only mechanism the repository has for keeping a normative
 * document and a constant in step — `scripts` cannot import the addendum, and
 * the addendum cannot import `scripts`.
 */
const ADDENDUM_2 = [
  { name: 'Binance Ticker', type: 'data', price: '0.01' },
  { name: 'Alpha Research', type: 'research', price: '0.05' },
  { name: 'Sloppy Research', type: 'research', price: '0.03' },
  { name: 'Guardrail Risk', type: 'risk', price: '0.02' },
  { name: 'Binance Spot Executor', type: 'execution', price: '0.01' },
  { name: 'Telegram Notifier', type: 'notify', price: '0.005' },
] as const

/** The compose services and their published ports, from `docker-compose.yml`. */
const COMPOSE_PORTS = {
  'binance-ticker': 4101,
  'alpha-research': 4102,
  'sloppy-research': 4103,
  'guardrail-risk': 4104,
  'spot-executor': 4105,
  'telegram-notifier': 4106,
} as const

function listed(price: string, over: Partial<ListedAgentRow> = {}): ListedAgentRow {
  return {
    status: 'active',
    price: toBaseUnits(price).toString(),
    type: 'research',
    ...over,
  }
}

/** Every Seed Agent `active` at its addendum §2 price. */
function allActive(): Map<string, ListedAgentRow> {
  return new Map(
    SEED_AGENTS.map((agent) => [
      agent.listingId,
      listed(agent.priceUsdt, { type: agent.type }),
    ]),
  )
}

describe('the six Seed Agents', () => {
  it('are the PRD addendum §2 table, name, Type and price', () => {
    expect(SEED_AGENTS.map((agent) => ({
      name: agent.name,
      type: agent.type,
      price: agent.priceUsdt,
    }))).toEqual(ADDENDUM_2.map((row) => ({ ...row })))
  })

  it('stakes exactly ten times the price, the Registry minimum', () => {
    for (const agent of SEED_AGENTS) {
      expect(toBaseUnits(agent.stakeUsdt)).toBe(toBaseUnits(agent.priceUsdt) * 10n)
    }
  })

  it('costs 0.095 tUSD with Alpha Research and 0.075 with Sloppy Research', () => {
    // Addendum §2's own arithmetic, which is what the max-cost preview shows.
    const price = (key: (typeof SEED_AGENT_KEYS)[number]) => toBaseUnits(seedAgent(key).priceUsdt)
    const chain = price('binance-ticker') + price('guardrail-risk') + price('spot-executor') + price('telegram-notifier')
    expect(chain + price('alpha-research')).toBe(toBaseUnits('0.095'))
    expect(chain + price('sloppy-research')).toBe(toBaseUnits('0.075'))
  })

  it('carries a valid, unique listing id per Agent', () => {
    const ids = SEED_AGENTS.map((agent) => agent.listingId)
    expect(new Set(ids).size).toBe(SEED_AGENTS.length)
    for (const id of ids) expect(isId('listing', id)).toBe(true)
  })

  it('serves the compose ports :4101 to :4106, and :4107 for the second instance', () => {
    for (const agent of SEED_AGENTS) {
      expect(agent.port).toBe(COMPOSE_PORTS[agent.key])
      expect(agent.service).toBe(`agent-${agent.key}`)
    }
    expect(SLOPPY_RESEARCH_2.port).toBe(4107)
    expect(SLOPPY_RESEARCH_2.service).toBe('agent-sloppy-research-2')
  })

  it('names an endpoint env var per Agent, all distinct', () => {
    const vars = SEED_AGENTS.map((agent) => agent.endpointEnv)
    expect(new Set(vars).size).toBe(vars.length)
    // Story 1.10 already owns this one; the seed must keep reading it.
    expect(seedAgent('binance-ticker').endpointEnv).toBe('SEED_BINANCE_TICKER_URL')
  })
})

describe('assertSeedAgents', () => {
  it('passes when all six are active at their addendum §2 price', () => {
    const verdicts = assertSeedAgents(allActive())
    expect(verdicts).toHaveLength(6)
    expect(unhealthySeedAgents(verdicts)).toEqual([])
    expect(verdicts.every((verdict) => verdict.ok)).toBe(true)
  })

  it('names every Agent that has no listings row at all', () => {
    const rows = allActive()
    rows.delete(seedAgent('alpha-research').listingId)
    rows.delete(seedAgent('telegram-notifier').listingId)

    const missing = unhealthySeedAgents(assertSeedAgents(rows))
    expect(missing.map((verdict) => verdict.agent.name)).toEqual([
      'Alpha Research',
      'Telegram Notifier',
    ])
    expect(missing[0]!.detail).toContain('missing')
  })

  it('refuses an Agent that is still verifying, failed or paused', () => {
    for (const status of ['verifying', 'failed', 'paused']) {
      const rows = allActive()
      const alpha = seedAgent('alpha-research')
      rows.set(alpha.listingId, listed(alpha.priceUsdt, { type: 'research', status }))
      const [verdict] = unhealthySeedAgents(assertSeedAgents(rows))
      expect(verdict?.detail).toBe(`is ${status}, not active`)
    }
  })

  it('refuses an Agent listed at a price the addendum does not name', () => {
    const rows = allActive()
    const alpha = seedAgent('alpha-research')
    rows.set(alpha.listingId, listed('0.02', { type: 'research' }))

    const [verdict] = unhealthySeedAgents(assertSeedAgents(rows))
    expect(verdict?.agent.name).toBe('Alpha Research')
    expect(verdict?.detail).toBe('is listed at 0.02 tUSD, addendum §2 says 0.05 tUSD')
  })

  it('compares the chain-owned price, so an active row with no price is refused', () => {
    // AD-2: `listings.price` is written only by `refreshListingFromChain`. A row
    // that is `active` without one has not been listed at any price.
    const rows = allActive()
    const risk = seedAgent('guardrail-risk')
    rows.set(risk.listingId, { status: 'active', price: null, type: 'risk' })

    const [verdict] = unhealthySeedAgents(assertSeedAgents(rows))
    expect(verdict?.detail).toBe('is active with no price from the chain')
  })

  it('refuses a listing of the wrong Type before it looks at the price', () => {
    const rows = allActive()
    const notifier = seedAgent('telegram-notifier')
    rows.set(notifier.listingId, listed('0.005', { type: 'research' }))

    const [verdict] = unhealthySeedAgents(assertSeedAgents(rows))
    expect(verdict?.detail).toBe('is type research, addendum §2 says notify')
  })

  it('prints one line per Agent, passing and failing alike', () => {
    const rows = allActive()
    rows.delete(seedAgent('spot-executor').listingId)

    const lines = formatSeedAgentVerdicts(assertSeedAgents(rows)).split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toContain('PASS')
    expect(lines[0]).toContain('Binance Ticker')
    expect(lines.find((line) => line.includes('Binance Spot Executor'))).toContain('FAIL')
  })
})
