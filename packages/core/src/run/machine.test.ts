import { describe, expect, it } from 'vitest'
import { CALL_STATUSES, type AgentType, type CallStatus } from '@agent-desk/schemas'
import {
  MAX_PAID_ATTEMPTS,
  RUN_DEADLINE_MS,
  assertCallStatus,
  assertCallTransition,
  assertRunStatus,
  assertRunTransition,
  callsInNodeOrder,
  canTransitionCall,
  canTransitionRun,
  failureStatus,
  firstUnfinishedCall,
  isCallPaid,
  isCallTerminal,
  isPastDeadline,
  isRunStuck,
  isScoredNodeType,
  isSweepable,
  nextStep,
  pendingCallIds,
  successStatus,
  sweepClockOf,
  type CallState,
} from './machine.ts'

const START = new Date('2026-09-06T12:00:00.000Z')

function call(overrides: Partial<CallState> & { nodeIndex: number }): CallState {
  return {
    callId: `call_${overrides.nodeIndex}`,
    nodeType: 'data' as AgentType,
    status: 'pending',
    attempt: 0,
    hasPaymentPayload: false,
    ...overrides,
  }
}

describe('status guards', () => {
  it('accepts only the PRD Call enums', () => {
    for (const status of CALL_STATUSES) expect(assertCallStatus(status)).toBe(status)
    expect(() => assertCallStatus('paid')).toThrow(/not a Call status/)
    expect(() => assertCallStatus('PENDING')).toThrow(/not a Call status/)
    expect(() => assertCallStatus('')).toThrow(/not a Call status/)
  })

  it('accepts the four Run literals and the failed-at template only', () => {
    for (const status of ['running', 'completed', 'completed, no order', 'timed out']) {
      expect(assertRunStatus(status)).toBe(status)
    }
    expect(assertRunStatus('failed at data')).toBe('failed at data')
    expect(assertRunStatus('failed at notify')).toBe('failed at notify')
    expect(() => assertRunStatus('failed')).toThrow(/not a Run status/)
    expect(() => assertRunStatus('cancelled')).toThrow(/not a Run status/)
    expect(() => assertRunStatus('completed no order')).toThrow(/not a Run status/)
  })

  it('knows which Call statuses are terminal and which were paid for', () => {
    expect(isCallTerminal('pending')).toBe(false)
    expect(isCallTerminal('paid_awaiting_result')).toBe(false)
    for (const status of ['succeeded', 'price_mismatch', 'payment_failed', 'failed_after_payment', 'skipped']) {
      expect(isCallTerminal(status)).toBe(true)
    }
    expect(isCallPaid('paid_awaiting_result')).toBe(true)
    expect(isCallPaid('succeeded')).toBe(true)
    expect(isCallPaid('failed_after_payment')).toBe(true)
    expect(isCallPaid('price_mismatch')).toBe(false)
    expect(isCallPaid('payment_failed')).toBe(false)
  })
})

describe('transitions', () => {
  it('lets a pending Call refuse, pay, or be skipped and nothing else', () => {
    expect(canTransitionCall('pending', 'price_mismatch')).toBe(true)
    expect(canTransitionCall('pending', 'payment_failed')).toBe(true)
    expect(canTransitionCall('pending', 'paid_awaiting_result')).toBe(true)
    expect(canTransitionCall('pending', 'skipped')).toBe(true)
    expect(canTransitionCall('pending', 'succeeded')).toBe(false)
    expect(canTransitionCall('pending', 'failed_after_payment')).toBe(false)
  })

  it('resolves a paid Call to exactly the three AD-6 outcomes', () => {
    expect(canTransitionCall('paid_awaiting_result', 'succeeded')).toBe(true)
    expect(canTransitionCall('paid_awaiting_result', 'failed_after_payment')).toBe(true)
    expect(canTransitionCall('paid_awaiting_result', 'payment_failed')).toBe(true)
    expect(canTransitionCall('paid_awaiting_result', 'price_mismatch')).toBe(false)
    expect(canTransitionCall('paid_awaiting_result', 'skipped')).toBe(false)
  })

  it('never moves a terminal Call and never invents a status', () => {
    for (const from of ['succeeded', 'price_mismatch', 'payment_failed', 'failed_after_payment', 'skipped'] as CallStatus[]) {
      for (const to of CALL_STATUSES) expect(canTransitionCall(from, to)).toBe(false)
    }
    expect(canTransitionCall('pending', 'refunded')).toBe(false)
    expect(() => assertCallTransition('succeeded', 'skipped')).toThrow(/cannot move/)
    expect(assertCallTransition('pending', 'paid_awaiting_result')).toBe('paid_awaiting_result')
  })

  it('compare-and-sets a Run only from running', () => {
    expect(canTransitionRun('running', 'completed')).toBe(true)
    expect(canTransitionRun('running', 'completed, no order')).toBe(true)
    expect(canTransitionRun('running', 'timed out')).toBe(true)
    expect(canTransitionRun('running', 'failed at data')).toBe(true)
    expect(canTransitionRun('running', 'running')).toBe(false)
    expect(canTransitionRun('completed', 'timed out')).toBe(false)
    expect(canTransitionRun('timed out', 'failed at data')).toBe(false)
    expect(() => assertRunTransition('completed', 'timed out')).toThrow(/cannot move/)
    expect(assertRunTransition('running', 'failed at risk')).toBe('failed at risk')
  })
})

