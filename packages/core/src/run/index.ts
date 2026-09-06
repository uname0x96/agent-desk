/**
 * AD-4: the Run state machine and the two pure rules that hang off it — the
 * AD-6 Price Lock comparison and the PRD addendum §1 input mapping.
 *
 * Everything exported here is a decision over values. The engine that carries
 * those decisions to Postgres, the chain and the Agents is
 * `apps/worker/src/jobs/run`.
 */
export {
  MAX_PAID_ATTEMPTS,
  RUN_DEADLINE_MS,
  RUN_SWEEP_GRACE_MS,
  SCORED_NODE_TYPES,
  TIMED_OUT,
  assertCallStatus,
  assertCallTransition,
  assertRunStatus,
  assertRunTransition,
  callsInNodeOrder,
  canTransitionCall,
  canTransitionRun,
  deadlineFor,
  failureStatus,
  firstUnfinishedCall,
  isCallPaid,
  isCallStatus,
  isCallTerminal,
  isPastDeadline,
  isRunStatus,
  isRunStuck,
  isScoredNodeType,
  isSweepable,
  nextStep,
  pendingCallIds,
  successStatus,
  sweepClockOf,
  type CallState,
  type RunOutcomeInput,
  type RunState,
  type RunStep,
  type RunWriteResult,
  type SweepClock,
} from './machine.ts'
export {
  MISMATCH_FIELDS,
  caseInsensitiveAddressEquals,
  comparePriceLock,
  describeMismatch,
  lockTermsFor,
  type AcceptsEntry,
  type AddressEquals,
  type Eip712Domain,
  type LockTerms,
  type MismatchField,
  type PriceLockComparison,
  type PriceLockMismatch,
} from './price-lock.ts'
export { compareDecimal, isDecimalAmount } from './decimal.ts'
export {
  EXCHANGE_MIN_NOTIONAL_USDT,
  REFUSALS,
  buildNodeInput,
  dataOutputOf,
  executionOutputOf,
  researchOutputOf,
  riskOutputOf,
  sideFor,
  skipReasonFor,
  type NodeInputContext,
  type NodeInputResult,
} from './inputs.ts'
export {
  buildNotifyInput,
  summarize,
  type NotifyCallRecord,
  type NotifyContext,
  type NotifyInputResult,
  type RunOutcome,
} from './notify.ts'
