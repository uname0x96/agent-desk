import {
  CALL_STATUSES,
  PAID_CALL_STATUSES,
  RUN_STATUSES,
  TERMINAL_CALL_STATUSES,
  X402_MAX_PAID_ATTEMPTS,
  failedAt,
  type AgentType,
  type CallStatus,
  type RunStatus,
  type RunStatusLiteral,
} from '@agent-desk/schemas'

/**
 * AD-4: the Run state machine. Only the worker transitions Runs and Calls, and
 * it does it through this file.
 *
 * Everything here is a pure decision over values. AD-1 is machine-enforced for
 * this module: it imports `@agent-desk/schemas` and nothing else — no viem, no
 * drizzle, no database. The I/O that carries a decision out lives in
 * `apps/worker/src/jobs/run`, which is also the only place that knows a
 * compare-and-set updated zero rows.
 *
 * The three rules this module exists to keep in one place:
 *
 *   1. only the PRD enums are ever written, and only along a transition the
 *      enums allow (`callTransition`, `runTransition`);
 *   2. a `run.execute` — first delivery or redelivery after a crash — always
 *      resumes from the first non-terminal Call, and the paid retry and the
 *      crash resume are the same decision (`nextStep`);
 *   3. the 120 s budget is measured from `runs.started_at` and checked before
 *      each Node and each paid retry (`isPastDeadline`).
 */

// ------------------------------------------------------------------ budgets

/** AD-4 / FR-30: the Run budget, measured from `runs.started_at`. */
export const RUN_DEADLINE_MS = 120_000
/** AD-4: the extra grace the settlement sweep waits before calling a Run `timed out`. */
export const RUN_SWEEP_GRACE_MS = 45_000
/** AD-6: at most two paid attempts, the second with the same header. */
export const MAX_PAID_ATTEMPTS = X402_MAX_PAID_ATTEMPTS

// ------------------------------------------------------------ status guards

const CALL_STATUS_SET = new Set<string>(CALL_STATUSES)
const RUN_LITERAL_SET = new Set<string>(RUN_STATUSES)
const TERMINAL_CALL_SET = new Set<string>(TERMINAL_CALL_STATUSES)
const PAID_CALL_SET = new Set<string>(PAID_CALL_STATUSES)

export function isCallStatus(value: string): value is CallStatus {
  return CALL_STATUS_SET.has(value)
}

export function assertCallStatus(value: string): CallStatus {
  if (!isCallStatus(value)) throw new Error(`not a Call status: ${value}`)
  return value
}

export function isCallTerminal(status: string): boolean {
  return TERMINAL_CALL_SET.has(status)
}

/** AD-3: a Call in one of these statuses has been paid for. */
export function isCallPaid(status: string): boolean {
  return PAID_CALL_SET.has(status)
}

export function isRunStatus(value: string): value is RunStatus {
  return RUN_LITERAL_SET.has(value) || value.startsWith('failed at ')
}

export function assertRunStatus(value: string): RunStatus {
  if (!isRunStatus(value)) throw new Error(`not a Run status: ${value}`)
  return value
}

// --------------------------------------------------------------- transitions

/**
 * Every Call transition this system performs, and no others. `pending` may
 * refuse before paying, pay, or be skipped; a paid Call resolves to one of the
 * three AD-6 outcomes, including `payment_failed` for an authorization the
 * chain reports unused. Terminal statuses have no successor.
 */
const CALL_TRANSITIONS: Record<CallStatus, readonly CallStatus[]> = {
  pending: ['price_mismatch', 'payment_failed', 'paid_awaiting_result', 'skipped'],
  paid_awaiting_result: ['succeeded', 'failed_after_payment', 'payment_failed'],
  price_mismatch: [],
  payment_failed: [],
  succeeded: [],
  failed_after_payment: [],
  skipped: [],
}

export function canTransitionCall(from: string, to: string): boolean {
  if (!isCallStatus(from) || !isCallStatus(to)) return false
  return CALL_TRANSITIONS[from].includes(to)
}

export function assertCallTransition(from: string, to: string): CallStatus {
  if (!canTransitionCall(from, to)) {
    throw new Error(`Call cannot move from ${from} to ${to}`)
  }
  return to as CallStatus
}

/**
 * AD-4: every Run status write is a compare-and-set from `running`. There is no
 * transition out of a terminal Run status, which is exactly why the engine's
 * write can lose: another writer — the timeout sweep, or a second delivery —
 * already moved the row.
 */
export function canTransitionRun(from: string, to: string): boolean {
  return from === 'running' && isRunStatus(to) && to !== 'running'
}

export function assertRunTransition(from: string, to: string): RunStatus {
  if (!canTransitionRun(from, to)) {
    throw new Error(`Run cannot move from ${from} to ${to}`)
  }
  return to as RunStatus
}

/** The outcome of a compare-and-set Run write, as the engine must branch on it. */
export type RunWriteResult = 'applied' | 'lost'

// -------------------------------------------------------------------- state

/** What the machine needs to know about one Call. Nothing database-shaped. */
export interface CallState {
  callId: string
  nodeIndex: number
  nodeType: AgentType
  status: CallStatus
  /** AD-6: paid attempts already sent for this Call, 0, 1 or 2. */
  attempt: number
  /** True once `signPayment` has stored an authorization (AD-5), so a retry has a header. */
  hasPaymentPayload: boolean
}

export interface RunState {
  runId: string
  status: string
  startedAt: Date | null
  calls: readonly CallState[]
}

/**
 * What the engine does next.
 *
 * `resend` covers two situations that are deliberately one decision: the paid
 * retry after a 15 s timeout, and a `run.execute` redelivered after a crash
 * that finds a Call already `paid_awaiting_result` with a header on the row. In
 * both cases the same header goes out again and nothing is signed a second
 * time (AD-5, FR-25).
 */
