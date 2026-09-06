import { describe, expect, it } from 'vitest'
import { AGENT_TYPES, CALL_STATUSES, PRICE_SOURCE, type AgentType, type CallStatus } from '@agent-desk/schemas'
import { MODE_CONSTANTS } from '../mode/index.ts'
import {
  isScorableCall,
  planSettlement,
  settleWithMarketData,
  windowEnd,
  type ExecutionFill,
  type SettlementCandidate,
  type SettlementContext,
  type SettlementRowPlan,
  type SettlementStep,
} from './plan.ts'
import { FAILED_AFTER_PAYMENT_RULE_LABEL, RISK_RULE_LABEL } from './rules.ts'

/**
 * AD-9 and Story 4.1's selection and window rules, enumerated. These are the
 * cases that decide *whether* a Call is scored at all; `rules.test.ts` decides
 * how a scored one comes out.
 */

const ENDED = new Date('2026-09-06T12:00:00.000Z')
const RUN_ENDED = new Date('2026-09-06T12:00:01.000Z')

function candidate(overrides: Partial<SettlementCandidate> = {}): SettlementCandidate {
  return {
    callId: 'call_1',
    listingId: 'lst_1',
    runId: 'run_1',
    kind: 'run',
    nodeType: 'research',
    status: 'succeeded',
    endedAt: ENDED,
    referencePrice: '600',
    symbol: 'BNBUSDT',
    response: { signal: 'LONG', confidence: 0.9, reason: 'because' },
    runEndedAt: RUN_ENDED,
    fill: null,
    ...overrides,
  }
}

function fill(overrides: Partial<ExecutionFill> = {}): ExecutionFill {
  return { callId: 'call_exec', filled: true, referencePrice: '600', side: 'BUY', ...overrides }
}

const demo = (now: Date): SettlementContext => ({ mode: 'demo', now })
const production = (now: Date): SettlementContext => ({ mode: 'production', now })

/** `ENDED` plus the mode's window, plus one millisecond. */
const afterWindow = (mode: 'demo' | 'production') =>
  new Date(ENDED.getTime() + MODE_CONSTANTS[mode].settlementWindowMs + 1)

function rowOf(step: SettlementStep): SettlementRowPlan {
  if (step.kind !== 'write') throw new Error(`expected a write step, got ${step.kind}`)
  return step.row
}

describe('isScorableCall — Story 4.1 selection', () => {
  it('selects only research and risk Calls of kind run in the two paid-and-ended statuses', () => {
    const selected: string[] = []
    for (const kind of ['run', 'verification'] as const) {
      for (const nodeType of AGENT_TYPES) {
        for (const status of CALL_STATUSES) {
          if (isScorableCall({ kind, nodeType, status })) selected.push(`${kind}/${nodeType}/${status}`)
        }
      }
    }
    expect(selected.sort()).toEqual([
      'run/research/failed_after_payment',
      'run/research/succeeded',
      'run/risk/failed_after_payment',
      'run/risk/succeeded',
    ])
  })

  it('never selects a verification Call, at any status (FR-11)', () => {
    // Scoring one would slash a brand-new Listing for the Call that put it on
    // chain. This is the case the team's AD-3/AD-9 override exists for.
    for (const status of CALL_STATUSES) {
      for (const nodeType of AGENT_TYPES) {
        expect(isScorableCall({ kind: 'verification', nodeType, status })).toBe(false)
      }
    }
    expect(planSettlement(candidate({ kind: 'verification', runId: null }), demo(afterWindow('demo')))).toEqual({
      kind: 'defer',
      reason: 'not_scorable',
    })
  })

  it('never selects data, execution, or notify Calls', () => {
    const unscored: AgentType[] = ['data', 'execution', 'notify']
    for (const nodeType of unscored) {
      expect(isScorableCall({ kind: 'run', nodeType, status: 'succeeded' })).toBe(false)
      expect(planSettlement(candidate({ nodeType }), demo(afterWindow('demo')))).toEqual({
        kind: 'defer',
        reason: 'not_scorable',
      })
    }
  })

  it('never selects a Call that was not paid for or is still in flight', () => {
    const unpaid: CallStatus[] = ['pending', 'price_mismatch', 'payment_failed', 'paid_awaiting_result', 'skipped']
    for (const status of unpaid) {
      expect(isScorableCall({ kind: 'run', nodeType: 'research', status })).toBe(false)
    }
  })
})

