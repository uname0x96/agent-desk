import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accounts,
  calls,
  createDb,
  listings,
  runs,
  wallets,
  workflowNodes,
  workflows,
  type Database,
} from '@agent-desk/db'
import { newId, toBaseUnits } from '@agent-desk/schemas'
import { createRun, type CreateRunDeps } from './create-run.ts'
import { readRun } from './read-run.ts'

/**
 * `POST /api/runs` and `GET /api/runs/<id>` against real Postgres.
 *
 * The refusal rules themselves are unit-tested in `admission.test.ts`. What can
 * only be wrong in SQL is here: that a refused request leaves no row behind,
 * that AD-4's one-Run-per-Workflow index is what finally decides a race, that
 * the AD-3 spend query run inside the transaction sees the `pending` Calls of
 * another Run of the same account, and that the read answers with a body that
 * parses as `runResponse`.
 *
 * The database is the same one the `scripts` integration tests truncate, so
 * this file takes the same session advisory lock they do — the key below has to
 * stay equal to `LOCK_KEY` in `scripts/src/test-db.ts` or the two will run at
 * once and truncate each other's fixtures.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/agentdesk_story16'

const LOCK_KEY = 1_620_000_016

const ASSET = '0xd0e0851ca8a176d211e2a410f5bcf1fa440fada7'
const NOW = new Date('2026-09-06T12:00:00.000Z')
const PRICE = toBaseUnits('0.01').toString()

async function reachable(): Promise<boolean> {
  try {
    const probe = createDb({ url: TEST_DATABASE_URL, max: 1 })
    await probe.execute('select 1')
    return true
  } catch {
    return false
  }
}

const HAVE_POSTGRES = await reachable()
const db: Database = createDb({ url: TEST_DATABASE_URL, max: 6 })
const holder: Database = createDb({ url: TEST_DATABASE_URL, max: 1 })

async function reset(): Promise<void> {
  await db.execute(`
    truncate chain_tx, settlements, calls, runs, workflow_nodes, workflows, listings, wallets, accounts
    restart identity cascade
  `)
  await db.execute(`
    insert into platform_settings (id, mode, emergency_stop, order_ceiling_usdt, default_daily_fee_budget, verification_cap_daily)
    values (1, 'production', false, '1000', '1000000', '5000000')
    on conflict (id) do update set
      mode = 'production',
      emergency_stop = false,
      default_daily_fee_budget = '1000000',
      platform_account_id = null
  `)
}

/** A distinct lower-case address per fixture, so `wallets_address_key` holds. */
let addressCounter = 0
function nextAddress(): string {
  addressCounter += 1
  return `0x${addressCounter.toString(16).padStart(40, '0')}`
}

interface Fixture {
  accountId: string
  walletId: string
  walletAddress: string
  workflowId: string
  listingIds: string[]
}

async function fixture(
  options: {
    nodeTypes?: readonly ('data' | 'research')[]
    walletReady?: boolean
    dailyFeeBudget?: string | null
    listing?: Partial<{ status: string; pausedByCreator: boolean; pausedByStake: boolean; price: string | null }>
  } = {},
): Promise<Fixture> {
  const accountId = newId('account')
  const walletId = newId('wallet')
  const workflowId = newId('workflow')
  const walletAddress = nextAddress()
  const nodeTypes = options.nodeTypes ?? (['data'] as const)

  await db.insert(accounts).values({
    id: accountId,
    email: `${accountId}@test.local`,
    passwordHash: '!',
    dailyFeeBudget: options.dailyFeeBudget ?? null,
    // The fixture clock is fixed, but `budget_window_start` defaults to the
    // real `now()`, and AD-3 takes the later of it and UTC midnight. Pin it to
    // the epoch so the window is UTC midnight and the spend query is not a
    // function of what time of day the suite runs.
    budgetWindowStart: new Date(0),
  })
  await db.insert(wallets).values({
    id: walletId,
    accountId,
    address: walletAddress,
    encryptedKey: 'gcm1.a.b.c',
    readyAt: options.walletReady === false ? null : NOW,
  })
  await db.insert(workflows).values({ id: workflowId, accountId, name: 'Fixture', symbol: 'BNBUSDT' })

  const listingIds: string[] = []
  for (const [index, nodeType] of nodeTypes.entries()) {
    const listingId = newId('listing')
    listingIds.push(listingId)
    await db.insert(listings).values({
      id: listingId,
      creatorAccountId: accountId,
      name: `Listing ${index}`,
      type: nodeType,
      endpoint: 'https://agent.example/run',
      declaredPrice: PRICE,
      declaredStake: toBaseUnits('0.10').toString(),
      payoutWallet: nextAddress(),
      status: (options.listing?.status ?? 'active') as 'active',
      price: options.listing?.price === undefined ? PRICE : options.listing.price,
      stake: toBaseUnits('0.30').toString(),
      pausedByCreator: options.listing?.pausedByCreator ?? false,
      pausedByStake: options.listing?.pausedByStake ?? false,
    })
    await db.insert(workflowNodes).values({ workflowId, nodeIndex: index, nodeType, listingId })
  }

  return { accountId, walletId, walletAddress, workflowId, listingIds }
}

