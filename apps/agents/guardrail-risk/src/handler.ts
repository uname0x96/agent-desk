import type { AgentHandler } from '@agent-desk/agent-kit'
import type { Decision, RiskInput, RiskOutput, Signal } from '@agent-desk/schemas'

/**
 * FR-44, Guardrail Risk: the `risk` Type over a signal and the 24 h window the
 * `data` Node produced. The ladder below is the whole agent — it calls nothing
 * and blocks on nothing, so the handler answers well inside AD-7's budget.
 *
 * The rungs are tried in this order and the first one that fires wins:
 *
 *   1. a `HOLD` signal is refused outright
 *   2. a confident signal against the 24 h trend is refused
 *   3. volatility above 6 % is refused
 *   4. volatility above 3 % is cut to 60 % of the proposed size
 *   5. anything else is approved at the proposed size
 *
 * The size is then clamped to `balance_usdt`. A clamp only lowers the number:
 * the rung that fired still owns the decision, so a clamped APPROVE stays an
 * APPROVE (PRD addendum §1: `size_usdt` is at most `proposed_size_usdt` and at
 * most `balance_usdt`, and is `"0"` only for a REJECT).
 */

/** Above this confidence a counter-trend signal is refused. Strict: 0.85 passes. */
export const CONFIDENCE_CEILING = 0.85
/** Strict: exactly 6 % is not a reject, and falls through to the reduce rung. */
export const VOLATILITY_REJECT_PCT = 6
/** Strict: exactly 3 % is not a reduce, and is approved at the proposed size. */
export const VOLATILITY_REDUCE_PCT = 3
/** The share of `proposed_size_usdt` a REDUCE keeps. */
export const REDUCE_PERCENT = 60n

/** AD-13: sizes are decimal USDT strings; this agent answers with at most 2 decimals. */
const SIZE_DECIMALS = 2
const SCALE = 100n

/** The rule names a `reason` starts with, so a reader knows which rung fired. */
export const RULES = {
  hold: 'hold signal',
  counterTrend: 'confident counter-trend signal',
  volatilityReject: 'volatility above the reject threshold',
  volatilityReduce: 'volatility above the reduce threshold',
  withinLimits: 'within risk limits',
  clamp: 'clamped to balance_usdt',
} as const

/**
 * "100.999" -> 10099n. Truncates the digits below a cent rather than rounding:
 * a rounded-up size could land above `proposed_size_usdt` or `balance_usdt`,
 * which `validateOutput` refuses. The input schema has already established
 * that `value` is a non-negative decimal string.
 */
export function toHundredths(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole + fraction.slice(0, SIZE_DECIMALS).padEnd(SIZE_DECIMALS, '0'))
}

/** 10099n -> "100.99", 6000n -> "60", 30n -> "0.3". Trailing zeros are noise. */
export function fromHundredths(amount: bigint): string {
  const whole = amount / SCALE
  const fraction = amount % SCALE
  if (fraction === 0n) return whole.toString()
  const digits = fraction.toString().padStart(SIZE_DECIMALS, '0').replace(/0$/, '')
  return `${whole}.${digits}`
}

/**
 * A signal opposes the trend when it bets against the sign of the 24 h change:
 * LONG into a falling market, SHORT into a rising one. A change of exactly 0
 * has no sign, so nothing opposes it. `HOLD` never reaches here — rung 1
 * already answered it — and bets on nothing either way.
 */
export function opposesTrend(signal: Signal, change24hPct: number): boolean {
  if (signal === 'LONG') return change24hPct < 0
  if (signal === 'SHORT') return change24hPct > 0
  return false
}

function reject(reason: string): RiskOutput {
  return { decision: 'REJECT', size_usdt: '0', reason }
}

/**
 * The clamp. `balance_usdt` is the ceiling on every size this agent answers
 * with; hitting it names itself in the reason and leaves the decision alone.
 */
function sized(
  decision: Extract<Decision, 'APPROVE' | 'REDUCE'>,
  size: bigint,
  balance: bigint,
  reason: string,
): RiskOutput {
  const clamped = size > balance ? balance : size
  return {
    decision,
    size_usdt: fromHundredths(clamped),
    reason:
      clamped === size ? reason : `${reason}; ${RULES.clamp} ${fromHundredths(balance)}`,
  }
}

export function decide(input: RiskInput): RiskOutput {
  if (input.signal === 'HOLD') return reject(RULES.hold)

  const { change_24h_pct: change, volatility_24h_pct: volatility } = input.market
  const proposed = toHundredths(input.proposed_size_usdt)
  const balance = toHundredths(input.balance_usdt)

  if (input.confidence > CONFIDENCE_CEILING && opposesTrend(input.signal, change)) {
    return reject(
      `${RULES.counterTrend}: ${input.signal} at confidence ${input.confidence} above ` +
        `${CONFIDENCE_CEILING} against a ${change}% 24h change`,
    )
  }

  if (volatility > VOLATILITY_REJECT_PCT) {
    return reject(
      `${RULES.volatilityReject}: 24h volatility ${volatility}% above ${VOLATILITY_REJECT_PCT}%`,
    )
  }

  if (volatility > VOLATILITY_REDUCE_PCT) {
    return sized(
      'REDUCE',
      (proposed * REDUCE_PERCENT) / SCALE,
      balance,
      `${RULES.volatilityReduce}: 24h volatility ${volatility}% above ${VOLATILITY_REDUCE_PCT}%, ` +
        `sized to ${REDUCE_PERCENT}% of the proposed size`,
    )
  }

  return sized(
    'APPROVE',
    proposed,
    balance,
    `${RULES.withinLimits}: 24h volatility ${volatility}% at or below ${VOLATILITY_REDUCE_PCT}%`,
  )
}

/** Nothing to configure: the ladder needs only the request it was paid for. */
export const riskHandler: AgentHandler<'risk'> = (input) => decide(input)