describe('planSettlement — failure after payment (Story 4.2)', () => {
  it('scores failed at once, with no window, no prices, and scored_at = calls.ended_at', () => {
    const step = planSettlement(
      candidate({ status: 'failed_after_payment', response: null }),
      // One millisecond after the Call ended: far inside the window.
      demo(new Date(ENDED.getTime() + 1)),
    )
    expect(rowOf(step)).toEqual({
      callId: 'call_1',
      listingId: 'lst_1',
      result: 'failed',
      notScoredReason: null,
      mode: 'demo',
      ruleLabel: FAILED_AFTER_PAYMENT_RULE_LABEL,
      startPrice: null,
      endPrice: null,
      change24hPct: null,
      pFill: null,
      windowMin: null,
      windowMax: null,
      priceSource: PRICE_SOURCE,
      scoredAt: ENDED,
    })
  })

  it('scores a risk Call the same way, whatever its decision said', () => {
    const step = planSettlement(
      candidate({ nodeType: 'risk', status: 'failed_after_payment', response: { decision: 'REJECT' } }),
      production(new Date(ENDED.getTime() + 1)),
    )
    expect(rowOf(step).result).toBe('failed')
    expect(rowOf(step).ruleLabel).toBe(FAILED_AFTER_PAYMENT_RULE_LABEL)
  })

  it('waits for a Call that has no ended_at yet rather than inventing one', () => {
    expect(
      planSettlement(candidate({ status: 'failed_after_payment', endedAt: null }), demo(RUN_ENDED)),
    ).toEqual({ kind: 'defer', reason: 'not_ended' })
  })
})

describe('planSettlement — research', () => {
  it('waits while the window is open and asks for a price once it has closed', () => {
    const openAt = new Date(ENDED.getTime() + MODE_CONSTANTS.demo.settlementWindowMs - 1)
    expect(planSettlement(candidate(), demo(openAt))).toEqual({ kind: 'defer', reason: 'window_open' })

    // The window closes at exactly ended_at + window; the tick at that instant scores.
    const closesAt = windowEnd(ENDED, 'demo')
    expect(planSettlement(candidate(), demo(closesAt)).kind).toBe('score')
  })

  it('honours the mode read at tick time, not the mode when the Call ran', () => {
    expect(planSettlement(candidate(), demo(afterWindow('demo')))).toEqual({
      kind: 'score',
      need: { rule: '24h trend', symbol: 'BNBUSDT', signal: 'LONG', startPrice: '600' },
    })
    expect(planSettlement(candidate(), production(afterWindow('production')))).toEqual({
      kind: 'score',
      need: { rule: 'window price move', symbol: 'BNBUSDT', signal: 'LONG', startPrice: '600' },
    })
    // In production the demo window has not closed anything.
    expect(planSettlement(candidate(), production(afterWindow('demo')))).toEqual({
      kind: 'defer',
      reason: 'window_open',
    })
  })

  it('is not_scored / no_reference_price when the reference read failed', () => {
    // Settled now rather than after the window: the answer cannot change, and
    // holding the Stake reservation for an hour for it would be wrong.
    const step = planSettlement(candidate({ referencePrice: null }), demo(new Date(ENDED.getTime() + 1)))
    const row = rowOf(step)
    expect(row.result).toBe('not_scored')
    expect(row.notScoredReason).toBe('no_reference_price')
    expect(row.ruleLabel).toBe(MODE_CONSTANTS.demo.researchRuleLabel)
    expect(row.startPrice).toBeNull()
  })

  it('defers a response it cannot read a signal out of', () => {
    for (const response of [null, {}, { signal: 'SIDEWAYS' }, 'LONG']) {
      expect(planSettlement(candidate({ response }), demo(afterWindow('demo')))).toEqual({
        kind: 'defer',
        reason: 'unreadable_response',
      })
    }
  })
})

