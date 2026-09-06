import { describe, expect, it } from 'vitest'
import { listingsResponse } from '@agent-desk/schemas'
import {
  NOT_SCORED_IN_MVP,
  NO_SCORE_YET,
  arrangeListings,
  compareListings,
  countByType,
  filterByType,
  listingStatusLabel,
  parseSort,
  parseType,
  reputationLabel,
  sumBaseUnits,
} from './listing-model.ts'
import {
  alphaResearch,
  binanceTicker,
  freshResearch,
  freshRisk,
  guardrailRisk,
  marketplaceFixture,
  pausedExecutor,
  pausedNotifier,
  sloppyResearch,
} from './fixtures.ts'

/**
 * Story 3.5: the Reputation label and both sort orders, over fixture rows.
 * This is the ordering `GET /api/listings?type=&sort=` is required to apply
 * server-side, so the same function is the one the route is meant to import.
 */

function names(items: readonly { name: string }[]): string[] {
  return items.map((item) => item.name)
}

describe('the marketplace fixture', () => {
  it('is a body `listingsResponse` accepts, so the test rows are real rows', () => {
    const parsed = listingsResponse.safeParse({ items: marketplaceFixture, next: null })
    expect(parsed.success).toBe(true)
  })
})

describe('the Reputation label', () => {
  it('is the percentage with the scored-Call count for a scored research listing', () => {
    const label = reputationLabel(alphaResearch)
    expect(label.kind).toBe('scored')
    expect(label.text).toBe('100%')
    expect(label.detail).toBe('over 3 scored Calls')
  })

  it('rounds basis points to whole percent and keeps the bps for sorting', () => {
    const label = reputationLabel(sloppyResearch)
    expect(label.text).toBe('67%')
    expect(label.bps).toBe(6667)
  })

  it('says "over 1 scored Call" rather than "1 scored Calls"', () => {
    expect(reputationLabel({ ...guardrailRisk, scored_call_count: 1 }).detail).toBe(
      'over 1 scored Call',
    )
  })

  it('says "no score yet" for a research or risk listing with no scored Call', () => {
    expect(reputationLabel(freshResearch).text).toBe(NO_SCORE_YET)
    expect(reputationLabel(freshResearch).kind).toBe('unscored')
  })

  it('never shows a zero for an unscored Agent, even when reputation_bps is 0', () => {
    // `freshRisk` carries reputation_bps 0 with no settled Call: a 0 % would
    // claim it failed every Call, which is a different statement.
    expect(freshRisk.reputation_bps).toBe(0)
    expect(reputationLabel(freshRisk).text).toBe(NO_SCORE_YET)
  })

  it('says "not scored in MVP" for data, execution and notify', () => {
    for (const listing of [binanceTicker, pausedExecutor, pausedNotifier]) {
      const label = reputationLabel(listing)
      expect(label.kind).toBe('not_scored_in_mvp')
      expect(label.text).toBe(NOT_SCORED_IN_MVP)
      expect(label.bps).toBeNull()
    }
  })
})

describe('the status label', () => {
  it('marks an active listing selectable', () => {
    const label = listingStatusLabel(alphaResearch)
    expect(label).toMatchObject({ text: 'active', tone: 'ok', reason: null, selectable: true })
  })

  it('names the creator as the pause reason and refuses selection', () => {
    const label = listingStatusLabel(pausedNotifier)
    expect(label.text).toBe('paused (creator)')
    expect(label.selectable).toBe(false)
    expect(label.reason).toContain('creator')
  })

  it('names the Stake as the pause reason', () => {
    const label = listingStatusLabel(pausedExecutor)
    expect(label.text).toBe('paused (stake)')
    expect(label.selectable).toBe(false)
    expect(label.reason).toContain('Stake')
  })

  it('names both reasons when both flags are set', () => {
    const label = listingStatusLabel({
      ...pausedExecutor,
      paused_by_creator: true,
      paused_by_stake: true,
    })
    expect(label.text).toBe('paused (creator and stake)')
  })
})