export type RunStep =
  | { kind: 'call'; call: CallState }
  | { kind: 'resend'; call: CallState }
  | { kind: 'resolve'; call: CallState }
  | { kind: 'finish' }

/** Node order is the Run's order; the caller never has to sort first. */
export function callsInNodeOrder(calls: readonly CallState[]): readonly CallState[] {
  return [...calls].sort((left, right) => left.nodeIndex - right.nodeIndex)
}

export function firstUnfinishedCall(calls: readonly CallState[]): CallState | null {
  return callsInNodeOrder(calls).find((call) => !isCallTerminal(call.status)) ?? null
}

/** AD-4: continue from the first non-terminal Call, whatever brought us here. */
export function nextStep(run: Pick<RunState, 'calls'>): RunStep {
  const call = firstUnfinishedCall(run.calls)
  if (!call) return { kind: 'finish' }
  if (call.status === 'pending') return { kind: 'call', call }
  if (call.attempt < MAX_PAID_ATTEMPTS && call.hasPaymentPayload) return { kind: 'resend', call }
  // Both paid attempts are spent, or the row says `paid_awaiting_result` with no
  // authorization to resend; AD-6 resolves it from the chain.
  return { kind: 'resolve', call }
}

// ----------------------------------------------------------------- deadline

export function deadlineFor(startedAt: Date, budgetMs: number = RUN_DEADLINE_MS): Date {
  return new Date(startedAt.getTime() + budgetMs)
}

/**
 * AD-4: checked before each Node and before each paid retry. A Run the worker
 * has not started yet has no deadline, so it can never be past one.
 */
export function isPastDeadline(
  startedAt: Date | null,
  now: Date,
  budgetMs: number = RUN_DEADLINE_MS,
): boolean {
  if (!startedAt) return false
  return now.getTime() >= deadlineFor(startedAt, budgetMs).getTime()
}

/**
 * AD-4 / Story 2.9: the settlement loop's rule, 120 s plus 45 s of grace, so the
 * sweep never races the engine's own deadline check.
 */
export function isSweepable(
  startedAt: Date | null,
  now: Date,
  budgetMs: number = RUN_DEADLINE_MS,
  graceMs: number = RUN_SWEEP_GRACE_MS,
): boolean {
  return isPastDeadline(startedAt, now, budgetMs + graceMs)
}

/** What the sweep needs to know about a Run to decide it is stuck. */
export interface SweepClock {
  startedAt: Date | null
  /** `runs.created_at`, written by the insert that made the Run `running`. */
  createdAt: Date
}

/**
 * Story 2.9: the clock the sweep measures against, which is *not* the engine's.
 *
 * The engine's 120 s budget runs from `started_at`, because that is when the
 * worker picked the Run up and began spending it. The sweep cannot use the same
 * rule: the Run it exists to rescue is the one whose worker died — possibly
 * before it ever set `started_at` — and `isPastDeadline(null, …)` is false
 * forever, which is precisely how a Run comes to sit in `running` with nothing
 * left to move it. Falling back to `created_at` bounds every `running` Run,
 * started or not, and the 45 s of grace keeps the sweep off the engine's heels.
 */
export function sweepClockOf(run: SweepClock): Date {
  return run.startedAt ?? run.createdAt
}

/** Story 2.9: the same rule as {@link isSweepable}, over the sweep's own clock. */
export function isRunStuck(
  run: SweepClock,
  now: Date,
  budgetMs: number = RUN_DEADLINE_MS,
  graceMs: number = RUN_SWEEP_GRACE_MS,
): boolean {
  return isSweepable(sweepClockOf(run), now, budgetMs, graceMs)
}

// -------------------------------------------------------------- run outcome

export interface RunOutcomeInput {
  /** True when the Workflow declares an `execution` Node at all. */
  hasExecutionNode: boolean
  /** Story 2.8 sets this from the `execution` Call's `FILLED` output. */
  executionFilled?: boolean
}

/**
 * AD-4: a Run ends `completed` only when an `execution` Call returned `FILLED`
 * or the Workflow has no `execution` Node; every other successful end — a
 * `REJECTED` execution, a skipped one — is `completed, no order`.
 */
export function successStatus(input: RunOutcomeInput): RunStatusLiteral {
  if (!input.hasExecutionNode) return 'completed'
  return input.executionFilled === true ? 'completed' : 'completed, no order'
}

/** AD-4: `<Node>` is the Type name of the Call that failed. */
export function failureStatus(nodeType: AgentType): RunStatus {
  return failedAt(nodeType)
}

/**
 * AD-9: `research` and `risk` are the only Types that are ever scored, so they
 * are the only ones that reserve Stake and the only ones the engine publishes a
 * `settlement.tick` for (Story 2.9).
 *
 * `packages/db` states the same two Types for its reservation query. The
 * duplication is deliberate: AD-1 forbids core from importing the database
 * package, and the engine reads this rule on a path that must not know one
 * exists. Both lists are two words long and both cite AD-9.
 */
export const SCORED_NODE_TYPES: readonly AgentType[] = ['research', 'risk']

const SCORED_NODE_TYPE_SET = new Set<string>(SCORED_NODE_TYPES)

export function isScoredNodeType(nodeType: string): boolean {
  return SCORED_NODE_TYPE_SET.has(nodeType)
}

export const TIMED_OUT: RunStatusLiteral = 'timed out'

/** AD-4: at Run end every still-`pending` Call is skipped. */
export function pendingCallIds(calls: readonly CallState[]): readonly string[] {
  return callsInNodeOrder(calls)
    .filter((call) => call.status === 'pending')
    .map((call) => call.callId)
}