describe('planSettlement — risk', () => {
  const risk = (overrides: Partial<SettlementCandidate> = {}) =>
    candidate({
      nodeType: 'risk',
      response: { decision: 'APPROVE', size_usdt: '60', reason: 'fine' },
      fill: fill(),
      ...overrides,
    })

  it('is not_scored / reject_decision on a REJECT, without waiting for anything', () => {
    const step = planSettlement(
      risk({ response: { decision: 'REJECT', size_usdt: '0', reason: 'no' }, runEndedAt: null, fill: null }),
      demo(new Date(ENDED.getTime() + 1)),
    )
    const row = rowOf(step)
    expect(row.result).toBe('not_scored')
    expect(row.notScoredReason).toBe('reject_decision')
    expect(row.ruleLabel).toBe(RISK_RULE_LABEL)
  })

  it('waits for the Run to end before deciding anything about a fill', () => {
    expect(planSettlement(risk({ runEndedAt: null, fill: null }), demo(afterWindow('demo')))).toEqual({
      kind: 'defer',
      reason: 'run_running',
    })
  })

  it('is not_scored / no_fill when the Run ended without a FILLED execution Call', () => {
    for (const missing of [null, fill({ filled: false }), fill({ referencePrice: null }), fill({ side: null })]) {
      const row = rowOf(planSettlement(risk({ fill: missing }), demo(afterWindow('demo'))))
      expect(row.result).toBe('not_scored')
      expect(row.notScoredReason).toBe('no_fill')
      expect(row.ruleLabel).toBe(RISK_RULE_LABEL)
    }
  })

  it('asks for klines at the mode granularity over exactly the Call window', () => {
    expect(planSettlement(risk(), demo(afterWindow('demo')))).toEqual({
      kind: 'score',
      need: {
        rule: 'drawdown',
        symbol: 'BNBUSDT',
        side: 'BUY',
        pFill: '600',
        interval: '1s',
        startTime: ENDED.getTime(),
        endTime: ENDED.getTime() + MODE_CONSTANTS.demo.settlementWindowMs,
      },
    })

    const step = planSettlement(risk({ fill: fill({ side: 'SELL' }) }), production(afterWindow('production')))
    expect(step).toEqual({
      kind: 'score',
      need: {
        rule: 'drawdown',
        symbol: 'BNBUSDT',
        side: 'SELL',
        pFill: '600',
        interval: '1m',
        startTime: ENDED.getTime(),
        endTime: ENDED.getTime() + MODE_CONSTANTS.production.settlementWindowMs,
      },
    })
  })

  it('waits for its own window even once the Run has ended and filled', () => {
    const openAt = new Date(ENDED.getTime() + MODE_CONSTANTS.demo.settlementWindowMs - 1)
    expect(planSettlement(risk(), demo(openAt))).toEqual({ kind: 'defer', reason: 'window_open' })
  })

  it('defers a response it cannot read a decision out of', () => {
    expect(planSettlement(risk({ response: { decision: 'MAYBE' } }), demo(afterWindow('demo')))).toEqual({
      kind: 'defer',
      reason: 'unreadable_response',
    })
  })
})

describe('settleWithMarketData', () => {
  const need = (step: SettlementStep) => {
    if (step.kind !== 'score') throw new Error(`expected a score step, got ${step.kind}`)
    return step.need
  }

  it('writes the production research row with both prices and the production label', () => {
    const context = production(afterWindow('production'))
    const step = planSettlement(candidate(), context)
    const row = rowOf(settleWithMarketData(candidate(), context, need(step), { rule: 'window price move', endPrice: '612.40' }))
    expect(row).toMatchObject({
      result: 'passed',
      mode: 'production',
      ruleLabel: 'production settlement rule: window price move',
      startPrice: '600',
      endPrice: '612.40',
      change24hPct: null,
      priceSource: PRICE_SOURCE,
      scoredAt: context.now,
    })
  })

  it('writes the demo research row with the 24h change and the verbatim demo label', () => {
    const context = demo(afterWindow('demo'))
    const sloppy = candidate({ response: { signal: 'SHORT', confidence: 0.9, reason: 'fade it' } })
    const step = planSettlement(sloppy, context)
    const row = rowOf(settleWithMarketData(sloppy, context, need(step), { rule: '24h trend', change24hPct: 1.2 }))
    expect(row).toMatchObject({
      result: 'failed',
      ruleLabel: 'demo settlement rule: 24h trend',
      startPrice: '600',
      endPrice: null,
      change24hPct: 1.2,
    })
  })

  it('records only the extreme the risk rule read', () => {
    const context = demo(afterWindow('demo'))
    const buy = candidate({ nodeType: 'risk', response: { decision: 'APPROVE' }, fill: fill() })
    const buyRow = rowOf(
      settleWithMarketData(buy, context, need(planSettlement(buy, context)), {
        rule: 'drawdown',
        windowMin: '594',
        windowMax: '610',
      }),
    )
    expect(buyRow).toMatchObject({ result: 'passed', pFill: '600', windowMin: '594', windowMax: null })

    const sell = candidate({ nodeType: 'risk', response: { decision: 'REDUCE' }, fill: fill({ side: 'SELL' }) })
    const sellRow = rowOf(
      settleWithMarketData(sell, context, need(planSettlement(sell, context)), {
        rule: 'drawdown',
        windowMin: '500',
        windowMax: '630',
      }),
    )
    expect(sellRow).toMatchObject({ result: 'failed', pFill: '600', windowMin: null, windowMax: '630' })
  })

  it('defers rather than scoring when the window had no klines at all', () => {
    const context = demo(afterWindow('demo'))
    const buy = candidate({ nodeType: 'risk', response: { decision: 'APPROVE' }, fill: fill() })
    expect(
      settleWithMarketData(buy, context, need(planSettlement(buy, context)), {
        rule: 'drawdown',
        windowMin: null,
        windowMax: null,
      }),
    ).toEqual({ kind: 'defer', reason: 'window_open' })
  })

  it('refuses an observation that does not answer the need it was asked for', () => {
    const context = demo(afterWindow('demo'))
    expect(() =>
      settleWithMarketData(candidate(), context, need(planSettlement(candidate(), context)), {
        rule: 'window price move',
        endPrice: '1',
      }),
    ).toThrow(/does not answer need/)
  })
})
