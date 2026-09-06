import {
  PRICE_SOURCE,
  type AgentType,
  type CallKind,
  type CallStatus,
  type NotScoredReason,
  type PlatformMode,
  type SettlementResult,
  type Side,
  type Signal,
} from '@agent-desk/schemas'
import type { KlineInterval } from '../ports/index.ts'
import { SCORED_NODE_TYPES, isScoredNodeType } from '../run/machine.ts'
import { modeConstants } from '../mode/index.ts'
import { FAILED_AFTER_PAYMENT_RULE_LABEL, RISK_RULE_LABEL, scoreResearchDemo, scoreResearchProduction, scoreRisk } from './rules.ts'

export { SCORED_NODE_TYPES, isScoredNodeType }

/**
 * AD-9 as a decision over values: given one candidate Call and the mode read at
 * tick time, what — if anything — should the `settlements` row say?
 *
 * The split is deliberate. {@link planSettlement} answers everything that does
 * not need a price: whether the Call is scorable at all, whether its window has
 * closed, and the four rows that carry no prices (`failed after payment`, and
 * the three `not_scored` reasons). When a price *is* needed it answers a
 * {@link MarketDataNeed} — the exact `MarketData` read to make, and nothing
 * more — which the worker performs and hands back to
 * {@link settleWithMarketData}.
 *
 * So the whole of AD-9's judgement is pure and exhaustively testable, and the
 * worker's half is one HTTP read it cannot get wrong: a failed read simply
 * never reaches {@link settleWithMarketData}, and the Call stays unscored for
 * the next tick, which is what Story 4.1 requires.
 */

// ------------------------------------------------------------------ inputs

export interface SettlementContext {
  /** `platform_settings.mode`, re-read at tick time; it governs the whole row. */
  mode: PlatformMode
  now: Date
}

/**
 * The Run's `execution` Call, when it has one. AD-9: `p_fill` for a `risk` row
 * is that Call's `reference_price`, and the side is the one the engine actually
 * sent (`LONG` -> `BUY`, `SHORT` -> `SELL`).
 */
export interface ExecutionFill {
  callId: string
  /** `FILLED` is the only status that yields a fill; anything else is `no_fill`. */
  filled: boolean
  /** Decimal USDT, or null when the reference read failed at fill time. */
  referencePrice: string | null
  side: Side | null
}

/** Everything AD-9 reads about one Call, and nothing else. */
export interface SettlementCandidate {
  callId: string
  listingId: string
  runId: string | null
  kind: CallKind
  nodeType: AgentType
  status: CallStatus
  /** `calls.ended_at`: the window starts here (AD-9). */
  endedAt: Date | null
  /** `calls.reference_price`, decimal USDT; the research start price. */
  referencePrice: string | null
  /** `workflows.symbol`, the market every price is read against. */
  symbol: string
  /** The validated Type output on the Call row. */
  response: unknown
  /** `runs.ended_at`; null while the Run is still running. */
  runEndedAt: Date | null
  fill: ExecutionFill | null
}

// ----------------------------------------------------------------- outputs

/** Exactly the `settlements` columns this story's row writes. */
export interface SettlementRowPlan {
  callId: string
  listingId: string
  result: SettlementResult
  notScoredReason: NotScoredReason | null
  mode: PlatformMode
  ruleLabel: string
  startPrice: string | null
  endPrice: string | null
  change24hPct: number | null
  pFill: string | null
  windowMin: string | null
  windowMax: string | null
  /** AD-9 allows one source and this is it. */
  priceSource: typeof PRICE_SOURCE
  scoredAt: Date
}

/**
 * Why a candidate was left alone this tick. Every one of these is temporary
 * except `not_scorable`, which means the Call was never AD-9's business.
 */
export const DEFER_REASONS = [
  'not_scorable',
  'not_ended',
  'window_open',
  'run_running',
  'unreadable_response',
] as const
export type DeferReason = (typeof DEFER_REASONS)[number]

/** The one `MarketData` read a candidate needs, fully specified. */
export type MarketDataNeed =
  | {
      rule: 'window price move'
      symbol: string
      signal: Signal
      /** The Call's own `reference_price` (AD-9). */
      startPrice: string
    }
  | {
      rule: '24h trend'
      symbol: string
      signal: Signal
      /** Recorded on the row even in demo mode, where the rule does not read it. */
      startPrice: string
    }
  | {
      rule: 'drawdown'
      symbol: string
      side: Side
      pFill: string
      interval: KlineInterval
      /** Milliseconds since the epoch, `calls.ended_at`. */
      startTime: number
      /** Milliseconds since the epoch, `calls.ended_at` plus the mode's window. */
      endTime: number
    }

