import type { SettlementResult } from '@agent-desk/schemas'

/**
 * FR-36 / AD-9: "Reputation = `passed / (passed + failed)` over the last 30 rows
 * with result in (`passed`, `failed`), written under the `reputation:` key only
 * when a `passed` or `failed` row is added."
 *
 * The caller hands in that window already ordered by `scored_at` descending, so
 * this file holds only the arithmetic and the "no score yet" case. Keeping the
 * window size here rather than in the query is what stops the marketplace's
 * scored-Call label and the on-chain number being computed over two different
 * windows.
 */

/** AD-9: the last 30 scored Calls. */
export const REPUTATION_WINDOW = 30

/** The Registry stores basis points; 10 000 is a perfect score. */
export const MAX_REPUTATION_BPS = 10_000

/** The only two results that count toward Reputation. A `not_scored` row does not. */
export const SCORED_RESULTS: readonly SettlementResult[] = ['passed', 'failed']

export function isScoredResult(result: SettlementResult): result is 'passed' | 'failed' {
  return result === 'passed' || result === 'failed'
}

/**
 * Basis points over the newest {@link REPUTATION_WINDOW} scored results, or
 * null when there are none — AD-9's "zero rows means 'no score yet'", which the
 * marketplace renders instead of a misleading 0 %.
 *
 * `results` may be longer than the window; only its head is read, so a caller
 * that over-fetches gets the same answer as one that did not. Rounding is to
 * the nearest basis point: two of three passing is 6 667, not 6 666, and a
 * clean sweep is exactly 10 000.
 */
export function reputationBps(results: readonly SettlementResult[]): number | null {
  const window = results.filter(isScoredResult).slice(0, REPUTATION_WINDOW)
  if (window.length === 0) return null
  const passed = window.filter((result) => result === 'passed').length
  return Math.round((passed * MAX_REPUTATION_BPS) / window.length)
}

/** How the marketplace prints it: `null` stays "no score yet" (AD-9). */
export function reputationPercent(bps: number | null): string | null {
  return bps === null ? null : `${Math.round(bps / 100)}%`
}
