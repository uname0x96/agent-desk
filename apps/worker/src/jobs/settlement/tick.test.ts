import { beforeEach, describe, expect, it } from 'vitest'
import { MODE_CONSTANTS } from '@agent-desk/core/mode'
import type { Clock } from '@agent-desk/core/ports'
import { PRICE_SOURCE } from '@agent-desk/schemas'
import {
  FakeMarketData,
  FakeSettlementChain,
  FakeSettlementStore,
  kline,
  work,
} from './test-doubles.ts'
import { createSettlementTick, highestHigh, lowestLow } from './tick.ts'

/**
 * The tick as a sequence: score, insert, slash, recompute Reputation, write it.
 * Every test below is one of the acceptance criteria of Stories 4.1 to 4.4, and
 * the retry cases matter most — a tick that runs twice must move money once.
 */

const ENDED = new Date('2026-09-06T12:00:00.000Z')
const AFTER_DEMO_WINDOW = new Date(ENDED.getTime() + MODE_CONSTANTS.demo.settlementWindowMs + 1)

function fixedClock(now: Date): Clock {
  return { now: () => now }
}

function harness(now = AFTER_DEMO_WINDOW) {
  const store = new FakeSettlementStore()
  const chain = new FakeSettlementChain()
  const marketData = new FakeMarketData()
  const tick = createSettlementTick({ store, chain, marketData, clock: fixedClock(now) })
  return { store, chain, marketData, tick }
}

describe('the demo slash beat, end to end through the ports', () => {
  it('scores Sloppy Research failed, slashes the locked price to the Builder, and writes 0 % reputation', async () => {
    const { store, chain, marketData, tick } = harness()
    store.work = [work()]
    marketData.change24hPct = 1.2 // a rise; SHORT fades it and is wrong

    const outcome = await tick.run()

    expect(outcome).toMatchObject({ mode: 'demo', written: 1, slashes: 1, reputationWrites: 1, errors: 0 })

    const row = store.rowFor('call_1')
    expect(row.row).toMatchObject({
      result: 'failed',
      ruleLabel: 'demo settlement rule: 24h trend',
      mode: 'demo',
      startPrice: '600',
      change24hPct: 1.2,
      priceSource: PRICE_SOURCE,
    })

    // FR-35: one transaction, exactly the Call's fee, to the Run's Builder wallet.
    expect(chain.slashes).toEqual([
      {
        settlementId: row.id,
        callId: 'call_1',
        listingId: 'lst_1',
        registryListingId: '78',
        amount: '30000',
        to: '0xd0ca46c403e54a76d95abcfb90f8e625176cecc0',
      },
    ])
    expect(row.slashTxHash).toBe(`0x${'a'.repeat(64)}`)
    expect(row.slashAmount).toBe('30000')
    expect(row.refundTo).toBe('0xd0ca46c403e54a76d95abcfb90f8e625176cecc0')

    // FR-36: one failed row out of one scored row is 0 bps.
    expect(chain.reputationWrites).toEqual([
      { settlementId: row.id, listingId: 'lst_1', registryListingId: '78', bps: 0, beforeBps: null },
    ])
    expect(row.reputationTxHash).toBe(`0x${'b'.repeat(64)}`)
  })

  it('records the clamped amount from the Slashed event, not the amount asked for', async () => {
    const { store, chain, tick } = harness()
    store.work = [work()]
    // The Listing had only 0.011 tUSD of Stake left; the contract clamps.
    chain.slashOutcome = { status: 'confirmed', txHash: `0x${'c'.repeat(64)}`, amount: '11000' }

    await tick.run()

    expect(chain.slashes[0]?.amount).toBe('30000')
    expect(store.rowFor('call_1').slashAmount).toBe('11000')
  })

  it('passes a research Call whose signal read the market right, and writes 100 %', async () => {
    const { store, chain, marketData, tick } = harness()
    store.work = [work({}, { response: { signal: 'LONG', confidence: 0.7, reason: 'up' } })]
    marketData.change24hPct = 1.2

    await tick.run()

    expect(store.rowFor('call_1').result).toBe('passed')
    // A passed row is never slashed.
    expect(chain.slashes).toEqual([])
    expect(chain.reputationWrites[0]?.bps).toBe(10_000)
  })
})