const published: { runId: string; workflowId: string }[] = []

function deps(overrides: Partial<CreateRunDeps> = {}): CreateRunDeps {
  return {
    db,
    chainId: 97,
    asset: ASSET,
    tokenBalance: async () => 10_000_000n,
    publish: async (runId, workflowId) => {
      published.push({ runId, workflowId })
    },
    now: () => NOW,
    ...overrides,
  }
}

async function countRows(): Promise<{ runs: number; calls: number }> {
  const [runRows, callRows] = await Promise.all([
    db.query.runs.findMany({ columns: { id: true } }),
    db.query.calls.findMany({ columns: { id: true } }),
  ])
  return { runs: runRows.length, calls: callRows.length }
}

beforeAll(async () => {
  if (HAVE_POSTGRES) await holder.execute(`select pg_advisory_lock(${LOCK_KEY})`)
})

afterAll(async () => {
  if (!HAVE_POSTGRES) return
  await reset()
  await holder.execute(`select pg_advisory_unlock(${LOCK_KEY})`)
})

describe.skipIf(!HAVE_POSTGRES)(`POST /api/runs against ${TEST_DATABASE_URL}`, () => {
  beforeEach(async () => {
    published.length = 0
    await reset()
  })

  it('inserts one running Run and one pending Call per Node, then publishes', async () => {
    const setup = await fixture({ nodeTypes: ['data', 'research'] })

    const result = await createRun(deps(), { workflowId: setup.workflowId })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return

    const run = await db.query.runs.findFirst({ where: (t, { eq }) => eq(t.id, result.runId) })
    expect(run?.status).toBe('running')
    expect(run?.accountId).toBe(setup.accountId)
    expect(run?.walletId).toBe(setup.walletId)
    expect(run?.startedAt).toBeNull()
    expect(run?.priceLock.total).toBe(toBaseUnits('0.02').toString())
    expect(run?.priceLock.nodes.map((node) => node.node_index)).toEqual([0, 1])

    const callRows = await db.query.calls.findMany({
      where: (t, { eq }) => eq(t.runId, result.runId),
      orderBy: (t, { asc }) => [asc(t.nodeIndex)],
    })
    expect(callRows.map((call) => call.status)).toEqual(['pending', 'pending'])
    expect(callRows.map((call) => call.kind)).toEqual(['run', 'run'])
    expect(callRows.map((call) => call.listingId)).toEqual(setup.listingIds)
    expect(callRows.map((call) => call.lockedPrice)).toEqual([PRICE, PRICE])
    expect(callRows.map((call) => call.attempt)).toEqual([0, 0])

    // AD-4: the singleton key is the Workflow, and the job is sent after commit.
    expect(published).toEqual([{ runId: result.runId, workflowId: setup.workflowId }])
  })

  it('refuses an unknown Workflow without inserting anything', async () => {
    const result = await createRun(deps(), { workflowId: newId('workflow') })
    expect(result).toMatchObject({ ok: false, refusal: { code: 'not_found' } })
    expect(await countRows()).toEqual({ runs: 0, calls: 0 })
    expect(published).toEqual([])
  })

  it('refuses a paused Listing with validation_failed and inserts nothing', async () => {
    const setup = await fixture({ listing: { pausedByStake: true } })
    const result = await createRun(deps(), { workflowId: setup.workflowId })
    expect(result).toMatchObject({ ok: false, refusal: { code: 'validation_failed' } })
    expect(await countRows()).toEqual({ runs: 0, calls: 0 })
    expect(published).toEqual([])
  })

  it('refuses a wallet with no ready_at and inserts nothing', async () => {
    const setup = await fixture({ walletReady: false })
    const result = await createRun(deps(), { workflowId: setup.workflowId })
    expect(result).toMatchObject({ ok: false, refusal: { code: 'wallet_not_ready' } })
    expect(await countRows()).toEqual({ runs: 0, calls: 0 })
  })

  it('refuses on the Daily Fee Budget and inserts nothing', async () => {
    const setup = await fixture({ dailyFeeBudget: '5000' })
    const result = await createRun(deps(), { workflowId: setup.workflowId })
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'refused_budget', details: { shortfall: '5000' } },
    })
    expect(await countRows()).toEqual({ runs: 0, calls: 0 })
    expect(published).toEqual([])
  })

  it('refuses on the tUSD balance and inserts nothing', async () => {
    const setup = await fixture()
    const result = await createRun(deps({ tokenBalance: async () => 9_999n }), {
      workflowId: setup.workflowId,
    })
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'refused_balance', details: { shortfall: '1' } },
    })
    expect(await countRows()).toEqual({ runs: 0, calls: 0 })
  })

  it('counts the pending Calls of another running Run of the same account (AD-3)', async () => {
    // Two Workflows, one account, a budget that fits exactly one of them.
    const first = await fixture({ dailyFeeBudget: '15000' })
    const secondWorkflowId = newId('workflow')
    await db.insert(workflows).values({
      id: secondWorkflowId,
      accountId: first.accountId,
      name: 'Second',
      symbol: 'BNBUSDT',
    })
    await db.insert(workflowNodes).values({
      workflowId: secondWorkflowId,
      nodeIndex: 0,
      nodeType: 'data',
      listingId: first.listingIds[0] as string,
    })

    const admitted = await createRun(deps(), { workflowId: first.workflowId })
    expect(admitted.ok).toBe(true)

    // Nothing has been paid yet — the first Run's `pending` Call is what the
    // budget is spent on, so the second Run does not fit.
    const refused = await createRun(deps(), { workflowId: secondWorkflowId })
    expect(refused).toMatchObject({
      ok: false,
      refusal: { code: 'refused_budget', details: { spend: '10000', budget: '15000' } },
    })
    expect(await countRows()).toEqual({ runs: 1, calls: 1 })
  })

  it('refuses a second Run of the same Workflow with run_in_progress', async () => {
    const setup = await fixture()
    const first = await createRun(deps(), { workflowId: setup.workflowId })
    expect(first.ok).toBe(true)

    const second = await createRun(deps(), { workflowId: setup.workflowId })
    expect(second).toMatchObject({ ok: false, refusal: { code: 'run_in_progress' } })
    expect(await countRows()).toEqual({ runs: 1, calls: 1 })
    expect(published).toHaveLength(1)
  })

  it('admits a new Run once the previous one has ended', async () => {
    const setup = await fixture()
    const first = await createRun(deps(), { workflowId: setup.workflowId })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    await db.execute(`update runs set status = 'completed' where id = '${first.runId}'`)

    const second = await createRun(deps(), { workflowId: setup.workflowId })
    expect(second.ok).toBe(true)
    expect((await countRows()).runs).toBe(2)
  })

  it('lets the partial unique index decide a Run inserted after the pre-check', async () => {
    const setup = await fixture()
    // A second account, because the competing insert has to reach `runs`
    // without touching the account row this transaction holds: the foreign key
    // from `runs.account_id` takes a key-share lock, and `FOR UPDATE` blocks it.
    const other = await fixture()

    // The chain read is the last thing before the insert, so a competing Run
    // committed from here lands between this transaction's `run_in_progress`
    // read and its own insert. Nothing but `runs_one_running_per_workflow` can
    // catch it, and the caller still has to see a clean 409.
    let raced = false
    const racing = deps({
      tokenBalance: async () => {
        if (!raced) {
          raced = true
          await db.insert(runs).values({
            id: newId('run'),
            workflowId: setup.workflowId,
            accountId: other.accountId,
            walletId: other.walletId,
            status: 'running',
            priceLock: { nodes: [], total: '0', locked_at: NOW.toISOString() },
          })
        }
        return 10_000_000n
      },
    })

    const result = await createRun(racing, { workflowId: setup.workflowId })
    expect(raced).toBe(true)
    expect(result).toMatchObject({ ok: false, refusal: { code: 'run_in_progress' } })
    // The competing Run is the only one, and the refused transaction rolled its
    // own Calls back with it.
    expect(await countRows()).toEqual({ runs: 1, calls: 0 })
    expect(published).toEqual([])
  })

  it('serialises two concurrent requests for one Workflow on the account row lock', async () => {
    const setup = await fixture()

    const [left, right] = await Promise.all([
      createRun(deps(), { workflowId: setup.workflowId }),
      createRun(deps(), { workflowId: setup.workflowId }),
    ])

    const outcomes = [left, right].map((result) => (result.ok ? 'ok' : result.refusal.code))
    expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === 'run_in_progress')).toHaveLength(1)
    expect(await countRows()).toEqual({ runs: 1, calls: 1 })
    expect(published).toHaveLength(1)
  })

  it('rejects a second running Run for one Workflow at the index itself', async () => {
    const setup = await fixture()
    const first = await createRun(deps(), { workflowId: setup.workflowId })
    expect(first.ok).toBe(true)

    await expect(
      db.insert(runs).values({
        id: newId('run'),
        workflowId: setup.workflowId,
        accountId: setup.accountId,
        walletId: setup.walletId,
        status: 'running',
        priceLock: { nodes: [], total: '0', locked_at: NOW.toISOString() },
      }),
      // Drizzle wraps the driver error, so the SQLSTATE is one level down.
    ).rejects.toMatchObject({ cause: { code: '23505', constraint_name: 'runs_one_running_per_workflow' } })
  })

  it('refuses to lock an account id that is not a type-prefixed ULID', async () => {
    const setup = await fixture()
    // The value only ever comes from `workflows.account_id`, so reaching the
    // guard means the database itself is broken; it must still not be
    // interpolated into a statement.
    await db.insert(accounts).values({ id: "acc_'; drop table runs; --", email: 'x@test.local', passwordHash: '!' })
    await db.execute(
      `update workflows set account_id = 'acc_''; drop table runs; --' where id = '${setup.workflowId}'`,
    )

    await expect(createRun(deps(), { workflowId: setup.workflowId })).rejects.toThrow(
      /malformed account id/,
    )
    const survived = await db.query.runs.findMany({ columns: { id: true } })
    expect(survived).toEqual([])
  })
})