/** What the worker read, handed straight back. */
export type MarketObservation =
  | { rule: 'window price move'; endPrice: string }
  | { rule: '24h trend'; change24hPct: number }
  | { rule: 'drawdown'; windowMin: string | null; windowMax: string | null }

export type SettlementStep =
  | { kind: 'defer'; reason: DeferReason }
  | { kind: 'write'; row: SettlementRowPlan }
  | { kind: 'score'; need: MarketDataNeed }

// ------------------------------------------------------------- selection

/**
 * FR-11, as the team's override to AD-3 and AD-9 states it: a `verification`
 * Call is never scored and never reserves Stake, at any status. Scoring one
 * would slash a Listing seconds after it went live for an answer nobody paid a
 * Run for, so `kind` is checked before anything else.
 *
 * `data`, `execution`, and `notify` Calls are never selected either: AD-9
 * scores `research` and `risk` and nothing else.
 */
export function isScorableCall(candidate: Pick<SettlementCandidate, 'kind' | 'nodeType' | 'status'>): boolean {
  if (candidate.kind !== 'run') return false
  if (!isScoredNodeType(candidate.nodeType)) return false
  return candidate.status === 'succeeded' || candidate.status === 'failed_after_payment'
}

/** AD-9: the window runs from `calls.ended_at` for the mode's Settlement Window. */
export function windowEnd(endedAt: Date, mode: PlatformMode): Date {
  return new Date(endedAt.getTime() + modeConstants(mode).settlementWindowMs)
}

// -------------------------------------------------------------- planning

export function planSettlement(
  candidate: SettlementCandidate,
  context: SettlementContext,
): SettlementStep {
  if (!isScorableCall(candidate)) return defer('not_scorable')

  // Story 4.2 / addendum §4: a `research` or `risk` Agent that took payment and
  // then failed is scored failed at the moment of failure, with no window and
  // no prices. `scored_at` is the Call's own `ended_at`, not the tick's clock,
  // so a row written by the periodic sweep records the same instant as one
  // written by the targeted `settlement.tick` job.
  if (candidate.status === 'failed_after_payment') {
    if (!candidate.endedAt) return defer('not_ended')
    return write({
      ...blank(candidate, context),
      result: 'failed',
      ruleLabel: FAILED_AFTER_PAYMENT_RULE_LABEL,
      scoredAt: candidate.endedAt,
    })
  }

  if (!candidate.endedAt) return defer('not_ended')
  return candidate.nodeType === 'research'
    ? planResearch(candidate, context, candidate.endedAt)
    : planRisk(candidate, context, candidate.endedAt)
}

function planResearch(
  candidate: SettlementCandidate,
  context: SettlementContext,
  endedAt: Date,
): SettlementStep {
  const constants = modeConstants(context.mode)

  // AD-9: the research start price is the Call's own `reference_price`, and a
  // failed read leaves it null (AD-3). Such a Call can never become scorable,
  // so it is settled now rather than after the window: waiting would hold the
  // Listing's Stake reservation for an hour for a row whose answer is already
  // known.
  if (candidate.referencePrice === null) {
    return write({
      ...blank(candidate, context),
      result: 'not_scored',
      notScoredReason: 'no_reference_price',
      ruleLabel: constants.researchRuleLabel,
      scoredAt: context.now,
    })
  }

  if (context.now < windowEnd(endedAt, context.mode)) return defer('window_open')

  const signal = signalOf(candidate.response)
  if (signal === null) return defer('unreadable_response')

  return {
    kind: 'score',
    need:
      constants.researchRule === '24h trend'
        ? { rule: '24h trend', symbol: candidate.symbol, signal, startPrice: candidate.referencePrice }
        : {
            rule: 'window price move',
            symbol: candidate.symbol,
            signal,
            startPrice: candidate.referencePrice,
          },
  }
}

