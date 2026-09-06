import { describe, expect, it } from 'vitest'
import type { AgentType, DataOutput, ResearchOutput, RiskOutput } from '@agent-desk/schemas'
import {
  EXCHANGE_MIN_NOTIONAL_USDT,
  REFUSALS,
  buildNodeInput,
  sideFor,
  skipReasonFor,
  type NodeInputContext,
} from './inputs.ts'
import { compareDecimal } from './decimal.ts'

/**
 * PRD addendum §1, field by field.
 *
 * These are the assertions that keep the engine and the five Agents speaking the
 * same language without either side importing the other: every input built here
 * is parsed with the Type's own schema from `packages/schemas`, which is the
 * same schema `createAgent` validates the request against before the handler
 * runs. A mapping that drifts fails here rather than at a paid 400.
 */

const SYMBOL = 'BNBUSDT'

const MARKET: DataOutput = {
  symbol: SYMBOL,
  price: '612.40',
  change_24h_pct: -1.8,
  volatility_24h_pct: 3.2,
  ts: '2026-09-06T02:00:00Z',
}

const RESEARCH: ResearchOutput = {
  signal: 'LONG',
  confidence: 0.72,
  reason: 'Price reclaimed the 24h midpoint on rising volume.',
}

const RISK: RiskOutput = {
  decision: 'REDUCE',
  size_usdt: '60',
  reason: '24h volatility above 3%.',
}

function context(overrides: Partial<NodeInputContext> & { nodeType: AgentType }): NodeInputContext {
  return { symbol: SYMBOL, outputs: {}, ...overrides }
}

function built(result: ReturnType<typeof buildNodeInput>): unknown {
  if (!result.ok) throw new Error(`expected an input, got a refusal: ${result.reason}`)
  return result.input
}

