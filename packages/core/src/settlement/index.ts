/**
 * AD-9 / PRD addendum §4: the Settlement rules, as decisions over values.
 *
 * Everything here is pure — no clock beyond the `now` a caller passes, no
 * database, no market data read. The worker that carries these decisions to
 * Postgres and to the Registry is `apps/worker/src/jobs/settlement`.
 *
 * That split is the point of AD-1 here: a wrong rule in this file slashes a
 * Creator's Stake for an answer that was right, so the rules are written where
 * a test can enumerate every branch of them without a network.
 */
export {
  align,
  isDecimalAmount,
  ratio,
  ratioAtMost,
  relativeGapBelow,
  type Fraction,
} from './decimal.ts'
export {
  FAILED_AFTER_PAYMENT_RULE_LABEL,
  HOLD_BAND_PCT,
  HOLD_BAND_RELATIVE,
  MAX_DRAWDOWN,
  RISK_RULE_LABEL,
  riskDrawdown,
  scoreResearchDemo,
  scoreResearchProduction,
  scoreRisk,
  type ScoreOutcome,
} from './rules.ts'
export {
  MAX_REPUTATION_BPS,
  REPUTATION_WINDOW,
  SCORED_RESULTS,
  isScoredResult,
  reputationBps,
  reputationPercent,
} from './reputation.ts'
export {
  DEFER_REASONS,
  SCORED_NODE_TYPES,
  decisionOf,
  isScorableCall,
  isScoredNodeType,
  planSettlement,
  settleWithMarketData,
  signalOf,
  windowEnd,
  type DeferReason,
  type ExecutionFill,
  type MarketDataNeed,
  type MarketObservation,
  type SettlementCandidate,
  type SettlementContext,
  type SettlementRowPlan,
  type SettlementStep,
} from './plan.ts'
