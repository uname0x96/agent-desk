import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  accounts,
  calls,
  dailyFeeSpendForAccount,
  listings,
  runs,
  wallets,
  workflowNodes,
  workflows,
  type Database,
} from '@agent-desk/db'
import { RUN_DEADLINE_MS, RUN_SWEEP_GRACE_MS } from '@agent-desk/core/run'
import {
  newId,
  toBaseUnits,
  type AgentType,
  type PriceLock,
  type RunStatus,
} from '@agent-desk/schemas'
import { createRunStore } from './store.ts'
import {
  SWEEP_LOCK_KEY,
  TEST_DATABASE_URL,
  resetSweepDatabase,
  sweepDatabasePreflight,
  sweepTestDb,
} from './sweep-test-db.ts'
import { sweepFailureReason, sweepTimedOutRuns } from './sweep.ts'
import { FakePublisher } from './test-doubles.ts'

/**
 * Story 2.9 against real Postgres: the timeout sweep, end to end over rows.
 *
 * The sweep is the safety net for a Run whose worker died mid-flight, and the
 * only way to know it works is to leave a Run in `running` past its budget with
 * nothing alive to advance it and watch this code end it. Three things can only
 * be got wrong in SQL, and all three are here:
 *
 *   - `coalesce(started_at, created_at)` is the sweep clock, so the Run that
 *     died *before* the worker wrote `started_at` is still selected;
 *   - the skip holds the `notify` Call back, because the `finalize` delivery
 *     still has to pay it;
 *   - after the end, the AD-3 spend query stops counting the Run's unpaid Calls
 *     and the partial unique index frees the Workflow for a new Run.
 *
 * The database is this story's own (`sweep-test-db.ts`), so nothing here can
 * truncate a table another suite is using and nothing here makes another suite
 * wait on the repository's shared advisory lock.
 */

const PRICE = toBaseUnits('0.01').toString()
const PAY_TO = '0x00000000000000000000000000000000000000bb'
const ASSET = '0xd0e0851ca8a176d211e2a410f5bcf1fa440fada7'

/** The Run started at noon; every `now` below is an offset from it. */
const STARTED = new Date('2026-09-06T12:00:00.000Z')
const STUCK_MS = RUN_DEADLINE_MS + RUN_SWEEP_GRACE_MS

/** The full chain, so the skip has both a Node to skip and a `notify` to spare. */
const NODE_TYPES: readonly AgentType[] = ['data', 'research', 'risk', 'execution', 'notify']

function at(ms: number): Date {
  return new Date(STARTED.getTime() + ms)
}

const SKIP = await sweepDatabasePreflight()
const db: Database = sweepTestDb()
const holder: Database = sweepTestDb(1)
const store = createRunStore(db)

const reset = () => resetSweepDatabase(db)

let addressCounter = 0
function nextAddress(): string {
  addressCounter += 1
  return `0x${addressCounter.toString(16).padStart(40, '0')}`
}

interface Fixture {
  runId: string
  workflowId: string
  accountId: string
  callIds: string[]
}

/**
 * One Builder with a five-Node Workflow and a Run of it left `running`: the
 * `data` Call paid and succeeded, everything after it still `pending`. That is
 * exactly the shape a worker leaves behind when it is killed between two Nodes.
 */
async function abandonedRun(
  options: { startedAt?: Date | null; createdAt?: Date; status?: RunStatus } = {},
): Promise<Fixture> {
  const accountId = newId('account')
  const walletId = newId('wallet')
  const workflowId = newId('workflow')
  const runId = newId('run')

  await db.insert(accounts).values({
    id: accountId,
    email: `${accountId}@test.local`,
    passwordHash: '!',
    telegramChatId: '123456789',
    // The fixture clock is fixed, but `budget_window_start` defaults to the real
    // `now()`, and AD-3 takes the later of it and UTC midnight. Pin it to the
    // epoch so the window is UTC midnight and the spend query is not a function
    // of what time of day the suite runs.
    budgetWindowStart: new Date(0),
  })
  await db.insert(wallets).values({
    id: walletId,
    accountId,
    address: nextAddress(),
    encryptedKey: 'gcm1.a.b.c',
    readyAt: STARTED,
  })
  await db.insert(workflows).values({
    id: workflowId,
    accountId,
    name: 'Abandoned',
    symbol: 'BNBUSDT',
    orderCapUsdt: '10',
  })

  const listingIds: string[] = []
  for (const [index, nodeType] of NODE_TYPES.entries()) {
    const listingId = newId('listing')
    listingIds.push(listingId)
    await db.insert(listings).values({
      id: listingId,
      creatorAccountId: accountId,
      name: `Listing ${index}`,
      type: nodeType,
      endpoint: `https://agent.example/${index}`,
      declaredPrice: PRICE,
      declaredStake: toBaseUnits('0.10').toString(),
      payoutWallet: PAY_TO,
      status: 'active',
      price: PRICE,
      stake: toBaseUnits('0.30').toString(),
    })
    await db.insert(workflowNodes).values({ workflowId, nodeIndex: index, nodeType, listingId })
  }

  const priceLock: PriceLock = {
    nodes: NODE_TYPES.map((nodeType, index) => ({
      node_index: index,
      node_type: nodeType,
      listing_id: listingIds[index] as string,
      provider: `Listing ${index}`,
      price: PRICE,
      asset: ASSET,
      network: 'eip155:97',
      pay_to: PAY_TO,
    })),
    total: toBaseUnits('0.05').toString(),
    locked_at: STARTED.toISOString(),
  }

  await db.insert(runs).values({
    id: runId,
    workflowId,
    accountId,
    walletId,
    status: options.status ?? 'running',
    priceLock,
    createdAt: options.createdAt ?? STARTED,
    startedAt: options.startedAt === undefined ? STARTED : options.startedAt,
  })

  const callIds = NODE_TYPES.map(() => newId('call'))
  await db.insert(calls).values(
    NODE_TYPES.map((nodeType, index) => ({
      id: callIds[index] as string,
      runId,
      kind: 'run' as const,
      listingId: listingIds[index] as string,
      nodeIndex: index,
      nodeType,
      // The first Node was paid and answered before the worker died.
      status: index === 0 ? ('succeeded' as const) : ('pending' as const),
      lockedPrice: PRICE,
      lockedPayTo: PAY_TO,
      lockedAsset: ASSET,
      lockedNetwork: 'eip155:97',
      ...(index === 0 ? { startedAt: STARTED, endedAt: at(3_000) } : {}),
    })),
  )

  return { runId, workflowId, accountId, callIds }
}

