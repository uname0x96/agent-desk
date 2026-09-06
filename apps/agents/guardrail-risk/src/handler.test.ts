import { describe, expect, it } from 'vitest'
import { validateOutput, type DataOutput, type RiskInput, type RiskOutput } from '@agent-desk/schemas'
import {
  decide,
  fromHundredths,
  opposesTrend,
  riskHandler,
  RULES,
  toHundredths,
} from './handler.ts'

const MARKET: DataOutput = {
  symbol: 'BNBUSDT',
  price: '612.40',
  change_24h_pct: 2.4,
  volatility_24h_pct: 1.2,
  ts: '2026-09-05T02:00:00Z',
}

type Overrides = Omit<Partial<RiskInput>, 'market'> & { market?: Partial<DataOutput> }

function input(overrides: Overrides = {}): RiskInput {
  const { market, ...rest } = overrides
  return {
    symbol: 'BNBUSDT',
    signal: 'LONG',
    confidence: 0.72,
    proposed_size_usdt: '100',
    balance_usdt: '950.00',
    ...rest,
    market: { ...MARKET, ...market },
  }
}

/**
 * Every case goes through `validateOutput`, the same checker `createAgent` runs
 * before answering 200 (AD-7, AD-14). It is the one that enforces `"0"` on a
 * REJECT and a size at or below `proposed_size_usdt` and `balance_usdt`, so a
 * ladder that produced a size the platform would refuse fails here first.
 */
function run(riskInput: RiskInput): RiskOutput {
  const output = decide(riskInput)
  const checked = validateOutput('risk', riskInput, output)
  expect(checked.ok, checked.ok ? '' : `${checked.error} at ${checked.path}`).toBe(true)
  return output
}

describe('rung 1: HOLD', () => {
  it('rejects a HOLD signal with the reason the criteria name', () => {
    const output = run(input({ signal: 'HOLD' }))
    expect(output).toEqual({ decision: 'REJECT', size_usdt: '0', reason: RULES.hold })
  })

  it('answers before any other rung can fire', () => {
    // Counter-trend, over the reject threshold, and over the balance at once.
    const output = run(
      input({
        signal: 'HOLD',
        confidence: 1,
        balance_usdt: '0',
        market: { change_24h_pct: -9, volatility_24h_pct: 12 },
      }),
    )
    expect(output.reason).toBe(RULES.hold)
  })
})

describe('rung 2: a confident signal against the 24 h trend', () => {
  it('rejects a confident LONG into a falling market', () => {
    const output = run(input({ confidence: 0.9, market: { change_24h_pct: -2.4 } }))
    expect(output.decision).toBe('REJECT')
    expect(output.size_usdt).toBe('0')
    expect(output.reason).toContain(RULES.counterTrend)
  })

  it('rejects a confident SHORT into a rising market', () => {
    const output = run(
      input({ signal: 'SHORT', confidence: 0.86, market: { change_24h_pct: 2.4 } }),
    )
    expect(output.decision).toBe('REJECT')
    expect(output.reason).toContain(RULES.counterTrend)
  })

  it('outranks the volatility rungs', () => {
    const output = run(
      input({ confidence: 0.9, market: { change_24h_pct: -2.4, volatility_24h_pct: 12 } }),
    )
    expect(output.reason).toContain(RULES.counterTrend)
    expect(output.reason).not.toContain(RULES.volatilityReject)
  })

  it('leaves a confident signal that runs with the trend alone', () => {
    const long = run(input({ confidence: 0.99, market: { change_24h_pct: 2.4 } }))
    expect(long.decision).toBe('APPROVE')
    const short = run(
      input({ signal: 'SHORT', confidence: 0.99, market: { change_24h_pct: -2.4 } }),
    )
    expect(short.decision).toBe('APPROVE')
  })

  it('does not fire at exactly 0.85 confidence: the threshold is strict', () => {
    const output = run(input({ confidence: 0.85, market: { change_24h_pct: -2.4 } }))
    expect(output.decision).toBe('APPROVE')
    expect(output.reason).toContain(RULES.withinLimits)
  })

  it('does not fire on a 24 h change of exactly 0: no sign to oppose', () => {
    const long = run(input({ confidence: 1, market: { change_24h_pct: 0 } }))
    expect(long.decision).toBe('APPROVE')
    const short = run(input({ signal: 'SHORT', confidence: 1, market: { change_24h_pct: 0 } }))
    expect(short.decision).toBe('APPROVE')
  })
})

describe('opposesTrend', () => {
  it('is the sign test the rung is written against', () => {
    expect(opposesTrend('LONG', -0.1)).toBe(true)
    expect(opposesTrend('LONG', 0)).toBe(false)
    expect(opposesTrend('LONG', 0.1)).toBe(false)
    expect(opposesTrend('SHORT', 0.1)).toBe(true)
    expect(opposesTrend('SHORT', 0)).toBe(false)
    expect(opposesTrend('SHORT', -0.1)).toBe(false)
    expect(opposesTrend('HOLD', -9)).toBe(false)
    expect(opposesTrend('HOLD', 9)).toBe(false)
  })
})

