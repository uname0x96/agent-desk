import { describe, expect, it, vi } from 'vitest'
import { validateOutput, type DataOutput, type ResearchInput } from '@agent-desk/schemas'
import type { AgentHandlerContext } from '@agent-desk/agent-kit'
import {
  createAlphaHandler,
  extractJsonObject,
  FALLBACK_OUTPUT,
  readModelAnswer,
  trendSignal,
} from './handler.ts'
import type { ResearchModel } from './model.ts'

/**
 * Every branch of the handler against a stubbed model. The live model path is
 * unproven: ANTHROPIC_API_KEY is not set anywhere in this repository, so no
 * test here reaches api.anthropic.com.
 */

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

function context(): AgentHandlerContext & { warnings: unknown[] } {
  const warnings: unknown[] = []
  return {
    signal: new AbortController().signal,
    paymentSignature: null,
    warnings,
    logger: {
      info() {},
      warn(details: unknown) {
        warnings.push(details)
      },
      error() {},
    } as never,
  }
}

/** A model that answers with whatever text the test gives it. */
function stubModel(text: string): ResearchModel {
  return vi.fn(async () => text)
}

function answer(signal: string, confidence: number, reason: string): string {
  return JSON.stringify({ signal, confidence, reason })
}

describe('trendSignal', () => {
  it('follows the sign of the 24 h change', () => {
    expect(trendSignal(5.327)).toBe('LONG')
    expect(trendSignal(-5.327)).toBe('SHORT')
    expect(trendSignal(0)).toBe('HOLD')
  })
})

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 })
  })

  it('reads an object the model wrapped in a fence or a sentence', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJsonObject('Here you go: {"a":1}')).toEqual({ a: 1 })
  })

  it('reads the object out of a single-element array', () => {
    // Slicing between the outermost braces means a model that answers
    // `[{...}]` still gives up its object rather than falling back.
    expect(extractJsonObject('[{"a":1}]')).toEqual({ a: 1 })
  })

  it('refuses text that holds no object', () => {
    expect(extractJsonObject('I think we should hold.')).toBeNull()
    expect(extractJsonObject('{not json}')).toBeNull()
    expect(extractJsonObject('')).toBeNull()
  })
})

describe('readModelAnswer', () => {
  it('accepts a well-formed answer', () => {
    expect(readModelAnswer(answer('LONG', 0.72, 'BNBUSDT rose 5.33 % over 24 h.'))).toEqual({
      signal: 'LONG',
      confidence: 0.72,
      reason: 'BNBUSDT rose 5.33 % over 24 h.',
    })
  })

  it('collapses the line breaks a model puts in its reason', () => {
    expect(readModelAnswer(answer('LONG', 0.5, 'up\n  5.33 %\ttoday'))?.reason).toBe(
      'up 5.33 % today',
    )
  })

  it('trims a reason past the schema cap instead of dropping the answer', () => {
    const long = 'x'.repeat(900)
    expect(readModelAnswer(answer('LONG', 0.5, long))?.reason).toHaveLength(500)
  })

  it('refuses what the research output schema refuses', () => {
    expect(readModelAnswer(answer('BUY', 0.5, 'wrong enum'))).toBeNull()
    expect(readModelAnswer(answer('LONG', 1.4, 'confidence out of range'))).toBeNull()
    expect(readModelAnswer(answer('LONG', -0.1, 'confidence out of range'))).toBeNull()
    expect(readModelAnswer(answer('LONG', 0.5, ''))).toBeNull()
    expect(readModelAnswer('{"signal":"LONG"}')).toBeNull()
    expect(readModelAnswer('sorry, I cannot help with that')).toBeNull()
  })
})

