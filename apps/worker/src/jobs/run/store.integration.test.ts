import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
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
import { newId, toBaseUnits, type PriceLock } from '@agent-desk/schemas'
import { createRunStore } from './store.ts'

/**
 * The run engine's store against real Postgres.
 *
 * The engine itself is unit-tested against a fake store; this file exists for
 * the three things only SQL can get wrong: AD-4's compare-and-set on the Run
 * status, `started_at` being set once and never restarted by a redelivery, and
 * the partial writes of `updateCall` leaving every other column alone.
 *
 * The database is the same one the `scripts` integration tests truncate, so
 * this file takes the same session advisory lock they do — the key below has to
 * stay equal to `LOCK_KEY` in `scripts/src/test-db.ts` or the two will run at
 * once and truncate each other's fixtures.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/agentdesk_story16'

const LOCK_KEY = 1_620_000_016

const PRICE = toBaseUnits('0.01').toString()
const NOW = new Date('2026-09-06T12:00:00.000Z')
const PAY_TO = '0x00000000000000000000000000000000000000bb'
const ASSET = '0xd0e0851ca8a176d211e2a410f5bcf1fa440fada7'
const TX_HASH = `0x${'ab'.repeat(32)}`

async function reachable(): Promise<boolean> {
  try {
    const probe = createDb({ url: TEST_DATABASE_URL, max: 1 })
    await probe.execute(sql`select 1`)
    return true
  } catch {
    return false
  }
}

const HAVE_POSTGRES = await reachable()
const db: Database = createDb({ url: TEST_DATABASE_URL, max: 4 })
const holder: Database = createDb({ url: TEST_DATABASE_URL, max: 1 })
const store = createRunStore(db)

async function reset(): Promise<void> {
  await db.execute(sql`
    truncate chain_tx, settlements, calls, runs, workflow_nodes, workflows, listings, wallets, accounts
    restart identity cascade
  `)
  await db.execute(sql`
    insert into platform_settings (id, mode, emergency_stop, order_ceiling_usdt, default_daily_fee_budget, verification_cap_daily)
    values (1, 'production', false, '1000', '1000000', '5000000')
    on conflict (id) do update set platform_account_id = null
  `)
}

let addressCounter = 0
function nextAddress(): string {
  addressCounter += 1
  return `0x${addressCounter.toString(16).padStart(40, '0')}`
}

interface Fixture {
  runId: string
  workflowId: string
  listingIds: string[]
  callIds: string[]
}

/** One account, one wallet, one Workflow of two Nodes, one `running` Run. */
async function fixture(): Promise<Fixture> {
  const accountId = newId('account')
  const walletId = newId('wallet')
  const workflowId = newId('workflow')
  const runId = newId('run')
  const nodeTypes = ['data', 'research'] as const

  await db.insert(accounts).values({
    id: accountId,
    email: `${accountId}@test.local`,
    passwordHash: '!',
    telegramChatId: '123456789',
  })
  await db.insert(wallets).values({
    id: walletId,
    accountId,
    address: nextAddress(),
    encryptedKey: 'gcm1.a.b.c',
    readyAt: NOW,
  })
  await db.insert(workflows).values({
    id: workflowId,
    accountId,
    name: 'Fixture',
    symbol: 'BNBUSDT',
    orderCapUsdt: '25',
  })

  const listingIds: string[] = []
  for (const [index, nodeType] of nodeTypes.entries()) {
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
    nodes: nodeTypes.map((nodeType, index) => ({
      node_index: index,
      node_type: nodeType,
      listing_id: listingIds[index] as string,
      provider: `Listing ${index}`,
      price: PRICE,
      asset: ASSET,
      network: 'eip155:97',
      pay_to: PAY_TO,
    })),
    total: toBaseUnits('0.02').toString(),
    locked_at: NOW.toISOString(),
  }

  await db.insert(runs).values({
    id: runId,
    workflowId,
    accountId,
    walletId,
    status: 'running',
    priceLock,
    createdAt: NOW,
  })

  const callIds = nodeTypes.map(() => newId('call'))
  await db.insert(calls).values(
    nodeTypes.map((nodeType, index) => ({
      id: callIds[index] as string,
      runId,
      kind: 'run' as const,
      listingId: listingIds[index] as string,
      nodeIndex: index,
      nodeType,
      status: 'pending' as const,
      lockedPrice: PRICE,
      lockedPayTo: PAY_TO,
      lockedAsset: ASSET,
      lockedNetwork: 'eip155:97',
    })),
  )

  return { runId, workflowId, listingIds, callIds }
}

beforeAll(async () => {
  if (HAVE_POSTGRES) await holder.execute(sql`select pg_advisory_lock(${LOCK_KEY})`)
})