function sweep(now: Date, publisher = new FakePublisher()) {
  return sweepTimedOutRuns({ store, publisher, clock: { now: () => now } }).then((result) => ({
    result,
    publisher,
  }))
}

/**
 * Drizzle wraps the driver error, so the constraint that refused a write is on
 * the cause rather than on the message.
 */
function constraintOf(error: unknown): string | undefined {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    const name = (current as { constraint_name?: string }).constraint_name
    if (name) return name
  }
  return undefined
}

async function callStatuses(runId: string) {
  const rows = await db.query.calls.findMany({
    where: (t, { eq }) => eq(t.runId, runId),
    orderBy: (t, { asc }) => [asc(t.nodeIndex)],
  })
  return rows.map((call) => ({
    nodeType: call.nodeType,
    status: call.status,
    skipReason: call.skipReason,
  }))
}

beforeAll(async () => {
  if (!SKIP) await holder.execute(sql`select pg_advisory_lock(${SWEEP_LOCK_KEY})`)
}, 60_000)

afterAll(async () => {
  if (SKIP) return
  await reset()
  await holder.execute(sql`select pg_advisory_unlock(${SWEEP_LOCK_KEY})`)
})

describe.skipIf(SKIP !== null)(`the timeout sweep against ${TEST_DATABASE_URL}`, () => {
  beforeEach(reset)

  // ------------------------------------------------------------ the query

  describe('runsToSweep', () => {
    it('returns a Run whose sweep clock is at or past the cut-off', async () => {
      const setup = await abandonedRun()

      expect(await store.runsToSweep(at(-1))).toEqual([])
      const found = await store.runsToSweep(STARTED)
      expect(found).toEqual([
        {
          runId: setup.runId,
          workflowId: setup.workflowId,
          startedAt: STARTED,
          createdAt: STARTED,
        },
      ])
    })

    it('falls back to created_at for a Run no worker ever started', async () => {
      const created = at(-90_000)
      const setup = await abandonedRun({ startedAt: null, createdAt: created })

      const found = await store.runsToSweep(created)
      expect(found).toEqual([
        {
          runId: setup.runId,
          workflowId: setup.workflowId,
          startedAt: null,
          createdAt: created,
        },
      ])
    })

    it('never returns a Run that has already ended', async () => {
      await abandonedRun({ status: 'completed' })
      expect(await store.runsToSweep(at(STUCK_MS))).toEqual([])
    })

    it('orders the stuck Runs by how long they have been stuck', async () => {
      const older = await abandonedRun({ startedAt: at(-60_000) })
      const newer = await abandonedRun({ startedAt: STARTED })

      const found = await store.runsToSweep(at(1))
      expect(found.map((run) => run.runId)).toEqual([older.runId, newer.runId])
    })
  })

  // ------------------------------------------------------------ the sweep

  describe('a Run abandoned in running past its budget', () => {
    it('is left alone inside the 120 s budget and the 45 s of grace', async () => {
      const setup = await abandonedRun()

      const { result, publisher } = await sweep(at(STUCK_MS - 1))

      expect(result.swept).toEqual([])
      expect(publisher.finalized).toEqual([])
      const row = await db.query.runs.findFirst({ where: (t, { eq }) => eq(t.id, setup.runId) })
      expect(row?.status).toBe('running')
    })

    it('ends timed out with the reason the Run view shows', async () => {
      const setup = await abandonedRun()
      const now = at(STUCK_MS)

      const { result } = await sweep(now)

      expect(result.swept).toMatchObject([{ runId: setup.runId, skippedCalls: 3 }])
      const row = await db.query.runs.findFirst({ where: (t, { eq }) => eq(t.id, setup.runId) })
      expect(row?.status).toBe('timed out')
      expect(row?.endedAt?.toISOString()).toBe(now.toISOString())
      expect(row?.failureReason).toBe(sweepFailureReason(RUN_DEADLINE_MS, RUN_SWEEP_GRACE_MS))
    })

    it('skips the Nodes it never reached and spares the notify Call', async () => {
      const setup = await abandonedRun()

      await sweep(at(STUCK_MS))

      expect(await callStatuses(setup.runId)).toEqual([
        { nodeType: 'data', status: 'succeeded', skipReason: null },
        { nodeType: 'research', status: 'skipped', skipReason: 'not_reached' },
        { nodeType: 'risk', status: 'skipped', skipReason: 'not_reached' },
        { nodeType: 'execution', status: 'skipped', skipReason: 'not_reached' },
        // AD-4: the terminal filter is what the finalize delivery is *for*.
        { nodeType: 'notify', status: 'pending', skipReason: null },
      ])
    })

    it('publishes the finalize delivery for the Run it ended', async () => {
      const setup = await abandonedRun()

      const { publisher } = await sweep(at(STUCK_MS))

      expect(publisher.finalized).toEqual([setup.runId])
    })

    it('ends a Run whose worker died before it ever wrote started_at', async () => {
      const created = at(-STUCK_MS)
      const setup = await abandonedRun({ startedAt: null, createdAt: created })

      const { result } = await sweep(STARTED)

      expect(result.swept).toMatchObject([{ runId: setup.runId }])
      const row = await db.query.runs.findFirst({ where: (t, { eq }) => eq(t.id, setup.runId) })
      expect(row?.status).toBe('timed out')
    })
  })

  // ------------------------------------------------- the AD-4 compare-and-set

  describe('the compare-and-set against a live engine', () => {
    it('writes nothing when the engine ended the Run first', async () => {
      const setup = await abandonedRun()
      // The engine was slow, not dead: it ends the Run itself, truthfully.
      expect(
        await store.endRun(setup.runId, 'failed at research', at(30_000), 'the Agent answered 500'),
      ).toBe(true)

      const { result, publisher } = await sweep(at(STUCK_MS))

      expect(result).toMatchObject({ candidates: 0, lost: 0 })
      expect(publisher.finalized).toEqual([])
      const row = await db.query.runs.findFirst({ where: (t, { eq }) => eq(t.id, setup.runId) })
      expect(row?.status).toBe('failed at research')
      expect(row?.failureReason).toBe('the Agent answered 500')
    })

    it('lets exactly one of two concurrent sweeps end the Run', async () => {
      const setup = await abandonedRun()
      const now = at(STUCK_MS)

      const [first, second] = await Promise.all([sweep(now), sweep(now)])

      // Whichever way the two interleave — both select the Run and one loses
      // the update, or the second selects after the first has ended it — the
      // Run is ended once and finalized once.
      expect(first.result.swept.length + second.result.swept.length).toBe(1)
      expect(first.publisher.finalized.length + second.publisher.finalized.length).toBe(1)
      const row = await db.query.runs.findFirst({ where: (t, { eq }) => eq(t.id, setup.runId) })
      expect(row?.status).toBe('timed out')
      expect(row?.failureReason).toBe(sweepFailureReason(RUN_DEADLINE_MS, RUN_SWEEP_GRACE_MS))
    })
  })

  // ------------------------------------------------------ what the end frees

  describe('what ending the Run releases', () => {
    it('stops counting the unpaid Calls against the Daily Fee Budget', async () => {
      const setup = await abandonedRun()

      // AD-3: `pending` Calls of a `running` Run hold budget — one paid Call
      // plus four Nodes the Run never reached.
      const before = await dailyFeeSpendForAccount(db, setup.accountId, at(STUCK_MS))
      expect(before).toBe(BigInt(PRICE) * 5n)

      await sweep(at(STUCK_MS))

      // Only the Call that was actually paid is still spend. The `notify` Call
      // is `pending` on a Run that is no longer `running`, so it drops out too.
      const after = await dailyFeeSpendForAccount(db, setup.accountId, at(STUCK_MS))
      expect(after).toBe(BigInt(PRICE))
    })

    it('frees the Workflow for a new Run', async () => {
      const setup = await abandonedRun()
      const second = { id: newId('run'), createdAt: at(STUCK_MS) }

      const insertSecond = async () =>
        db.insert(runs).values({
          id: second.id,
          workflowId: setup.workflowId,
          accountId: setup.accountId,
          walletId: (await db.query.wallets.findFirst({
            where: (t, { eq }) => eq(t.accountId, setup.accountId),
          }))!.id,
          status: 'running',
          priceLock: { nodes: [], total: '0', locked_at: STARTED.toISOString() },
          createdAt: second.createdAt,
        })

      // AD-4: the partial unique index is what answers 409 `run_in_progress`.
      await expect(insertSecond().catch(constraintOf)).resolves.toBe(
        'runs_one_running_per_workflow',
      )

      await sweep(at(STUCK_MS))

      await expect(insertSecond()).resolves.toBeDefined()
    })
  })
})
