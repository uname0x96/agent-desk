import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  PLATFORM_SETTINGS_ID,
  accounts,
  platformSettings,
  runs,
  startBoss,
  wallets,
  workflows,
  type Database,
} from '@agent-desk/db'
import { MODE_CONSTANTS, modeConstants } from '@agent-desk/core/mode'
import { RUN_DEADLINE_MS, RUN_SWEEP_GRACE_MS } from '@agent-desk/core/run'
import {
  QUEUES,
  newId,
  settlementTickJob,
  type RunExecuteJob,
  type SettlementTickJob,
} from '@agent-desk/schemas'
import type { PgBoss } from 'pg-boss'
import { eq } from 'drizzle-orm'
import { createRunPublisher, finalizeSingletonKey } from './publisher.ts'
import { readMode, runSettlementTick, startPollingLoop } from './settlement-loop.ts'
import {
  SWEEP_LOCK_KEY,
  TEST_DATABASE_URL,
  resetSweepDatabase,
  sweepDatabasePreflight,
  sweepTestDb,
} from './sweep-test-db.ts'

/**
 * Story 2.9 against a real pg-boss: the two sends and the loop's mode read.
 *
 * The claim this file exists to check is the one in `publisher.ts`. `run.execute`
 * is an `exclusive` queue keyed on `workflow_id`, and the Run the sweep is
 * finalising is precisely one whose original `run.execute` job is still sitting
 * there under a worker that died — so a finalize keyed the same way would be
 * dropped by the very index that makes "one Run per Workflow" work. Asserting
 * that in a comment is worth nothing; the queue either behaves this way or it
 * does not.
 */

const SKIP = await sweepDatabasePreflight()
const db: Database = sweepTestDb()
const holder: Database = sweepTestDb(1)

let boss: PgBoss
const stoppers: (() => void)[] = []

async function setMode(mode: 'production' | 'demo'): Promise<void> {
  await db
    .update(platformSettings)
    .set({ mode, updatedAt: new Date() })
    .where(eq(platformSettings.id, PLATFORM_SETTINGS_ID))
}

/** The app tables this file writes to, cleared at both ends. */
const reset = () => resetSweepDatabase(db)

/**
 * A Run left `running` with a real wall-clock `started_at` well past the budget
 * and the grace — what a killed worker leaves behind. No Calls: the sweep is
 * about the Run row, and this test is about the loop reaching it unprompted.
 */
async function abandonedRun(): Promise<{ runId: string; startedAt: Date }> {
  const accountId = newId('account')
  const walletId = newId('wallet')
  const workflowId = newId('workflow')
  const runId = newId('run')
  const startedAt = new Date(Date.now() - RUN_DEADLINE_MS - RUN_SWEEP_GRACE_MS - 5_000)

  await db.insert(accounts).values({
    id: accountId,
    email: `${accountId}@test.local`,
    passwordHash: '!',
    // The fixture clock is fixed, but `budget_window_start` defaults to the
    // real `now()`, and AD-3 takes the later of it and UTC midnight. Pin it to
    // the epoch so the window is UTC midnight and the spend query is not a
    // function of what time of day the suite runs.
    budgetWindowStart: new Date(0),
  })
  await db.insert(wallets).values({
    id: walletId,
    accountId,
    // `wallets.address` is unique and lower-case; this file does not truncate
    // between tests, so the fixture cannot reuse a counter.
    address: `0x${randomBytes(20).toString('hex')}`,
    encryptedKey: 'gcm1.a.b.c',
    readyAt: startedAt,
  })
  await db.insert(workflows).values({
    id: workflowId,
    accountId,
    name: 'Loop fixture',
    symbol: 'BNBUSDT',
  })
  await db.insert(runs).values({
    id: runId,
    workflowId,
    accountId,
    walletId,
    status: 'running',
    priceLock: { nodes: [], total: '0', locked_at: startedAt.toISOString() },
    createdAt: startedAt,
    startedAt,
  })
  return { runId, startedAt }
}