function refusal(result: ReturnType<typeof buildNodeInput>): string {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.input)}`)
  return result.reason
}

describe('the data Node', () => {
  it('takes the Workflow symbol and nothing else', () => {
    expect(built(buildNodeInput(context({ nodeType: 'data' })))).toEqual({ symbol: SYMBOL })
  })

  it('refuses a symbol the Type schema does not accept, before paying', () => {
    const result = buildNodeInput(context({ nodeType: 'data', symbol: 'bnb/usdt' }))
    expect(refusal(result)).toContain('the engine built an invalid data input')
  })
})

describe('the research Node', () => {
  it('is fed the symbol and the whole data output', () => {
    const input = built(
      buildNodeInput(context({ nodeType: 'research', outputs: { data: MARKET } })),
    )
    expect(input).toEqual({ symbol: SYMBOL, market: MARKET })
  })

  it('drops fields the data Type does not declare', () => {
    const input = built(
      buildNodeInput(
        context({ nodeType: 'research', outputs: { data: { ...MARKET, extra: 'ignored' } } }),
      ),
    ) as { market: Record<string, unknown> }
    expect(input.market.extra).toBeUndefined()
  })

  it('refuses before payment when no data output is on the Run', () => {
    expect(refusal(buildNodeInput(context({ nodeType: 'research' })))).toBe(
      'the research Node has no data output to read',
    )
  })
})

describe('the risk Node', () => {
  const outputs = { data: MARKET, research: RESEARCH }

  it('carries the signal, the confidence, the Order Cap, the balance and the market', () => {
    const input = built(
      buildNodeInput(
        context({ nodeType: 'risk', outputs, orderCapUsdt: '10', balanceUsdt: '950.00' }),
      ),
    )
    expect(input).toEqual({
      symbol: SYMBOL,
      signal: 'LONG',
      confidence: 0.72,
      proposed_size_usdt: '10',
      balance_usdt: '950.00',
      market: MARKET,
    })
  })

  it('refuses with the exchange-balance reason when the port read failed', () => {
    const result = buildNodeInput(
      context({ nodeType: 'risk', outputs, orderCapUsdt: '10', balanceUsdt: null }),
    )
    expect(refusal(result)).toBe(REFUSALS.balanceUnavailable)
    expect(refusal(result)).toBe('exchange balance unavailable')
  })

  it('refuses when the Workflow has no Order Cap to propose', () => {
    const result = buildNodeInput(
      context({ nodeType: 'risk', outputs, orderCapUsdt: null, balanceUsdt: '950.00' }),
    )
    expect(refusal(result)).toBe(REFUSALS.noOrderCap)
  })

  it('refuses when the research Node left no signal', () => {
    const result = buildNodeInput(
      context({ nodeType: 'risk', outputs: { data: MARKET }, orderCapUsdt: '10', balanceUsdt: '9' }),
    )
    expect(refusal(result)).toBe('the risk Node has no research output to read')
  })
})

describe('the execution Node', () => {
  const outputs = { data: MARKET, research: RESEARCH, risk: RISK }

  it('maps LONG to BUY and SHORT to SELL, and sends only the three fields', () => {
    expect(sideFor('LONG')).toBe('BUY')
    expect(sideFor('SHORT')).toBe('SELL')
    expect(sideFor('HOLD')).toBeNull()

    const input = built(
      buildNodeInput(context({ nodeType: 'execution', outputs, orderCapUsdt: '100' })),
    )
    expect(input).toEqual({ symbol: SYMBOL, side: 'BUY', size_usdt: '60' })

    const short = built(
      buildNodeInput(
        context({
          nodeType: 'execution',
          outputs: { ...outputs, research: { ...RESEARCH, signal: 'SHORT' } },
          orderCapUsdt: '100',
        }),
      ),
    )
    expect(short).toEqual({ symbol: SYMBOL, side: 'SELL', size_usdt: '60' })
  })

  it('takes its size from the risk decision, not from the Order Cap', () => {
    const input = built(
      buildNodeInput(
        context({
          nodeType: 'execution',
          outputs: { ...outputs, risk: { ...RISK, decision: 'APPROVE', size_usdt: '10' } },
          orderCapUsdt: '10',
        }),
      ),
    ) as { size_usdt: string }
    expect(input.size_usdt).toBe('10')
  })

  it('refuses a size above the Order Cap before paying', () => {
    const result = buildNodeInput(
      context({
        nodeType: 'execution',
        outputs: { ...outputs, risk: { ...RISK, size_usdt: '60.01' } },
        orderCapUsdt: '60',
      }),
    )
    expect(refusal(result)).toBe('order cap exceeded')
  })

  it('accepts a size exactly at the Order Cap', () => {
    const input = built(
      buildNodeInput(
        context({
          nodeType: 'execution',
          outputs: { ...outputs, risk: { ...RISK, size_usdt: '60.00' } },
          orderCapUsdt: '60',
        }),
      ),
    ) as { size_usdt: string }
    expect(input.size_usdt).toBe('60.00')
  })

  it('refuses a size below the exchange minimum notional before paying', () => {
    const result = buildNodeInput(
      context({
        nodeType: 'execution',
        outputs: { ...outputs, risk: { ...RISK, size_usdt: '4.99' } },
        orderCapUsdt: '100',
      }),
    )
    expect(refusal(result)).toBe('below exchange minimum notional (5 USDT)')
  })

  it('accepts a size exactly at the minimum notional', () => {
    const input = built(
      buildNodeInput(
        context({
          nodeType: 'execution',
          outputs: { ...outputs, risk: { ...RISK, size_usdt: EXCHANGE_MIN_NOTIONAL_USDT } },
          orderCapUsdt: '100',
        }),
      ),
    ) as { size_usdt: string }
    expect(input.size_usdt).toBe('5')
  })

  it('checks the cap before the minimum, so an over-cap size names the cap', () => {
    const result = buildNodeInput(
      context({
        nodeType: 'execution',
        outputs: { ...outputs, risk: { ...RISK, size_usdt: '4' } },
        orderCapUsdt: '3',
      }),
    )
    expect(refusal(result)).toBe(REFUSALS.orderCapExceeded)
  })

  it('refuses when the risk Node left no decision', () => {
    const result = buildNodeInput(
      context({
        nodeType: 'execution',
        outputs: { data: MARKET, research: RESEARCH },
        orderCapUsdt: '100',
      }),
    )
    expect(refusal(result)).toBe('the execution Node has no risk output to read')
  })
})

describe('the notify Node', () => {
  it('is not built here; it is the terminal filter', () => {
    expect(refusal(buildNodeInput(context({ nodeType: 'notify' })))).toContain(
      'terminal filter',
    )
  })
})

describe('the skip rules (FR-24)', () => {
  it('skips risk and execution on a HOLD signal, both with hold', () => {
    const outputs = { data: MARKET, research: { ...RESEARCH, signal: 'HOLD' as const } }
    expect(skipReasonFor('risk', outputs)).toBe('hold')
    expect(skipReasonFor('execution', outputs)).toBe('hold')
  })

  it('skips execution on a REJECT decision, with reject', () => {
    const outputs = {
      data: MARKET,
      research: RESEARCH,
      risk: { decision: 'REJECT' as const, size_usdt: '0', reason: 'confident counter-trend' },
    }
    expect(skipReasonFor('risk', outputs)).toBeNull()
    expect(skipReasonFor('execution', outputs)).toBe('reject')
  })

  it('never skips data, research or notify', () => {
    const outputs = { data: MARKET, research: { ...RESEARCH, signal: 'HOLD' as const } }
    for (const type of ['data', 'research', 'notify'] as const) {
      expect(skipReasonFor(type, outputs)).toBeNull()
    }
  })

  it('runs risk and execution on an APPROVE decision', () => {
    const outputs = { data: MARKET, research: RESEARCH, risk: { ...RISK, decision: 'APPROVE' as const } }
    expect(skipReasonFor('risk', outputs)).toBeNull()
    expect(skipReasonFor('execution', outputs)).toBeNull()
  })
})

describe('comparing decimal amounts', () => {
  it('compares by value, not by string', () => {
    expect(compareDecimal('60', '60.00')).toBe(0)
    expect(compareDecimal('9', '10')).toBe(-1)
    expect(compareDecimal('10.000001', '10')).toBe(1)
    expect(compareDecimal('0', '0.0')).toBe(0)
  })

  it('refuses anything that is not a non-negative decimal', () => {
    expect(() => compareDecimal('-1', '0')).toThrow('not a decimal amount')
    expect(() => compareDecimal('1', 'abc')).toThrow('not a decimal amount')
  })
})