describe('each Call is settled at most once', () => {
  it('writes nothing new on a second pass and sends no second transaction', async () => {
    const { store, chain, tick } = harness()
    store.work = [work()]

    await tick.run()
    const first = { ...store.rowFor('call_1') }
    const second = await tick.run()

    expect(store.rows).toHaveLength(1)
    expect(second.written).toBe(0)
    expect(chain.slashes).toHaveLength(1)
    expect(chain.reputationWrites).toHaveLength(1)
    expect(store.rowFor('call_1').slashTxHash).toBe(first.slashTxHash)
  })

  it('a redelivered settlement.tick for the same Call finds the row and does nothing', async () => {
    const { store, chain, tick } = harness()
    store.work = [work({}, { status: 'failed_after_payment' })]

    await tick.runForCall('call_1')
    await tick.runForCall('call_1')

    expect(store.rows).toHaveLength(1)
    expect(chain.slashes).toHaveLength(1)
  })

  it('does not write a second row when the unique index says another tick won', async () => {
    const { store, tick } = harness()
    store.work = [work()]
    // Simulate the race: a row appears between the plan and the insert.
    await store.insert({
      callId: 'call_1',
      listingId: 'lst_1',
      result: 'passed',
      notScoredReason: null,
      mode: 'demo',
      ruleLabel: 'demo settlement rule: 24h trend',
      startPrice: '600',
      endPrice: null,
      change24hPct: -2,
      pFill: null,
      windowMin: null,
      windowMax: null,
      priceSource: PRICE_SOURCE,
      scoredAt: ENDED,
    })

    await tick.run()

    expect(store.rows).toHaveLength(1)
    expect(store.rowFor('call_1').result).toBe('passed')
  })
})

describe('failure after payment (Story 4.2)', () => {
  it('scores failed at once with no window wait, no prices, and scored_at = ended_at', async () => {
    // One millisecond after the Call ended: nowhere near the window's end.
    const { store, chain, tick } = harness(new Date(ENDED.getTime() + 1))
    store.work = [work({}, { status: 'failed_after_payment', response: null, referencePrice: null })]

    const outcome = await tick.runForCall('call_1')

    expect(outcome.written).toBe(1)
    const row = store.rowFor('call_1')
    expect(row.row).toMatchObject({
      result: 'failed',
      ruleLabel: 'failed after payment',
      startPrice: null,
      endPrice: null,
      change24hPct: null,
      scoredAt: ENDED,
    })
    expect(chain.slashes).toHaveLength(1)
  })

  it('is recovered by the periodic pass when the targeted job is dropped', async () => {
    const { store, tick } = harness(new Date(ENDED.getTime() + 1))
    store.work = [work({}, { status: 'failed_after_payment', response: null })]

    // No `settlement.tick` was ever published; the loop still finds it.
    const outcome = await tick.run()

    expect(outcome.written).toBe(1)
    expect(store.rowFor('call_1').result).toBe('failed')
  })
})

describe('what the tick refuses to score', () => {
  it('names a Call that is not scorable and writes nothing', async () => {
    const { store, tick } = harness()
    // `workFor` is the store's own filter; an unscorable Call is simply absent.
    const outcome = await tick.runForCall('call_verification')
    expect(outcome.written).toBe(0)
    expect(store.rows).toEqual([])
  })

  it('leaves the Call unscored when the market-data read fails', async () => {
    const { store, chain, marketData, tick } = harness()
    store.work = [work()]
    marketData.failWith = new Error('429 from data-api.binance.vision')

    const outcome = await tick.run()

    expect(outcome).toMatchObject({ written: 0, deferred: 1 })
    expect(store.rows).toEqual([])
    expect(chain.slashes).toEqual([])

    // The next tick, with the read working, settles it.
    marketData.failWith = null
    expect((await tick.run()).written).toBe(1)
  })

  it('leaves the Call unscored while its window is still open', async () => {
    const { store, tick } = harness(new Date(ENDED.getTime() + 1_000))
    store.work = [work()]
    expect((await tick.run()).deferred).toBe(1)
    expect(store.rows).toEqual([])
  })
})