/**
 * The sweep half of AD-9's loop, composed the way `apps/worker/src/jobs/settlement.ts`
 * composes it: the timer primitive driving `runSettlementTick`, sleeping the poll
 * interval of whichever mode that tick just read.
 */
function startSweepLoop(deps: { db: Database; boss: PgBoss }): () => void {
  return startPollingLoop({
    tick: async () => modeConstants((await runSettlementTick(deps)).mode).settlementPollMs,
    fallbackSleepMs: MODE_CONSTANTS.production.settlementPollMs,
  })
}

/** Drains one queue, so an assertion sees what was sent rather than what is left. */
async function fetchAll(queue: string): Promise<RunExecuteJob[]> {
  const jobs = await boss.fetch<RunExecuteJob>(queue, { batchSize: 10 })
  for (const job of jobs) await boss.complete(queue, job.id)
  return jobs.map((job) => job.data)
}

beforeAll(async () => {
  if (SKIP) return
  // pg-boss creates its own schema here, in this story's own database, so
  // nothing about starting it touches a table another suite is using.
  boss = await startBoss(TEST_DATABASE_URL)
  await holder.execute(sql`select pg_advisory_lock(${SWEEP_LOCK_KEY})`)
  await reset()
}, 60_000)

afterAll(async () => {
  if (SKIP) return
  for (const stop of stoppers) stop()
  await boss.stop({ graceful: false })
  await reset()
  await holder.execute(sql`select pg_advisory_unlock(${SWEEP_LOCK_KEY})`)
})

