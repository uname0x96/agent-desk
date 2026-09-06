import { describe, expect, it } from 'vitest'
import { seedAgent } from './agents.ts'
import { chainNodes } from './demo.ts'
import { SEED_CHAINS, SEED_GOOD_CHAIN, SEED_SLOPPY_CHAIN } from './fixtures.ts'

/**
 * The Node order of the two demo chains. It is the one decision in `demo.ts`
 * that is a decision rather than a write, and FR-17 makes it a rule the Workflow
 * Builder and `POST /api/workflows` enforce, so a chain the seed writes must be
 * one they would have accepted.
 */
describe('chainNodes', () => {
  it('is the good chain of Story 2.10, in order', () => {
    expect(chainNodes(SEED_GOOD_CHAIN).map((key) => seedAgent(key).name)).toEqual([
      'Binance Ticker',
      'Alpha Research',
      'Guardrail Risk',
      'Binance Spot Executor',
      'Telegram Notifier',
    ])
  })

  it('is the sloppy chain with Sloppy Research in the research Node and nothing else changed', () => {
    const good = chainNodes(SEED_GOOD_CHAIN)
    const sloppy = chainNodes(SEED_SLOPPY_CHAIN)

    expect(sloppy[1]).toBe('sloppy-research')
    expect(sloppy.filter((_, index) => index !== 1)).toEqual(good.filter((_, index) => index !== 1))
  })

  it('follows FR-17: data before research before risk before execution, notify last', () => {
    for (const chain of SEED_CHAINS) {
      expect(chainNodes(chain).map((key) => seedAgent(key).type)).toEqual([
        'data',
        'research',
        'risk',
        'execution',
        'notify',
      ])
    }
  })

  it('uses each Type exactly once, which FR-17 also requires', () => {
    for (const chain of SEED_CHAINS) {
      const types = chainNodes(chain).map((key) => seedAgent(key).type)
      expect(new Set(types).size).toBe(types.length)
    }
  })
})
