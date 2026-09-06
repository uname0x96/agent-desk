import Anthropic from '@anthropic-ai/sdk'
import type { ResearchInput } from '@agent-desk/schemas'

/**
 * The only place in the monorepo that talks to an LLM (AD-1: `alpha-research`
 * owns `@anthropic-ai/sdk`, and `ANTHROPIC_API_KEY` lives in this agent's env
 * schema and nowhere else).
 *
 * The port is deliberately one function — snapshot in, the model's raw answer
 * out. Parsing, the trend correction and the HOLD fallback belong to the
 * handler, so every one of those branches is testable against a stub without
 * an API key.
 */

/** AD-7: handlers keep external timeouts at or below 8 s. */
export const LLM_TIMEOUT_MS = 8_000

/** Story 2.3 names the model; `ANTHROPIC_MODEL` overrides it. */
export const DEFAULT_MODEL = 'claude-sonnet-5'

/** One JSON object with a one-sentence reason fits comfortably. */
export const MAX_OUTPUT_TOKENS = 256

/**
 * The fixed prompt. It states the direction rule the handler enforces anyway,
 * so a well-behaved answer needs no correction, and it asks for bare JSON
 * because the handler parses the text rather than a tool call.
 */
export const SYSTEM_PROMPT = [
  'You are a crypto trading research agent. You answer with one JSON object and nothing else.',
  '',
  'Shape: {"signal":"LONG"|"SHORT"|"HOLD","confidence":<number between 0 and 1>,"reason":"<one sentence>"}',
  '',
  'Rules:',
  '- signal follows the direction of change_24h_pct: LONG when it is positive, SHORT when it is negative, HOLD when it is exactly zero.',
  '- confidence is how sure you are of that signal, a number from 0 to 1.',
  '- reason is a single sentence under 200 characters that cites numbers from the snapshot you were given.',
  '- Output the JSON object only: no prose, no markdown fences, no trailing text.',
].join('\n')

/** The user turn: the market snapshot, verbatim. */
export function buildUserPrompt(input: ResearchInput): string {
  return `Market snapshot for ${input.symbol}:\n${JSON.stringify(input.market, null, 2)}`
}

/** Snapshot in, the model's raw answer text out. Rejects on error or timeout. */
export type ResearchModel = (input: ResearchInput, signal: AbortSignal) => Promise<string>

export interface AnthropicModelOptions {
  apiKey: string
  /** Defaults to `DEFAULT_MODEL`. */
  model?: string
  /** Defaults to `LLM_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Swapped for a stub in the unit tests; production uses the global fetch. */
  fetchImpl?: typeof globalThis.fetch
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmError'
  }
}

/** Concatenate the text blocks of a Messages response; ignore any other block. */
function readText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

export function createAnthropicModel(options: AnthropicModelOptions): ResearchModel {
  const model = options.model ?? DEFAULT_MODEL
  const timeout = options.timeoutMs ?? LLM_TIMEOUT_MS
  const client = new Anthropic({
    apiKey: options.apiKey,
    // The SDK retries a timed-out request twice by default, which would spend
    // three times the deadline and blow the AD-7 handler budget. One attempt.
    maxRetries: 0,
    timeout,
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
  })

  return async (input, signal) => {
    const message = await client.messages.create(
      {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        // Nothing here needs reasoning, and the 8 s deadline has no room for it.
        thinking: { type: 'disabled' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(input) }],
      },
      { timeout, maxRetries: 0, signal },
    )
    const text = readText(message)
    if (text === '') throw new LlmError('the model answered with no text')
    return text
  }
}