describe('nextStep', () => {
  it('finishes when every Call is terminal', () => {
    const calls = [
      call({ nodeIndex: 0, status: 'succeeded' }),
      call({ nodeIndex: 1, status: 'skipped' }),
    ]
    expect(nextStep({ calls })).toEqual({ kind: 'finish' })
  })

  it('starts the first pending Call in node order, whatever order the rows arrive in', () => {
    const calls = [
      call({ nodeIndex: 2 }),
      call({ nodeIndex: 0, status: 'succeeded' }),
      call({ nodeIndex: 1 }),
    ]
    const step = nextStep({ calls })
    expect(step).toEqual({ kind: 'call', call: expect.objectContaining({ nodeIndex: 1 }) })
    expect(callsInNodeOrder(calls).map((entry) => entry.nodeIndex)).toEqual([0, 1, 2])
    expect(firstUnfinishedCall(calls)?.nodeIndex).toBe(1)
  })

  it('resends a paid Call that still has attempts left and a stored header', () => {
    for (const attempt of [0, 1]) {
      const calls = [
        call({ nodeIndex: 0, status: 'paid_awaiting_result', attempt, hasPaymentPayload: true }),
      ]
      expect(nextStep({ calls })).toEqual({
        kind: 'resend',
        call: expect.objectContaining({ attempt }),
      })
    }
  })

  it('resolves a paid Call whose attempts are spent', () => {
    const calls = [
      call({
        nodeIndex: 0,
        status: 'paid_awaiting_result',
        attempt: MAX_PAID_ATTEMPTS,
        hasPaymentPayload: true,
      }),
    ]
    expect(nextStep({ calls })).toEqual({ kind: 'resolve', call: expect.anything() })
  })

  it('resolves a paid Call with no stored authorization rather than resending nothing', () => {
    const calls = [
      call({ nodeIndex: 0, status: 'paid_awaiting_result', attempt: 0, hasPaymentPayload: false }),
    ]
    expect(nextStep({ calls })).toEqual({ kind: 'resolve', call: expect.anything() })
  })
})

describe('deadline', () => {
  it('is measured from started_at and is inclusive at the boundary', () => {
    expect(isPastDeadline(START, new Date(START.getTime() + RUN_DEADLINE_MS - 1))).toBe(false)
    expect(isPastDeadline(START, new Date(START.getTime() + RUN_DEADLINE_MS))).toBe(true)
    expect(isPastDeadline(START, new Date(START.getTime() + RUN_DEADLINE_MS + 1))).toBe(true)
  })

  it('never trips for a Run the worker has not started', () => {
    expect(isPastDeadline(null, new Date(START.getTime() + 10 * RUN_DEADLINE_MS))).toBe(false)
  })

  it('gives the sweep 45 s of grace beyond the engine deadline', () => {
    const justPastDeadline = new Date(START.getTime() + RUN_DEADLINE_MS + 1_000)
    expect(isPastDeadline(START, justPastDeadline)).toBe(true)
    expect(isSweepable(START, justPastDeadline)).toBe(false)
    expect(isSweepable(START, new Date(START.getTime() + 165_001))).toBe(true)
  })
})

describe('the sweep clock', () => {
  const CREATED = new Date(START.getTime() - 5_000)

  it('is started_at once the worker has picked the Run up', () => {
    expect(sweepClockOf({ startedAt: START, createdAt: CREATED })).toEqual(START)
  })

  it('falls back to created_at for a Run no worker ever started', () => {
    expect(sweepClockOf({ startedAt: null, createdAt: CREATED })).toEqual(CREATED)
  })

  it('bounds a Run abandoned before started_at was ever written', () => {
    const run = { startedAt: null, createdAt: CREATED }
    // The engine's own rule can never end this Run: it has no started_at.
    expect(isPastDeadline(run.startedAt, new Date(CREATED.getTime() + 600_000))).toBe(false)
    expect(isRunStuck(run, new Date(CREATED.getTime() + 164_999))).toBe(false)
    expect(isRunStuck(run, new Date(CREATED.getTime() + 165_000))).toBe(true)
  })

  it('measures a started Run from started_at, not from created_at', () => {
    const run = { startedAt: START, createdAt: CREATED }
    // 165 s after `created_at` is only 160 s after `started_at`: not yet stuck.
    expect(isRunStuck(run, new Date(CREATED.getTime() + 165_001))).toBe(false)
    expect(isRunStuck(run, new Date(START.getTime() + 165_001))).toBe(true)
  })
})

describe('run outcome', () => {
  it('completes a Workflow with no execution Node', () => {
    expect(successStatus({ hasExecutionNode: false })).toBe('completed')
  })

  it('needs a FILLED execution to complete, and says "no order" otherwise', () => {
    expect(successStatus({ hasExecutionNode: true, executionFilled: true })).toBe('completed')
    expect(successStatus({ hasExecutionNode: true, executionFilled: false })).toBe('completed, no order')
    expect(successStatus({ hasExecutionNode: true })).toBe('completed, no order')
  })

  it('scores research and risk Calls and no other Type', () => {
    for (const nodeType of ['research', 'risk']) expect(isScoredNodeType(nodeType)).toBe(true)
    for (const nodeType of ['data', 'execution', 'notify']) {
      expect(isScoredNodeType(nodeType)).toBe(false)
    }
  })

  it('names the failed Node in the Run status', () => {
    expect(failureStatus('data')).toBe('failed at data')
    expect(failureStatus('notify')).toBe('failed at notify')
  })

  it('lists the still-pending Calls to skip at Run end, in node order', () => {
    const calls = [
      call({ nodeIndex: 2, callId: 'call_c' }),
      call({ nodeIndex: 0, callId: 'call_a', status: 'succeeded' }),
      call({ nodeIndex: 1, callId: 'call_b' }),
      call({ nodeIndex: 3, callId: 'call_d', status: 'paid_awaiting_result' }),
    ]
    expect(pendingCallIds(calls)).toEqual(['call_b', 'call_c'])
  })
})