describe.skipIf(SKIP !== null)('the settlement loop and its sends', () => {
  beforeEach(async () => {
    await fetchAll(QUEUES.runExecute)
    await fetchAll(QUEUES.settlementTick)
    await setMode('production')
  })

  describe('the finalize delivery', () => {
    it('gets through while the Run’s own run.execute job is still queued', async () => {
      const publisher = createRunPublisher(boss)
      const workflowId = newId('workflow')
      const runId = newId('run')

      // What `POST /api/runs` sent, and what the dead worker never finished.
      const original = await boss.send(
        QUEUES.runExecute,
        { run_id: runId },
        { singletonKey: workflowId },
      )
      expect(original).not.toBeNull()

      // The exclusive index refuses a second delivery on the Workflow's key…
      expect(
        await boss.send(QUEUES.runExecute, { run_id: runId }, { singletonKey: workflowId }),
      ).toBeNull()

      // …but the sweep keys on the Run, so its finalize is not the second Run.
      expect(await publisher.finalizeRun(runId)).not.toBeNull()

      const sent = await fetchAll(QUEUES.runExecute)
      expect(sent).toEqual(
        expect.arrayContaining([
          { run_id: runId },
          { run_id: runId, finalize: true },
        ]),
      )
      expect(sent).toHaveLength(2)
    })

    it('sends one finalize per Run and suppresses the second', async () => {
      const publisher = createRunPublisher(boss)
      const runId = newId('run')

      expect(await publisher.finalizeRun(runId)).not.toBeNull()
      // One Run, one message: the terminal filter must not be asked twice.
      expect(await publisher.finalizeRun(runId)).toBeNull()

      expect(await fetchAll(QUEUES.runExecute)).toEqual([{ run_id: runId, finalize: true }])
    })

    it('keys on the Run, so two Runs of one Workflow finalize independently', async () => {
      const publisher = createRunPublisher(boss)
      const first = newId('run')
      const second = newId('run')

      expect(finalizeSingletonKey(first)).not.toBe(finalizeSingletonKey(second))
      expect(await publisher.finalizeRun(first)).not.toBeNull()
      expect(await publisher.finalizeRun(second)).not.toBeNull()
      expect(await fetchAll(QUEUES.runExecute)).toHaveLength(2)
    })
  })

  describe('the settlement tick', () => {
    it('is a plain queue, so several Calls can be in flight at once', async () => {
      const publisher = createRunPublisher(boss)
      const callIds = [newId('call'), newId('call')]

      for (const callId of callIds) expect(await publisher.settlementTick(callId)).not.toBeNull()

      const sent = await boss.fetch(QUEUES.settlementTick, { batchSize: 10 })
      for (const job of sent) await boss.complete(QUEUES.settlementTick, job.id)
      // A plain queue makes no ordering promise; what matters is that neither
      // send was suppressed, which an `exclusive` policy would have done.
      expect(sent.map((job) => (job.data as { call_id: string }).call_id).sort()).toEqual(
        [...callIds].sort(),
      )
    })

    it('is consumed by a handler running the targeted tick', async () => {
      // The real handler is registered by `apps/worker/src/jobs/settlement.ts`,
      // which this story does not own; what is asserted here is the half it
      // calls — that a `settlement.tick` delivery parses and drives
      // `runSettlementTick` against a live database, and leaves the queue empty.
      const seen: string[] = []
      const workerId = await boss.work<SettlementTickJob>(
        QUEUES.settlementTick,
        async (jobs) => {
          for (const job of jobs) {
            const callId = settlementTickJob.parse(job.data).call_id
            await runSettlementTick({ db, boss }, { callId })
            seen.push(callId)
          }
        },
      )
      const callId = newId('call')

      try {
        await createRunPublisher(boss).settlementTick(callId)

        // The handler must take the job off the queue; Epic 4 fills in the scoring.
        await expect
          .poll(
            async () =>
              (await db.execute(
                sql`select count(*)::int as n from pgboss.job
                    where name = ${QUEUES.settlementTick} and state <= 'active'`,
              )) as unknown as { n: number }[],
            { timeout: 15_000 },
          )
          .toEqual([{ n: 0 }])
        expect(seen).toEqual([callId])
      } finally {
        // Left registered, this handler would eat the sends of any test after it.
        await boss.offWork(QUEUES.settlementTick, { id: workerId })
      }
    })
  })

  describe('the loop itself', () => {
    it('sweeps a stuck Run on its own schedule, with nothing prompting it', async () => {
      const { runId } = await abandonedRun()
      // Demo mode's 2 s poll, so the test waits seconds rather than a minute.
      await setMode('demo')

      const stop = startSweepLoop({ db, boss })
      stoppers.push(stop)

      try {
        await expect
          .poll(
            async () =>
              (await db.query.runs.findFirst({ where: (t, { eq }) => eq(t.id, runId) }))?.status,
            { timeout: 15_000, interval: 250 },
          )
          .toBe('timed out')

        // AD-4: and the terminal filter is asked for, by the finalize delivery.
        await expect
          .poll(async () => (await fetchAll(QUEUES.runExecute)).length, { timeout: 15_000 })
          .toBeGreaterThan(0)
      } finally {
        stop()
      }
    }, 40_000)

    // Stopping, not overlapping, and surviving a failed tick are properties of
    // the timer rather than of the database, and `settlement-loop.test.ts`
    // pins them down on fake timers rather than by holding the shared advisory
    // lock through a real sleep.
  })

  describe('the mode the tick reads', () => {
    it('reads platform_settings fresh on every tick', async () => {
      expect(await readMode(db)).toBe('production')
      expect((await runSettlementTick({ db, boss })).mode).toBe('production')

      // AD-10: the Operator flips this at runtime; nothing restarts.
      await setMode('demo')
      expect((await runSettlementTick({ db, boss })).mode).toBe('demo')
    })

    it('sleeps the mode’s own poll interval', () => {
      // §6, the table the loop sleeps on. 60 s in production, 2 s in demo.
      expect(MODE_CONSTANTS.production.settlementPollMs).toBe(60_000)
      expect(MODE_CONSTANTS.demo.settlementPollMs).toBe(2_000)
    })

    it('does not sweep on a targeted tick, which is about one Call', async () => {
      const result = await runSettlementTick({ db, boss }, { callId: 'call_1' })
      expect(result).toMatchObject({ mode: 'production', sweep: null, callId: 'call_1' })
    })

    it('sweeps on an untargeted tick', async () => {
      const result = await runSettlementTick({ db, boss })
      expect(result.sweep).toMatchObject({ candidates: expect.any(Number), lost: 0 })
    })
  })
})