describe('createAlphaHandler', () => {
  it('answers the model verbatim when the model already follows the trend', async () => {
    const request = input(5.327)
    const handler = createAlphaHandler({
      model: stubModel(answer('LONG', 0.72, 'BNBUSDT rose 5.33 % over 24 h.')),
    })

    const output = await handler(request, context())

    expect(output).toEqual({
      signal: 'LONG',
      confidence: 0.72,
      reason: 'BNBUSDT rose 5.33 % over 24 h.',
    })
    expect(validateOutput('research', request, output).ok).toBe(true)
  })

  it('replaces a signal that contradicts the sign of change_24h_pct, keeping the reason', async () => {
    // The market fell; the model says LONG. The answer follows the trend.
    const request = input(-5.327)
    const handler = createAlphaHandler({
      model: stubModel(answer('LONG', 0.9, 'The dip is a buying opportunity.')),
    })

    const output = await handler(request, context())

    expect(output).toEqual({
      signal: 'SHORT',
      confidence: 0.9,
      reason: 'The dip is a buying opportunity.',
    })
  })

  it('replaces the other contradiction too: SHORT on a rising market', async () => {
    const handler = createAlphaHandler({
      model: stubModel(answer('SHORT', 0.6, 'Overbought after the run-up.')),
    })

    const output = await handler(input(5.327), context())

    expect(output.signal).toBe('LONG')
    expect(output.reason).toBe('Overbought after the run-up.')
  })

  it('replaces a HOLD on a moving market, and a direction on a flat one', async () => {
    const holding = createAlphaHandler({ model: stubModel(answer('HOLD', 0.4, 'Unclear.')) })
    expect((await holding(input(5.327), context())).signal).toBe('LONG')
    expect((await holding(input(-5.327), context())).signal).toBe('SHORT')

    const directional = createAlphaHandler({ model: stubModel(answer('LONG', 0.4, 'Why not.')) })
    expect((await directional(input(0), context())).signal).toBe('HOLD')
  })

  it('follows the trend for every model answer, by construction', async () => {
    for (const change of [-9.9, -0.01, 0, 0.01, 9.9]) {
      for (const modelSignal of ['LONG', 'SHORT', 'HOLD']) {
        const handler = createAlphaHandler({
          model: stubModel(answer(modelSignal, 0.5, 'whatever the model thinks')),
        })
        const output = await handler(input(change), context())
        expect(output.signal).toBe(trendSignal(change))
      }
    }
  })

  it('holds when the model call fails', async () => {
    const handler = createAlphaHandler({
      model: vi.fn(async () => {
        throw new Error('401 authentication_error')
      }),
    })

    const ctx = context()
    expect(await handler(input(5.327), ctx)).toEqual(FALLBACK_OUTPUT)
    expect(ctx.warnings).toHaveLength(1)
  })

  it('holds when the model outlives its deadline', async () => {
    const hanging: ResearchModel = (_input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason))
      })
    // The same 8 s rule, shortened so the test does not wait for it.
    const handler = createAlphaHandler({ model: hanging, timeoutMs: 40 })

    const started = performance.now()
    expect(await handler(input(5.327), context())).toEqual(FALLBACK_OUTPUT)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('holds when the model ignores its abort signal and never answers', async () => {
    const stuck: ResearchModel = () => new Promise(() => {})
    const handler = createAlphaHandler({ model: stuck, timeoutMs: 40 })

    expect(await handler(input(5.327), context())).toEqual(FALLBACK_OUTPUT)
  })

  it('holds when the model answer is unparsable', async () => {
    const handler = createAlphaHandler({
      model: stubModel('I am afraid I cannot give you a trading signal.'),
    })

    expect(await handler(input(5.327), context())).toEqual(FALLBACK_OUTPUT)
  })

  it('holds when the model answer is JSON the output schema refuses', async () => {
    const handler = createAlphaHandler({ model: stubModel(answer('MAYBE', 3, 'nonsense')) })

    expect(await handler(input(5.327), context())).toEqual(FALLBACK_OUTPUT)
  })

  it('produces a fallback that validateOutput accepts', () => {
    const request = input(5.327)
    expect(validateOutput('research', request, FALLBACK_OUTPUT)).toEqual({
      ok: true,
      value: { signal: 'HOLD', confidence: 0.5, reason: 'LLM unavailable, holding' },
    })
  })
})