describe('sorting by Reputation', () => {
  const sorted = [...marketplaceFixture].sort(compareListings('reputation'))

  it('puts percentages first, then "no score yet", then "not scored in MVP"', () => {
    expect(names(sorted)).toEqual([
      'Alpha Research', // 100 %
      'Sloppy Research', // 67 % over 12
      'Guardrail Risk', // 67 % over 4 — same bps, fewer scored Calls
      'Newcomer Risk', // no score yet, 0.02
      'Newcomer Research', // no score yet, 0.05
      'Telegram Notifier', // not scored in MVP, 0.01, newer id
      'Binance Ticker', // not scored in MVP, 0.01
      'Spot Executor', // not scored in MVP, 0.05
    ])
  })

  it('breaks a percentage tie by scored-Call count descending', () => {
    expect(sloppyResearch.reputation_bps).toBe(guardrailRisk.reputation_bps)
    expect(sorted.indexOf(sloppyResearch)).toBeLessThan(sorted.indexOf(guardrailRisk))
  })

  it('breaks a remaining tie by price ascending', () => {
    // Both "no score yet" with 0 scored Calls, so only the price separates them.
    expect(sorted.indexOf(freshRisk)).toBeLessThan(sorted.indexOf(freshResearch))
    expect(BigInt(freshRisk.price)).toBeLessThan(BigInt(freshResearch.price))
  })
})

describe('sorting by price', () => {
  const sorted = [...marketplaceFixture].sort(compareListings('price'))

  it('is ascending, with ties broken by Reputation', () => {
    expect(names(sorted)).toEqual([
      'Telegram Notifier', // 0.01, not scored, newer id
      'Binance Ticker', // 0.01, not scored
      'Guardrail Risk', // 0.02, 67 %
      'Newcomer Risk', // 0.02, no score yet
      'Alpha Research', // 0.03, 100 %
      'Sloppy Research', // 0.03, 67 %
      'Newcomer Research', // 0.05, no score yet
      'Spot Executor', // 0.05, not scored in MVP
    ])
  })

  it('compares base units as integers, not as strings', () => {
    // "9000000" is 9 tUSD and "10000" is 0.01; a string compare would invert them.
    const expensive = { ...binanceTicker, id: 'lst_00000000000000000000MKTZ01', price: '9000000' }
    const sortedPair = [expensive, binanceTicker].sort(compareListings('price'))
    expect(sortedPair[0]).toBe(binanceTicker)
  })
})

describe('the Type filter', () => {
  it('narrows to one Type', () => {
    expect(names(filterByType(marketplaceFixture, 'research'))).toEqual([
      'Newcomer Research',
      'Sloppy Research',
      'Alpha Research',
    ])
  })

  it('returns every Type when none is chosen, without mutating the input', () => {
    const all = filterByType(marketplaceFixture, null)
    expect(all).toHaveLength(marketplaceFixture.length)
    expect(all).not.toBe(marketplaceFixture)
  })

  it('counts the Types for the filter control', () => {
    expect(countByType(marketplaceFixture)).toEqual({
      data: 1,
      research: 3,
      risk: 2,
      execution: 1,
      notify: 1,
    })
  })
})

describe('arrangeListings', () => {
  it('filters and then sorts, leaving the source untouched', () => {
    const before = [...marketplaceFixture]
    const arranged = arrangeListings(marketplaceFixture, { type: 'risk', sort: 'reputation' })
    expect(names(arranged)).toEqual(['Guardrail Risk', 'Newcomer Risk'])
    expect(marketplaceFixture).toEqual(before)
  })
})

describe('parsing the query string', () => {
  it('defaults to the Reputation sort and to every Type', () => {
    expect(parseSort(null)).toBe('reputation')
    expect(parseSort('nonsense')).toBe('reputation')
    expect(parseType(null)).toBeNull()
    expect(parseType('nonsense')).toBeNull()
  })

  it('accepts the two sorts and the five Types', () => {
    expect(parseSort('price')).toBe('price')
    expect(parseSort('reputation')).toBe('reputation')
    for (const type of ['data', 'research', 'risk', 'execution', 'notify'] as const) {
      expect(parseType(type)).toBe(type)
    }
  })
})

describe('sumBaseUnits', () => {
  it('adds base units as integers', () => {
    expect(sumBaseUnits(marketplaceFixture.map((listing) => listing.stake))).toBe('1820000')
  })

  it('is 0 for an empty marketplace', () => {
    expect(sumBaseUnits([])).toBe('0')
  })
})
