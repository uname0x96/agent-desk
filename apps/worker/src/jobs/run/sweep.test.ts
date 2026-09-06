import { describe, expect, it } from 'vitest'
import { RUN_DEADLINE_MS, RUN_SWEEP_GRACE_MS } from '@agent-desk/core/run'
import type { Clock } from '@agent-desk/core/ports'
import type { RunStatus, SkipReason } from '@agent-desk/schemas'
import { FakePublisher } from './test-doubles.ts'
import { sweepFailureReason, sweepTimedOutRuns } from './sweep.ts'
import type { RunStore, SweepableRun } from './ports.ts'

/**
 * AD-4 / Story 2.9: the timeout sweep, over doubles.
 *
 * The store double is deliberately different from `FakeStore`: this suite is
 * about many Runs at once, and about the two things the sweep can get wrong —
 * losing the compare-and-set to an engine that was alive after all, and
 * skipping the `notify` Call it is about to ask the engine to pay.
 */

const START = new Date('2026-09-06T12:00:00.000Z')
const STUCK_MS = RUN_DEADLINE_MS + RUN_SWEEP_GRACE_MS

interface StoredRun extends SweepableRun {
  status: RunStatus
  /** `pending` Calls, as node types, so the skip can be checked by Type. */
  pending: string[]
}

class SweepStore implements Pick<RunStore, 'runsToSweep' | 'endRun' | 'skipPendingChainCalls'> {
  runs: StoredRun[]
  /** Set by a test to end a Run behind the sweep's back, between select and update. */
  endedUnderUs = new Set<string>()
  ended: { runId: string; status: RunStatus; failureReason: string | null }[] = []
  skips: { runId: string; reason: SkipReason }[] = []

  constructor(runs: StoredRun[]) {
    this.runs = runs
  }

  runsToSweep(before: Date): Promise<readonly SweepableRun[]> {
    return Promise.resolve(
      this.runs
        .filter((run) => run.status === 'running')
        .filter((run) => (run.startedAt ?? run.createdAt).getTime() <= before.getTime())
        .map(({ runId, workflowId, startedAt, createdAt }) => ({
          runId,
          workflowId,
          startedAt,
          createdAt,
        })),
    )
  }

  /** AD-4: a compare-and-set from `running`, exactly as the SQL guards it. */
  endRun(
    runId: string,
    status: RunStatus,
    _at: Date,
    failureReason: string | null,
  ): Promise<boolean> {
    const run = this.runs.find((candidate) => candidate.runId === runId)
    if (!run) return Promise.resolve(false)
    if (this.endedUnderUs.has(runId)) run.status = 'failed at data'
    if (run.status !== 'running') return Promise.resolve(false)
    run.status = status
    this.ended.push({ runId, status, failureReason })
    return Promise.resolve(true)
  }

  skipPendingChainCalls(runId: string, reason: SkipReason, _at: Date): Promise<number> {
    const run = this.runs.find((candidate) => candidate.runId === runId)
    if (!run) return Promise.resolve(0)
    const skipped = run.pending.filter((nodeType) => nodeType !== 'notify')
    run.pending = run.pending.filter((nodeType) => nodeType === 'notify')
    this.skips.push({ runId, reason })
    return Promise.resolve(skipped.length)
  }
}

function run(overrides: Partial<StoredRun> & { runId: string }): StoredRun {
  return {
    workflowId: `wf_${overrides.runId}`,
    status: 'running',
    startedAt: START,
    createdAt: START,
    pending: ['research', 'risk', 'execution', 'notify'],
    ...overrides,
  }
}

function at(ms: number): Clock {
  return { now: () => new Date(START.getTime() + ms) }
}

async function sweep(store: SweepStore, ms: number, publisher = new FakePublisher()) {
  const result = await sweepTimedOutRuns({ store, publisher, clock: at(ms) })
  return { result, publisher }
}

