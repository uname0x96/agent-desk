import { describe, expect, it, vi } from 'vitest'
import type { ResearchInput } from '@agent-desk/schemas'
import {
  buildUserPrompt,
  createAnthropicModel,
  DEFAULT_MODEL,
  LlmError,
  MAX_OUTPUT_TOKENS,
  SYSTEM_PROMPT,
} from './model.ts'

/**
 * The Anthropic adapter against a stubbed `fetch`. It proves the request the
 * SDK puts on the wire and how the answer is read back; it does not prove the
 * live model path, which needs an ANTHROPIC_API_KEY nobody has set.
 */

const REQUEST: ResearchInput = {
  symbol: 'BNBUSDT',
  market: {
    symbol: 'BNBUSDT',
    price: '761.27',
    change_24h_pct: 5.327,
    volatility_24h_pct: 8.1878,
    ts: '2026-09-05T12:00:00.000Z',
  },
}

interface MessageBody {
  model: string
  max_tokens: number
  system: string
  thinking: { type: string }
  messages: Array<{ role: string; content: string }>
}

function messageResponse(text: string, status = 200) {
  return new Response(
    JSON.stringify({
      id: 'msg_01test',
      type: 'message',
      role: 'assistant',
      model: DEFAULT_MODEL,
      content: text === '' ? [] : [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 40 },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

function stubFetch(response: () => Response) {
  return vi.fn(async () => response()) as unknown as typeof globalThis.fetch
}

async function callWith(fetchImpl: typeof globalThis.fetch): Promise<string> {
  const model = createAnthropicModel({ apiKey: 'sk-ant-test', fetchImpl })
  return model(REQUEST, new AbortController().signal)
}

describe('createAnthropicModel', () => {
  it('sends the fixed prompt and the snapshot to claude-sonnet-5', async () => {
    const fetchImpl = stubFetch(() => messageResponse('{"signal":"LONG"}'))
    await callWith(fetchImpl)

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(String(url)).toContain('/v1/messages')
    const body = JSON.parse(String(init?.body)) as MessageBody
    expect(body.model).toBe('claude-sonnet-5')
    expect(body.max_tokens).toBe(MAX_OUTPUT_TOKENS)
    expect(body.system).toBe(SYSTEM_PROMPT)
    // Nothing here needs reasoning, and the 8 s deadline has no room for it.
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.messages).toEqual([{ role: 'user', content: buildUserPrompt(REQUEST) }])
    expect(body.messages[0]!.content).toContain('"change_24h_pct": 5.327')
  })

  it('honours ANTHROPIC_MODEL when one is configured', async () => {
    const fetchImpl = stubFetch(() => messageResponse('{"signal":"LONG"}'))
    const model = createAnthropicModel({
      apiKey: 'sk-ant-test',
      model: 'claude-haiku-4-5',
      fetchImpl,
    })
    await model(REQUEST, new AbortController().signal)

    const [, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect((JSON.parse(String(init?.body)) as MessageBody).model).toBe('claude-haiku-4-5')
  })

  it('returns the text blocks of the answer', async () => {
    const answer = '{"signal":"LONG","confidence":0.72,"reason":"BNBUSDT rose 5.33 %."}'
    expect(await callWith(stubFetch(() => messageResponse(`  ${answer}  `)))).toBe(answer)
  })

  it('refuses an answer with no text block', async () => {
    await expect(callWith(stubFetch(() => messageResponse('')))).rejects.toThrow(LlmError)
  })

  it('rejects on an API error and makes exactly one attempt', async () => {
    // maxRetries: 0. The SDK's default of two retries would spend three times
    // the 8 s deadline and blow the AD-7 handler budget.
    const fetchImpl = stubFetch(() => messageResponse('nope', 500))
    await expect(callWith(fetchImpl)).rejects.toThrow()
    expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(1)
  })
})
