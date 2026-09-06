import { runWithBudget, type AgentHandler } from '@agent-desk/agent-kit'
import { validateOutput, type ResearchOutput, type Signal } from '@agent-desk/schemas'
import { LLM_TIMEOUT_MS, type ResearchModel } from './model.ts'

/**
 * FR-44, Alpha Research: the `research` Type over an LLM.
 *
 * The handler asks the model for a signal, a confidence and a one-sentence
 * reason, then applies two guards the demo depends on:
 *
 *  - the model call has an 8 s deadline, and any error, timeout or unparsable
 *    answer becomes the fallback below rather than a failed Call;
 *  - the signal is forced to follow the sign of `change_24h_pct`, so the
 *    agent follows the trend by construction whatever the model says.
 *
 * Everything about the 402, the outer validation, the 10 s budget and the
 * replay cache belongs to `createAgent` (AD-7).
 */

/** PRD addendum section 2: HOLD at confidence 0.5 whenever the LLM cannot answer. */
export const FALLBACK_OUTPUT: ResearchOutput = {
  signal: 'HOLD',
  confidence: 0.5,
  reason: 'LLM unavailable, holding',
}

/** The `research` output schema caps `reason`. */
const MAX_REASON_CHARS = 500

/** The trend-following signal for a 24 h change: the direction of its sign. */
export function trendSignal(change24hPct: number): Signal {
  if (change24hPct > 0) return 'LONG'
  if (change24hPct < 0) return 'SHORT'
  return 'HOLD'
}

/**
 * The model is asked for bare JSON but may still wrap it in a fence or a
 * sentence, so read the outermost braces rather than the whole string.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** Collapse the model's line breaks and keep the reason inside the schema's cap. */
function tidyReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS)
}

/**
 * The model's answer, or null when it is unusable. "Unusable" is exactly what
 * the `research` output schema refuses: an unknown signal, a confidence
 * outside [0, 1], an empty reason. Those all end at the same fallback.
 */
export function readModelAnswer(raw: string): ResearchOutput | null {
  const parsed = extractJsonObject(raw)
  if (parsed === null) return null
  const candidate =
    typeof parsed.reason === 'string' ? { ...parsed, reason: tidyReason(parsed.reason) } : parsed
  const checked = validateOutput('research', undefined, candidate)
  return checked.ok ? (checked.value as ResearchOutput) : null
}

export interface AlphaHandlerOptions {
  model: ResearchModel
  /** Defaults to `LLM_TIMEOUT_MS`; the tests shorten it. */
  timeoutMs?: number
}

export function createAlphaHandler(options: AlphaHandlerOptions): AgentHandler<'research'> {
  const timeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS

  return async (input, context): Promise<ResearchOutput> => {
    // The trend the answer has to agree with, decided before the model runs.
    const trend = trendSignal(input.market.change_24h_pct)

    let raw: string
    try {
      raw = await runWithBudget(
        (deadline) => options.model(input, AbortSignal.any([context.signal, deadline])),
        timeoutMs,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      context.logger.warn({ reason, timeout_ms: timeoutMs }, 'model call failed, holding')
      return FALLBACK_OUTPUT
    }

    const answer = readModelAnswer(raw)
    if (answer === null) {
      context.logger.warn({ raw }, 'model answer was unparsable, holding')
      return FALLBACK_OUTPUT
    }

    // Story 2.3: an answer that does not follow the sign of change_24h_pct is
    // replaced by the trend-following signal, keeping the model's reason and
    // confidence, "so the agent follows the trend by construction". That is
    // read as: the answered signal is always the trend signal. A HOLD on a
    // moving market is corrected for the same reason a reversed signal is —
    // it does not follow the trend either, and Alpha Research is the Provider
    // the demo Settlement rule is meant to reward.
    if (answer.signal !== trend) {
      context.logger.info(
        { model_signal: answer.signal, trend, change_24h_pct: input.market.change_24h_pct },
        'model signal did not follow the trend, replaced',
      )
      return { ...answer, signal: trend }
    }
    return answer
  }
}