describe('the timeout sweep', () => {
  it('leaves a Run inside its budget and its grace alone', async () => {
    const store = new SweepStore([run({ runId: 'run_1' })])

    const { result, publisher } = await sweep(store, STUCK_MS - 1)

    expect(result).toMatchObject({ candidates: 0, lost: 0 })
    expect(result.swept).toEqual([])
    expect(store.ended).toEqual([])
    expect(publisher.finalized).toEqual([])
    expect(store.runs[0]?.status).toBe('running')
  })

  it('ends a Run past 120 s plus 45 s of grace, skips its chain Calls, and finalizes', async () => {
    const store = new SweepStore([run({ runId: 'run_1' })])

    const { result, publisher } = await sweep(store, STUCK_MS)

    expect(result.swept).toEqual([
      {
        runId: 'run_1',
        workflowId: 'wf_run_1',
        stuckForMs: STUCK_MS,
        skippedCalls: 3,
        finalizeJobId: 'job_finalize_1',
      },
    ])
    expect(store.ended).toEqual([
      {
        runId: 'run_1',
        status: 'timed out',
        failureReason: sweepFailureReason(RUN_DEADLINE_MS, RUN_SWEEP_GRACE_MS),
      },
    ])
    expect(store.skips).toEqual([{ runId: 'run_1', reason: 'not_reached' }])
    expect(publisher.finalized).toEqual(['run_1'])
  })

  it('leaves the notify Call pending, because the finalize delivery has to pay it', async () => {
    const store = new SweepStore([run({ runId: 'run_1' })])

    await sweep(store, STUCK_MS)

    expect(store.runs[0]?.pending).toEqual(['notify'])
  })

  it('names both halves of the rule in the failure reason the Run view shows', () => {
    expect(sweepFailureReason(RUN_DEADLINE_MS, RUN_SWEEP_GRACE_MS)).toBe(
      'the Run was still running 120 s after it started, ' +
        'and did not end within 45 s of grace; the timeout sweep ended it',
    )
  })

  it('sweeps a Run whose worker died before it ever wrote started_at', async () => {
    const store = new SweepStore([run({ runId: 'run_1', startedAt: null })])

    const { result } = await sweep(store, STUCK_MS)

    // This is the Run nothing else in the system can move: the engine's own
    // deadline is measured from `started_at` and never trips without one.
    expect(result.swept).toHaveLength(1)
    expect(store.runs[0]?.status).toBe('timed out')
  })

  it('writes nothing when the engine ends the Run between the select and the update', async () => {
    const store = new SweepStore([run({ runId: 'run_1' })])
    store.endedUnderUs.add('run_1')

    const { result, publisher } = await sweep(store, STUCK_MS)

    expect(result).toMatchObject({ candidates: 1, lost: 1 })
    expect(result.swept).toEqual([])
    expect(store.ended).toEqual([])
    expect(store.skips).toEqual([])
    // No finalize either: the engine that won owns the terminal filter.
    expect(publisher.finalized).toEqual([])
    expect(store.runs[0]?.status).toBe('failed at data')
  })

  it('sweeps every stuck Run and leaves the rest, in one tick', async () => {
    const store = new SweepStore([
      run({ runId: 'run_stuck' }),
      run({ runId: 'run_fresh', startedAt: new Date(START.getTime() + STUCK_MS) }),
      run({ runId: 'run_abandoned', startedAt: null }),
      run({ runId: 'run_done', status: 'completed' }),
    ])

    const { result, publisher } = await sweep(store, STUCK_MS)

    expect(result.swept.map((swept) => swept.runId)).toEqual(['run_stuck', 'run_abandoned'])
    expect(publisher.finalized).toEqual(['run_stuck', 'run_abandoned'])
    expect(store.runs.map((r) => r.status)).toEqual([
      'timed out',
      'running',
      'timed out',
      'completed',
    ])
  })

  it('re-applies the machine rule to whatever the query returned', async () => {
    // A store that hands back a Run the rule does not cover — a `before` that
    // drifted from the constants, or a clock skew — must not end it.
    const store = new SweepStore([run({ runId: 'run_1' })])
    const justStarted = new Date(START.getTime() + STUCK_MS)
    store.runsToSweep = () =>
      Promise.resolve([
        {
          runId: 'run_1',
          workflowId: 'wf_run_1',
          startedAt: justStarted,
          createdAt: justStarted,
        },
      ])

    const { result } = await sweep(store, STUCK_MS)

    expect(result).toMatchObject({ candidates: 1, lost: 0 })
    expect(result.swept).toEqual([])
    expect(store.ended).toEqual([])
  })

  it('honours a shorter budget and grace, so a test never waits 165 s', async () => {
    const store = new SweepStore([run({ runId: 'run_1' })])

    const result = await sweepTimedOutRuns({
      store,
      publisher: new FakePublisher(),
      clock: at(300),
      budgetMs: 200,
      graceMs: 100,
    })

    expect(result.swept).toHaveLength(1)
    expect(store.ended[0]?.failureReason).toBe(sweepFailureReason(200, 100))
  })
})
