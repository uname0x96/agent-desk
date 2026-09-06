import { QUEUES, type RunExecuteJob, type SettlementTickJob } from '@agent-desk/schemas'
import type { PgBoss } from 'pg-boss'
import type { Logger } from '@agent-desk/core/ports'
import { silentLogger } from '@agent-desk/core/ports'
import type { RunPublisher } from './ports.ts'

/**
 * The two sends the run side makes, over pg-boss.
 *
 * They are here rather than inline in the sweep and the engine for one reason:
 * both are subject to a queue policy, and the policy is the interesting part.
 *
 * `run.execute` is an `exclusive` queue — `unique (name, coalesce(singleton_key,
 * ''))` over jobs in `created` or `active` — and `POST /api/runs` sends the
 * Run's first delivery keyed on `workflow_id`, which is how AD-4's "one Run per
 * Workflow" holds against a double publish. The sweep cannot reuse that key.
 * The Run it is finalising is, by definition, one whose `run.execute` job is
 * still sitting `active` under a worker that died, so a send keyed on
 * `workflow_id` would collide with the very job the sweep exists to give up on
 * and be dropped. It keys the finalize delivery on the *Run* instead: still one
 * job at a time, still no way to start a second chain (a `finalize` delivery
 * runs only the terminal `notify` filter and never touches the Run status), but
 * no longer blocked by the corpse of the first attempt.
 *
 * `settlement.tick` is a plain queue, so its send needs no key at all: AD-9
 * makes the settlement loop re-derive its work from `calls` left of a
 * `settlements` row, which means a suppressed or lost tick costs latency and
 * never correctness.
 */

/** Story 2.9: one finalize delivery per Run, whatever the chain job is doing. */
export function finalizeSingletonKey(runId: string): string {
  return `finalize:${runId}`
}

export function createRunPublisher(boss: PgBoss, logger: Logger = silentLogger): RunPublisher {
  return {
    async finalizeRun(runId: string): Promise<string | null> {
      const job: RunExecuteJob = { run_id: runId, finalize: true }
      const id = await boss.send(QUEUES.runExecute, job, {
        singletonKey: finalizeSingletonKey(runId),
      })
      if (!id) {
        logger.info(
          { run_id: runId, queue: QUEUES.runExecute },
          'finalize delivery suppressed; one is already queued or active for this Run',
        )
      }
      return id
    },

    async settlementTick(callId: string): Promise<string | null> {
      const job: SettlementTickJob = { call_id: callId }
      const id = await boss.send(QUEUES.settlementTick, job)
      logger.debug({ call_id: callId, job_id: id }, 'settlement tick published')
      return id
    },
  }
}

/**
 * The publisher for a caller that has no queue — the engine's unit tests, and
 * any wiring that has not been handed a `PgBoss` yet. Nothing depends on a send
 * landing (see above), so the safe default is to drop it and say so.
 */
export function noopRunPublisher(logger: Logger = silentLogger): RunPublisher {
  return {
    finalizeRun(runId: string): Promise<string | null> {
      logger.debug({ run_id: runId }, 'no publisher wired; finalize delivery not sent')
      return Promise.resolve(null)
    },
    settlementTick(callId: string): Promise<string | null> {
      logger.debug({ call_id: callId }, 'no publisher wired; settlement tick not sent')
      return Promise.resolve(null)
    },
  }
}