describe('risk Calls', () => {
  const riskWork = (fill: Parameters<typeof work>[1] = {}) =>
    work({}, {
      callId: 'call_risk',
      nodeType: 'risk',
      response: { decision: 'APPROVE', size_usdt: '60', reason: 'ok' },
      ...fill,
    })

  it('is not_scored / reject_decision on a REJECT, and never slashes', async () => {
    const { store, chain, tick } = harness()
    store.work = [riskWork({ response: { decision: 'REJECT', size_usdt: '0', reason: 'no' }, fill: null })]

    await tick.run()

    const row = store.rowFor('call_risk')
    expect(row.row).toMatchObject({
      result: 'not_scored',
      notScoredReason: 'reject_decision',
      ruleLabel: 'risk rule: 2% drawdown in window',
    })
    expect(chain.slashes).toEqual([])
    // AD-9: a not_scored row triggers no reputation write.
    expect(chain.reputationWrites).toEqual([])
  })

  it('is not_scored / no_fill when the Run ended with no FILLED execution Call', async () => {
    const { store, chain, tick } = harness()
    store.work = [riskWork({ fill: null })]

    await tick.run()

    expect(store.rowFor('call_risk').row).toMatchObject({ result: 'not_scored', notScoredReason: 'no_fill' })
    expect(chain.reputationWrites).toEqual([])
  })

  it('scores the drawdown over klines at the mode granularity and records only the extreme it read', async () => {
    const { store, marketData, tick } = harness()
    store.work = [
      riskWork({ fill: { callId: 'call_exec', filled: true, referencePrice: '600', side: 'BUY' } }),
    ]
    marketData.klineRows = [kline('599', '601'), kline('594', '600'), kline('596', '598')]

    await tick.run()

    expect(marketData.requests[0]).toMatchObject({
      symbol: 'BNBUSDT',
      interval: '1s',
      startTime: ENDED.getTime(),
      endTime: ENDED.getTime() + MODE_CONSTANTS.demo.settlementWindowMs,
    })
    expect(store.rowFor('call_risk').row).toMatchObject({
      result: 'passed', // (600 - 594) / 600 = 1 %
      pFill: '600',
      windowMin: '594',
      windowMax: null,
    })
  })

  it('fails a BUY whose window dipped more than 2 %', async () => {
    const { store, chain, marketData, tick } = harness()
    store.work = [
      riskWork({ fill: { callId: 'call_exec', filled: true, referencePrice: '600', side: 'BUY' } }),
    ]
    marketData.klineRows = [kline('570', '601')]

    await tick.run()

    expect(store.rowFor('call_risk').result).toBe('failed')
    expect(chain.slashes).toHaveLength(1)
  })

  it('leaves the Call unscored when the window returned no klines at all', async () => {
    const { store, marketData, tick } = harness()
    store.work = [
      riskWork({ fill: { callId: 'call_exec', filled: true, referencePrice: '600', side: 'BUY' } }),
    ]
    marketData.klineRows = []

    expect((await tick.run()).deferred).toBe(1)
    expect(store.rows).toEqual([])
  })
})

describe('a slash that does not land', () => {
  it('records the reason on the Listing and retries through the same key next tick', async () => {
    const { store, chain, tick } = harness()
    store.work = [work()]
    chain.slashOutcome = { status: 'failed', reason: 'slash:call_1 reverted on chain', txHash: `0x${'d'.repeat(64)}` }

    const first = await tick.run()
    expect(first.errors).toBe(1)
    expect(store.rowFor('call_1').slashTxHash).toBeNull()
    // The score still stands, so the Reputation write still happens.
    expect(chain.reputationWrites).toHaveLength(1)

    // The row is unfinished, so the next pass picks it up and asks again.
    chain.slashOutcome = { status: 'confirmed', txHash: `0x${'e'.repeat(64)}`, amount: '30000' }
    await tick.run()
    expect(chain.slashes).toHaveLength(2)
    expect(store.rowFor('call_1').slashTxHash).toBe(`0x${'e'.repeat(64)}`)
  })

  it('waits for the Reputation write while the slash receipt is still out', async () => {
    const { store, chain, tick } = harness()
    store.work = [work()]
    chain.slashOutcome = { status: 'pending', txHash: `0x${'f'.repeat(64)}` }

    await tick.run()

    expect(store.rowFor('call_1').slashTxHash).toBeNull()
    expect(chain.reputationWrites).toEqual([])

    chain.slashOutcome = { status: 'confirmed', txHash: `0x${'f'.repeat(64)}`, amount: '30000' }
    await tick.run()
    expect(store.rowFor('call_1').slashTxHash).toBe(`0x${'f'.repeat(64)}`)
    expect(chain.reputationWrites).toHaveLength(1)
  })

  it('refuses to slash a Listing that has no Registry entry, and says so', async () => {
    const { store, chain, tick } = harness()
    store.work = [work({ registryListingId: null })]

    const outcome = await tick.run()

    expect(outcome.errors).toBeGreaterThan(0)
    expect(chain.slashes).toEqual([])
    expect(store.rowFor('call_1').result).toBe('failed')
  })
})

describe('reputation over the listing window', () => {
  it('recomputes after every scored row and carries the previous value as before', async () => {
    const { store, chain, marketData, tick } = harness()
    store.reputationBps.set('lst_1', 10_000)
    marketData.change24hPct = 1.2
    store.work = [
      work({}, { callId: 'call_a', response: { signal: 'LONG', confidence: 0.7, reason: 'up' } }),
      work({}, { callId: 'call_b', response: { signal: 'SHORT', confidence: 0.9, reason: 'fade' } }),
    ]

    await tick.run()

    // One pass, two rows: 100 % after the first, 50 % after the second.
    expect(chain.reputationWrites.map((write) => write.bps)).toEqual([10_000, 5_000])
    expect(chain.reputationWrites[0]?.beforeBps).toBe(10_000)
  })
})

describe('the window extremes read out of klines', () => {
  it('finds the lowest low and the highest high without a float', () => {
    const rows = [kline('599.10000000', '601.5'), kline('594.2', '600.9'), kline('594.19999999', '602')]
    expect(lowestLow(rows)).toBe('594.19999999')
    expect(highestHigh(rows)).toBe('602')
    expect(lowestLow([])).toBeNull()
    expect(highestHigh([])).toBeNull()
  })
})
