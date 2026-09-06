import { describe, expect, it } from 'vitest'
import { validateOutput, type DataOutput, type ResearchInput } from '@agent-desk/schemas'
import type { AgentHandlerContext } from '@agent-desk/agent-kit'
import { contrarianSignal, createSloppyHandler, SLOPPY_REASON } from './handler.ts'

function market(changePct: number): DataOutput {
  return {
    symbol: 'BNBUSDT',
    price: '761.27',
    change_24h_pct: changePct,
    volatility_24h_pct: 8.1878,
    ts: '2026-09-05T12:00:00.000Z',
  }
}

function input(changePct: number): ResearchInput {
  return { symbol: 'BNBUSDT', market: market(changePct) }
}

function context(): AgentHandlerContext {
  return {
    signal: new AbortController().signal,
    paymentSignature: null,
    logger: { info() {}, warn() {}, error() {} } as never,
  }
}

describe('contrarianSignal', () => {
  it('is LONG on a fall, SHORT on a rise, HOLD on an exactly flat window', () => {
    expect(contrarianSignal(-5.327)).toBe('LONG')
    expect(contrarianSignal(5.327)).toBe('SHORT')
    expect(contrarianSignal(0)).toBe('HOLD')
  })

  it('treats -0 as flat, not as a fall', () => {
    expect(contrarianSignal(-0)).toBe('HOLD')
  })
})

describe('createSloppyHandler', () => {
  const handler = createSloppyHandler()

  it('answers confidence 0.9 and the generic reason whatever the market did', async () => {
    for (const change of [-12.5, -0.01, 0, 0.01, 12.5]) {
      const output = await handler(input(change), context())
      expect(output.confidence).toBe(0.9)
      expect(output.reason).toBe(SLOPPY_REASON)
    }
  })

  it('produces an output validateOutput accepts', async () => {
    const request = input(5.327)
    const output = await handler(request, context())
    expect(validateOutput('research', request, output)).toEqual({
      ok: true,
      value: { signal: 'SHORT', confidence: 0.9, reason: SLOPPY_REASON },
    })
  })

  it('answers well inside 100 ms of the handler start', async () => {
    const started = performance.now()
    await handler(input(5.327), context())
    expect(performance.now() - started).toBeLessThan(100)
  })

  it('is confidently wrong: it never agrees with the 24 h trend', async () => {
    // The point of the agent (PRD addendum section 2). If this test ever
    // starts failing because the signal follows the trend, the demo's
    // Provider swap has stopped showing anything.
    const up = await handler(input(5.327), context())
    const down = await handler(input(-5.327), context())
    expect(up.signal).toBe('SHORT')
    expect(down.signal).toBe('LONG')
  })
})
