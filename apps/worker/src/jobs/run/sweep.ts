import {
  RUN_DEADLINE_MS,
  RUN_SWEEP_GRACE_MS,
  TIMED_OUT,
  isRunStuck,
  sweepClockOf,
} from '@agent-desk/core/run'
import type { Clock, Logger } from '@agent-desk/core/ports'
import { silentLogger, systemClock } from '@agent-desk/core/ports'
import type { RunPublisher, RunStore, SweepableRun } from './ports.ts'

/**
 * AD-4 / Story 2.9: the timeout sweep.
 *
 * The engine already ends a Run `timed out` when it finds itself past the 120 s
 * budget. This exists for the Run the engine will never look at again: the
 * worker was killed mid-flight, the job was lost, the process ran out of memory
 * between two Nodes. Nothing else in the system can move that row, and while it
 * stays `running` the partial unique index on `runs(workflow_id)` refuses every
 * new Run of that Workflow and the AD-3 spend query keeps counting its `pending`
 * Calls against the Builder's Daily Fee Budget. A demo that ends there looks
 * broken; this is the sweep that makes it end deliberately instead.
 *
 * Three writes, in this order, and the order is the whole design:
 *
 *   1. `endRun` compare-and-sets from `running`. When it loses, the engine was
 *      alive after all and ended the Run itself between the select and the
 *      update — so the sweep stops, having written nothing;
 *   2. the chain's still-`pending` Calls become `skipped` / `not_reached`,
 *      which is also what drops them out of the spend query;
 *   3. `run.execute { finalize: true }` goes out, and the engine runs only the
 *      terminal `notify` filter — which is why step 2 leaves the `notify` Call
 *      alone.
 *
 * The 45 s of grace beyond the engine's own budget is what keeps step 1 from
 * being a race in the normal case rather than the exceptional one.
 */

export interface TimeoutSweepDeps {
  store: Pick<RunStore, 'runsToSweep' | 'endRun' | 'skipPendingChainCalls'>
  publisher: Pick<RunPublisher, 'finalizeRun'>
  clock?: Clock
  logger?: Logger
  /** The engine's budget. Overridable so a test does not have to wait 120 s. */
  budgetMs?: number
  /** The grace on top of it, before the sweep will touch a Run. */
  graceMs?: number
}

export interface SweptRun {
  runId: string
  workflowId: string
  /** How long the Run had been stuck, in ms, for the log and the tests. */
  stuckForMs: number
  /** AD-4: at Run end, every Node the chain never reached. */
  skippedCalls: number
  /** Null when pg-boss suppressed the send (see `publisher.ts`). */
  finalizeJobId: string | null
}

export interface SweepResult {
  /** Runs whose sweep clock was past the budget and the grace. */
  candidates: number
  /** Runs this sweep actually moved to `timed out`. */
  swept: readonly SweptRun[]
  /** Candidates whose compare-and-set lost, because the engine got there first. */
  lost: number
}

/**
 * The failure reason the Run view shows. It names both halves of the rule,
 * because "timed out" on its own does not tell a Builder whether their Agent
 * was slow or their worker was dead — and only the second one is worth paging
 * an Operator about.
 */
export function sweepFailureReason(budgetMs: number, graceMs: number): string {
  return (
    `the Run was still running ${budgetMs / 1000} s after it started, ` +
    `and did not end within ${graceMs / 1000} s of grace; the timeout sweep ended it`
  )
}

export async function sweepTimedOutRuns(deps: TimeoutSweepDeps): Promise<SweepResult> {
  const clock = deps.clock ?? systemClock
  const logger = deps.logger ?? silentLogger
  const budgetMs = deps.budgetMs ?? RUN_DEADLINE_MS
  const graceMs = deps.graceMs ?? RUN_SWEEP_GRACE_MS

  const now = clock.now()
  const before = new Date(now.getTime() - budgetMs - graceMs)
  const candidates = await deps.store.runsToSweep(before)

  const swept: SweptRun[] = []
  let lost = 0

  for (const run of candidates) {
    // The SQL already applied the rule; applying it again in TypeScript is what
    // keeps `core/run/machine.ts` the only definition of it, and catches a
    // `before` that drifted from the constants the machine holds.
    if (!isRunStuck(run, now, budgetMs, graceMs)) continue

    const applied = await deps.store.endRun(
      run.runId,
      TIMED_OUT,
      now,
      sweepFailureReason(budgetMs, graceMs),
    )
    if (!applied) {
      // AD-4: zero rows updated. The engine was not dead, it was slow, and it
      // has just ended the Run itself — with a truer status than `timed out`.
      lost += 1
      logger.info(
        { run_id: run.runId },
        'sweep lost the compare-and-set; the engine ended this Run first',
      )
      continue
    }

    const skippedCalls = await deps.store.skipPendingChainCalls(run.runId, 'not_reached', now)
    const finalizeJobId = await deps.publisher.finalizeRun(run.runId)
    const stuckForMs = now.getTime() - sweepClockOf(run).getTime()

    logger.warn(
      {
        run_id: run.runId,
        workflow_id: run.workflowId,
        stuck_for_ms: stuckForMs,
        skipped_calls: skippedCalls,
        started: run.startedAt !== null,
      },
      'timeout sweep ended a Run no worker was advancing',
    )
    swept.push({
      runId: run.runId,
      workflowId: run.workflowId,
      stuckForMs,
      skippedCalls,
      finalizeJobId,
    })
  }

  return { candidates: candidates.length, swept, lost }
}

export type { SweepableRun }
