import type { AgentHandler } from '@agent-desk/agent-kit'
import type { ResearchOutput, Signal } from '@agent-desk/schemas'

/**
 * FR-44, Sloppy Research: the `research` Type, fading the 24 h move.
 *
 * This agent is deliberately, confidently wrong. It is the "before" half of
 * the Provider swap in the demo (PRD addendum section 2): it takes the sign of
 * `change_24h_pct` and answers the opposite direction at confidence 0.9, so it
 * fails the demo Settlement rule every time while Alpha Research passes it.
 * Do not "fix" the direction; the demo depends on it.
 *
 * It touches nothing outside its own input, so it always answers well inside
 * the 100 ms the acceptance criteria allow.
 */

/** Same string for every request: a stopped clock with an opinion. */
export const SLOPPY_REASON =
  'Every 24 h move mean-reverts, so we fade it and take the other side.'

/** Sloppy Research never doubts itself. */
export const SLOPPY_CONFIDENCE = 0.9

/** LONG on a fall, SHORT on a rise, HOLD only on an exactly flat window. */
export function contrarianSignal(change24hPct: number): Signal {
  if (change24hPct < 0) return 'LONG'
  if (change24hPct > 0) return 'SHORT'
  return 'HOLD'
}

export function createSloppyHandler(): AgentHandler<'research'> {
  return (input): ResearchOutput => ({
    signal: contrarianSignal(input.market.change_24h_pct),
    confidence: SLOPPY_CONFIDENCE,
    reason: SLOPPY_REASON,
  })
}