describe('rung 3: volatility above 6 %', () => {
  it('rejects at 6.01 %', () => {
    const output = run(input({ market: { volatility_24h_pct: 6.01 } }))
    expect(output).toMatchObject({ decision: 'REJECT', size_usdt: '0' })
    expect(output.reason).toContain(RULES.volatilityReject)
  })

  it('reduces rather than rejects at exactly 6 %: the threshold is strict', () => {
    const output = run(input({ market: { volatility_24h_pct: 6 } }))
    expect(output).toMatchObject({ decision: 'REDUCE', size_usdt: '60' })
    expect(output.reason).toContain(RULES.volatilityReduce)
  })
})

describe('rung 4: volatility above 3 %', () => {
  it('keeps 60 % of the proposed size', () => {
    const output = run(input({ market: { volatility_24h_pct: 4.2 } }))
    expect(output).toMatchObject({ decision: 'REDUCE', size_usdt: '60' })
    expect(output.reason).toContain(RULES.volatilityReduce)
  })

  it('approves at exactly 3 %: the threshold is strict', () => {
    const output = run(input({ market: { volatility_24h_pct: 3 } }))
    expect(output).toMatchObject({ decision: 'APPROVE', size_usdt: '100' })
    expect(output.reason).toContain(RULES.withinLimits)
  })

  it('drops the digits below a cent rather than rounding past the proposed size', () => {
    // 60 % of 33.33 is 19.998; rounding up would answer more than the ladder allows.
    const output = run(input({ proposed_size_usdt: '33.33', market: { volatility_24h_pct: 4 } }))
    expect(output.size_usdt).toBe('19.99')
  })
})

describe('rung 5: APPROVE', () => {
  it('answers the proposed size when nothing else fires', () => {
    const output = run(input({ proposed_size_usdt: '250.75' }))
    expect(output).toMatchObject({ decision: 'APPROVE', size_usdt: '250.75' })
    expect(output.reason).toContain(RULES.withinLimits)
  })

  it('trims a proposed size that carries more than two decimals', () => {
    const output = run(input({ proposed_size_usdt: '100.999' }))
    expect(output.size_usdt).toBe('100.99')
  })
})

describe('the balance clamp', () => {
  it('holds an APPROVE down to the balance and keeps it an APPROVE', () => {
    const output = run(input({ proposed_size_usdt: '100', balance_usdt: '40' }))
    expect(output).toMatchObject({ decision: 'APPROVE', size_usdt: '40' })
    expect(output.reason).toContain(RULES.clamp)
  })

  it('holds a REDUCE down to the balance and keeps it a REDUCE', () => {
    const output = run(
      input({ proposed_size_usdt: '100', balance_usdt: '25', market: { volatility_24h_pct: 4.2 } }),
    )
    expect(output).toMatchObject({ decision: 'REDUCE', size_usdt: '25' })
    expect(output.reason).toContain(RULES.volatilityReduce)
    expect(output.reason).toContain(RULES.clamp)
  })

  it('leaves the reason alone when the balance is not the binding limit', () => {
    const output = run(input({ proposed_size_usdt: '100', balance_usdt: '100' }))
    expect(output.size_usdt).toBe('100')
    expect(output.reason).not.toContain(RULES.clamp)
  })

  it('answers 0 on an empty balance without turning into a REJECT', () => {
    const output = run(input({ balance_usdt: '0' }))
    expect(output).toMatchObject({ decision: 'APPROVE', size_usdt: '0' })
    expect(output.reason).toContain(RULES.clamp)
  })

  it('never answers more than the balance, whichever rung fired', () => {
    for (const volatility of [1.2, 3, 4.2, 6]) {
      const output = run(
        input({
          proposed_size_usdt: '1000',
          balance_usdt: '12.5',
          market: { volatility_24h_pct: volatility },
        }),
      )
      expect(Number(output.size_usdt)).toBeLessThanOrEqual(12.5)
    }
  })
})

describe('decimal handling', () => {
  it('reads and writes decimal USDT strings without float math', () => {
    expect(toHundredths('100')).toBe(10_000n)
    expect(toHundredths('100.999')).toBe(10_099n)
    expect(toHundredths('0.5')).toBe(50n)
    expect(toHundredths('0')).toBe(0n)
    expect(fromHundredths(10_000n)).toBe('100')
    expect(fromHundredths(10_099n)).toBe('100.99')
    expect(fromHundredths(50n)).toBe('0.5')
    expect(fromHundredths(5n)).toBe('0.05')
    expect(fromHundredths(0n)).toBe('0')
  })

  it('answers at most two decimals', () => {
    const output = run(
      input({ proposed_size_usdt: '0.55', market: { volatility_24h_pct: 4 } }),
    )
    // 60 % of 0.55 is 0.33.
    expect(output.size_usdt).toBe('0.33')
    expect(output.size_usdt.split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2)
  })
})

describe('riskHandler', () => {
  it('is the ladder behind the AD-7 handler signature', async () => {
    const request = input({ market: { volatility_24h_pct: 4.2 } })
    const output = await riskHandler(request, {
      signal: new AbortController().signal,
      paymentSignature: null,
      logger: { info() {}, warn() {}, error() {} } as never,
    })
    expect(output).toEqual(decide(request))
  })

  it('completes well inside 100 ms', () => {
    const request = input({ market: { volatility_24h_pct: 4.2 } })
    const started = performance.now()
    for (let i = 0; i < 1_000; i += 1) decide(request)
    const elapsed = performance.now() - started
    // 1000 decisions inside the budget for one, so a single call is not close.
    expect(elapsed).toBeLessThan(100)
  })
})