afterAll(async () => {
  if (!HAVE_POSTGRES) return
  await reset()
  await holder.execute(sql`select pg_advisory_unlock(${LOCK_KEY})`)
})

describe.skipIf(!HAVE_POSTGRES)(`run store against ${TEST_DATABASE_URL}`, () => {
  beforeEach(reset)

  it('answers null for a Run that is not there', async () => {
    expect(await store.load(newId('run'))).toBeNull()
  })

  it('loads the Run with the Workflow, the account, and the Calls in node order', async () => {
    const setup = await fixture()
    const record = await store.load(setup.runId)
    expect(record).not.toBeNull()
    if (!record) return

    expect(record.status).toBe('running')
    expect(record.startedAt).toBeNull()
    expect(record.symbol).toBe('BNBUSDT')
    expect(record.orderCapUsdt).toBe('25')
    expect(record.telegramChatId).toBe('123456789')
    expect(record.nodeTypes).toEqual(['data', 'research'])
    expect(record.calls.map((call) => call.nodeIndex)).toEqual([0, 1])
    expect(record.calls.map((call) => call.status)).toEqual(['pending', 'pending'])
    // AD-2: the endpoint and the provider name come from `listings`, not from
    // the Price Lock, which fixes only the price.
    expect(record.calls.map((call) => call.endpoint)).toEqual([
      'https://agent.example/0',
      'https://agent.example/1',
    ])
    expect(record.calls.map((call) => call.provider)).toEqual(['Listing 0', 'Listing 1'])
    expect(record.calls.map((call) => call.hasPaymentPayload)).toEqual([false, false])
  })

  it('reports a stored authorization without reading it', async () => {
    const setup = await fixture()
    const callId = setup.callIds[0] as string
    await db
      .update(calls)
      .set({ paymentPayload: { nonce: '0x01', header: 'eyJ4IjoxfQ==' } })
      .where(eq(calls.id, callId))

    const record = await store.load(setup.runId)
    expect(record?.calls[0]?.hasPaymentPayload).toBe(true)
    expect(record?.calls[1]?.hasPaymentPayload).toBe(false)
    expect(await store.readPaymentPayload(callId)).toMatchObject({ nonce: '0x01' })
    expect(await store.readPaymentPayload(setup.callIds[1] as string)).toBeNull()
  })

  it('never sees a verification Call, because one cannot belong to a Run', async () => {
    const setup = await fixture()
    // AD-3: `calls_run_id_matches_kind` is what makes the `kind = 'run'` filter
    // in the load query unfalsifiable, so the constraint is what is asserted.
    await expect(
      db.insert(calls).values({
        id: newId('call'),
        runId: setup.runId,
        kind: 'verification',
        listingId: setup.listingIds[0] as string,
        nodeIndex: 0,
        nodeType: 'data',
        status: 'succeeded',
        lockedPrice: PRICE,
        lockedPayTo: PAY_TO,
        lockedAsset: ASSET,
        lockedNetwork: 'eip155:97',
      }),
    ).rejects.toMatchObject({ cause: { constraint_name: 'calls_run_id_matches_kind' } })

    // The Listing's own verification Call, which is what the constraint allows.
    await db.insert(calls).values({
      id: newId('call'),
      runId: null,
      kind: 'verification',
      listingId: setup.listingIds[0] as string,
      nodeIndex: 0,
      nodeType: 'data',
      status: 'succeeded',
      lockedPrice: PRICE,
      lockedPayTo: PAY_TO,
      lockedAsset: ASSET,
      lockedNetwork: 'eip155:97',
    })

    const record = await store.load(setup.runId)
    expect(record?.calls).toHaveLength(2)
  })

  it('sets started_at once, so a redelivery never restarts the 120 s budget', async () => {
    const setup = await fixture()
    const first = await store.markStarted(setup.runId, new Date('2026-09-06T12:00:01.000Z'))
    expect(first.toISOString()).toBe('2026-09-06T12:00:01.000Z')

    const second = await store.markStarted(setup.runId, new Date('2026-09-06T12:00:41.000Z'))
    expect(second.toISOString()).toBe('2026-09-06T12:00:01.000Z')

    const row = await db.query.runs.findFirst({ where: (t, { eq }) => eq(t.id, setup.runId) })
    expect(row?.startedAt?.toISOString()).toBe('2026-09-06T12:00:01.000Z')
  })

  it('writes only the fields a patch names', async () => {
    const setup = await fixture()
    const callId = setup.callIds[0] as string

    await store.updateCall(callId, {
      status: 'paid_awaiting_result',
      attempt: 1,
      request: { symbol: 'BNBUSDT' },
      startedAt: new Date('2026-09-06T12:00:01.000Z'),
    })
    await store.updateCall(callId, { paymentTxHash: TX_HASH })

    const row = await db.query.calls.findFirst({ where: (t, { eq }) => eq(t.id, callId) })
    expect(row?.status).toBe('paid_awaiting_result')
    expect(row?.attempt).toBe(1)
    expect(row?.request).toEqual({ symbol: 'BNBUSDT' })
    expect(row?.paymentTxHash).toBe(TX_HASH)
    // Untouched by both patches.
    expect(row?.response).toBeNull()
    expect(row?.failureReason).toBeNull()
    expect(row?.endedAt).toBeNull()
  })

  it('keeps the Call started_at of the first request', async () => {
    const setup = await fixture()
    const callId = setup.callIds[0] as string
    await store.updateCall(callId, { startedAt: new Date('2026-09-06T12:00:01.000Z') })
    await store.updateCall(callId, { startedAt: new Date('2026-09-06T12:00:09.000Z') })

    const row = await db.query.calls.findFirst({ where: (t, { eq }) => eq(t.id, callId) })
    expect(row?.startedAt?.toISOString()).toBe('2026-09-06T12:00:01.000Z')
  })

  it('does nothing at all for an empty patch', async () => {
    const setup = await fixture()
    const callId = setup.callIds[0] as string
    await store.updateCall(callId, {})
    const row = await db.query.calls.findFirst({ where: (t, { eq }) => eq(t.id, callId) })
    expect(row?.status).toBe('pending')
  })

  it('ends a running Run and reports that it did', async () => {
    const setup = await fixture()
    const ended = new Date('2026-09-06T12:00:30.000Z')
    expect(await store.endRun(setup.runId, 'completed', ended, null)).toBe(true)

    const row = await db.query.runs.findFirst({ where: (t, { eq }) => eq(t.id, setup.runId) })
    expect(row?.status).toBe('completed')
    expect(row?.endedAt?.toISOString()).toBe(ended.toISOString())
    expect(row?.failureReason).toBeNull()
  })

  it('refuses the second writer and leaves the first end in place (AD-4)', async () => {
    const setup = await fixture()
    const first = new Date('2026-09-06T12:00:30.000Z')
    expect(await store.endRun(setup.runId, 'completed', first, null)).toBe(true)

    // The timeout sweep, or a second delivery, arriving late.
    const second = new Date('2026-09-06T12:02:05.000Z')
    expect(await store.endRun(setup.runId, 'timed out', second, 'run budget exceeded')).toBe(false)

    const row = await db.query.runs.findFirst({ where: (t, { eq }) => eq(t.id, setup.runId) })
    expect(row?.status).toBe('completed')
    expect(row?.endedAt?.toISOString()).toBe(first.toISOString())
    expect(row?.failureReason).toBeNull()
  })

  it('lets exactly one of two concurrent writers end a Run', async () => {
    const setup = await fixture()
    const at = new Date('2026-09-06T12:00:30.000Z')

    const results = await Promise.all([
      store.endRun(setup.runId, 'completed', at, null),
      store.endRun(setup.runId, 'timed out', at, 'run budget exceeded'),
      store.endRun(setup.runId, 'failed at data', at, 'price lock mismatch on amount'),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)

    const row = await db.query.runs.findFirst({ where: (t, { eq }) => eq(t.id, setup.runId) })
    expect(row?.status).not.toBe('running')
  })

  it('reports false for a Run that was never there', async () => {
    expect(await store.endRun(newId('run'), 'completed', NOW, null)).toBe(false)
  })

  it('skips only the pending Calls of this Run and counts them', async () => {
    const setup = await fixture()
    const other = await fixture()
    await store.updateCall(setup.callIds[0] as string, { status: 'succeeded' })

    const at = new Date('2026-09-06T12:00:30.000Z')
    expect(await store.skipPendingCalls(setup.runId, 'not_reached', at)).toBe(1)

    const rows = await db.query.calls.findMany({
      where: (t, { eq }) => eq(t.runId, setup.runId),
      orderBy: (t, { asc }) => [asc(t.nodeIndex)],
    })
    expect(rows.map((call) => call.status)).toEqual(['succeeded', 'skipped'])
    expect(rows[1]?.skipReason).toBe('not_reached')
    expect(rows[1]?.endedAt?.toISOString()).toBe(at.toISOString())

    // The other Run is untouched.
    const untouched = await db.query.calls.findMany({ where: (t, { eq }) => eq(t.runId, other.runId) })
    expect(untouched.map((call) => call.status)).toEqual(['pending', 'pending'])
  })

  it('skips nothing when every Call has already finished', async () => {
    const setup = await fixture()
    await store.updateCall(setup.callIds[0] as string, { status: 'succeeded' })
    await store.updateCall(setup.callIds[1] as string, { status: 'price_mismatch' })
    expect(await store.skipPendingCalls(setup.runId, 'not_reached', NOW)).toBe(0)
  })
})