describe.skipIf(!HAVE_POSTGRES)('GET /api/runs/<id>', () => {
  beforeEach(async () => {
    published.length = 0
    await reset()
  })

  it('answers null for a Run that does not exist', async () => {
    expect(await readRun(db, newId('run'))).toBeNull()
  })

  it('answers the Run, its Price Lock, and every Call, parsed against runResponse', async () => {
    const setup = await fixture({ nodeTypes: ['data', 'research'] })
    const created = await createRun(deps(), { workflowId: setup.workflowId })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const body = await readRun(db, created.runId)
    expect(body).not.toBeNull()
    if (!body) return

    expect(body.id).toBe(created.runId)
    expect(body.workflow_id).toBe(setup.workflowId)
    expect(body.workflow_name).toBe('Fixture')
    expect(body.symbol).toBe('BNBUSDT')
    expect(body.status).toBe('running')
    expect(body.wallet_address).toBe(setup.walletAddress)
    expect(body.price_lock.total).toBe(toBaseUnits('0.02').toString())
    expect(body.started_at).toBeNull()
    expect(body.ended_at).toBeNull()
    expect(body.created_at).toBe(NOW.toISOString())
    expect(body.calls).toHaveLength(2)
    expect(body.calls.map((call) => call.node_index)).toEqual([0, 1])
    expect(body.calls.map((call) => call.provider)).toEqual(['Listing 0', 'Listing 1'])
    expect(body.calls.map((call) => call.settlement)).toEqual([null, null])
  })

  it('counts only the paid statuses in total_cost', async () => {
    const setup = await fixture({ nodeTypes: ['data', 'research'] })
    const created = await createRun(deps(), { workflowId: setup.workflowId })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    // Nothing paid yet, even though the Price Lock says the Run may cost 0.02.
    expect((await readRun(db, created.runId))?.total_cost).toBe('0')

    await db.execute(
      `update calls set status = 'succeeded' where run_id = '${created.runId}' and node_index = 0`,
    )
    expect((await readRun(db, created.runId))?.total_cost).toBe(PRICE)

    // `failed_after_payment` is paid too: the transfer landed.
    await db.execute(
      `update calls set status = 'failed_after_payment' where run_id = '${created.runId}' and node_index = 1`,
    )
    expect((await readRun(db, created.runId))?.total_cost).toBe(toBaseUnits('0.02').toString())

    // A skipped Call never paid, so it never counts.
    await db.execute(
      `update calls set status = 'skipped', skip_reason = 'not_reached' where run_id = '${created.runId}' and node_index = 1`,
    )
    expect((await readRun(db, created.runId))?.total_cost).toBe(PRICE)
  })

  it('renders the timestamps a Run picks up as it runs, as ISO 8601 UTC', async () => {
    const setup = await fixture()
    const created = await createRun(deps(), { workflowId: setup.workflowId })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    await db.execute(
      `update runs set status = 'failed at data', failure_reason = 'price lock mismatch on amount',
       started_at = '2026-09-06T12:00:01.000Z', ended_at = '2026-09-06T12:00:02.500Z'
       where id = '${created.runId}'`,
    )

    const body = await readRun(db, created.runId)
    expect(body?.status).toBe('failed at data')
    expect(body?.failure_reason).toBe('price lock mismatch on amount')
    expect(body?.started_at).toBe('2026-09-06T12:00:01.000Z')
    expect(body?.ended_at).toBe('2026-09-06T12:00:02.500Z')
  })
})