function planRisk(
  candidate: SettlementCandidate,
  context: SettlementContext,
  endedAt: Date,
): SettlementStep {
  const decision = decisionOf(candidate.response)
  if (decision === null) return defer('unreadable_response')

  // FR-24: a REJECT skips the `execution` Node, so there is no fill to measure a
  // drawdown against and never will be. AD-9 makes that a `not_scored` row
  // rather than a wait.
  if (decision === 'REJECT') {
    return write({
      ...blank(candidate, context),
      result: 'not_scored',
      notScoredReason: 'reject_decision',
      ruleLabel: RISK_RULE_LABEL,
      scoredAt: context.now,
    })
  }

  // An APPROVE or REDUCE waits for its Run: the `execution` Call that would
  // supply `p_fill` may not have been made yet.
  if (candidate.runEndedAt === null) return defer('run_running')

  const fill = candidate.fill
  // AD-9: "absent that the row is `not_scored` on the first tick after the Run
  // ends". Both halves of "absent" land here — no `FILLED` execution Call at
  // all, and a `FILLED` one whose reference read failed — because `no_fill` is
  // the only reason of the three that describes either.
  if (!fill || !fill.filled || fill.referencePrice === null || fill.side === null) {
    return write({
      ...blank(candidate, context),
      result: 'not_scored',
      notScoredReason: 'no_fill',
      ruleLabel: RISK_RULE_LABEL,
      scoredAt: context.now,
    })
  }

  const end = windowEnd(endedAt, context.mode)
  if (context.now < end) return defer('window_open')

  return {
    kind: 'score',
    need: {
      rule: 'drawdown',
      symbol: candidate.symbol,
      side: fill.side,
      pFill: fill.referencePrice,
      interval: modeConstants(context.mode).klineInterval,
      startTime: endedAt.getTime(),
      endTime: end.getTime(),
    },
  }
}

// --------------------------------------------------------------- scoring

/**
 * The second half of a `score` step: the rule of PRD addendum §4 applied to
 * what the worker read. A `drawdown` observation with no klines in the window
 * is a read that answered nothing, so it defers rather than scoring a Call
 * against a price that does not exist.
 */
export function settleWithMarketData(
  candidate: SettlementCandidate,
  context: SettlementContext,
  need: MarketDataNeed,
  observation: MarketObservation,
): SettlementStep {
  if (need.rule !== observation.rule) {
    throw new Error(`settlement observation ${observation.rule} does not answer need ${need.rule}`)
  }
  const constants = modeConstants(context.mode)
  const base = blank(candidate, context)

  if (need.rule === 'window price move' && observation.rule === 'window price move') {
    return write({
      ...base,
      result: scoreResearchProduction(need.signal, need.startPrice, observation.endPrice),
      ruleLabel: constants.researchRuleLabel,
      startPrice: need.startPrice,
      endPrice: observation.endPrice,
      scoredAt: context.now,
    })
  }

  if (need.rule === '24h trend' && observation.rule === '24h trend') {
    return write({
      ...base,
      result: scoreResearchDemo(need.signal, observation.change24hPct),
      ruleLabel: constants.researchRuleLabel,
      startPrice: need.startPrice,
      change24hPct: observation.change24hPct,
      scoredAt: context.now,
    })
  }

  if (need.rule === 'drawdown' && observation.rule === 'drawdown') {
    const extreme = need.side === 'BUY' ? observation.windowMin : observation.windowMax
    if (extreme === null) return defer('window_open')
    return write({
      ...base,
      result: scoreRisk(need.side, need.pFill, observation.windowMin, observation.windowMax),
      ruleLabel: RISK_RULE_LABEL,
      pFill: need.pFill,
      // Story 4.1 asks for "the window min *or* max"; the Settlement view
      // prints "the prices used", so the extreme the rule did not read stays
      // null rather than dressing the row with a number nobody applied.
      windowMin: need.side === 'BUY' ? observation.windowMin : null,
      windowMax: need.side === 'SELL' ? observation.windowMax : null,
      scoredAt: context.now,
    })
  }

  throw new Error(`unhandled settlement rule ${need.rule}`)
}

// ---------------------------------------------------------------- helpers

function blank(candidate: SettlementCandidate, context: SettlementContext): SettlementRowPlan {
  return {
    callId: candidate.callId,
    listingId: candidate.listingId,
    result: 'not_scored',
    notScoredReason: null,
    mode: context.mode,
    ruleLabel: '',
    startPrice: null,
    endPrice: null,
    change24hPct: null,
    pFill: null,
    windowMin: null,
    windowMax: null,
    priceSource: PRICE_SOURCE,
    scoredAt: context.now,
  }
}

function write(row: SettlementRowPlan): SettlementStep {
  return { kind: 'write', row }
}

function defer(reason: DeferReason): SettlementStep {
  return { kind: 'defer', reason }
}

/**
 * A `succeeded` Call's response went through `validateOutput` before it was
 * stored, so these narrow it without re-running the schema — the same approach
 * `core/run/inputs.ts` takes with the outputs it feeds the next Node.
 */
export function signalOf(response: unknown): Signal | null {
  const value = asRecord(response)
  const signal = value?.signal
  return signal === 'LONG' || signal === 'SHORT' || signal === 'HOLD' ? signal : null
}

export function decisionOf(response: unknown): 'APPROVE' | 'REDUCE' | 'REJECT' | null {
  const value = asRecord(response)
  const decision = value?.decision
  return decision === 'APPROVE' || decision === 'REDUCE' || decision === 'REJECT' ? decision : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}
