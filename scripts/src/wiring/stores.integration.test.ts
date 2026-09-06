import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { accounts, calls, listings, runs, settlements, wallets, workflows, type Database } from '@agent-desk/db'
import { newId, toBaseUnits, type PriceLock } from '@agent-desk/schemas'
import type { Hex } from '@agent-desk/core/ports'
import { TEST_DATABASE_URL, databaseLock, databaseReachable, resetDatabase, testDb } from '../test-db.ts'
import {
  createChainTxStore,
  createListingCacheStore,
  createSigningStore,
  createWalletStore,
} from './stores.ts'

/**
 * The store implementations against real Postgres. Everything above them is
 * covered by unit tests with in-memory doubles; these exist because the parts
 * that can only be wrong in SQL — `on conflict do nothing`, the one transaction
 * AD-5 requires, and the nine chain-owned columns actually landing — cannot be
 * proven anywhere else.
 */

const HAVE_POSTGRES = await databaseReachable()
const db: Database = testDb()
const lock = databaseLock()

const ADDRESS_A = '0x00000000000000000000000000000000000000aa'
const ADDRESS_B = '0x00000000000000000000000000000000000000bb'

const PRICE_LOCK: PriceLock = {
  nodes: [
    {
      node_index: 0,
      node_type: 'data',
      listing_id: 'lst_seed',
      provider: 'seed',
      price: '10000',
      asset: '0x00000000000000000000000000000000000000cc',
      network: 'eip155:97',
      pay_to: ADDRESS_B,
    },
  ],
  total: '10000',
  locked_at: '2026-09-06T12:00:00.000',
}

/** One account, one wallet, one listing, one workflow, one run. */
async function fixtures() {
  const accountId = newId('account')
  const walletId = newId('wallet')
  const listingId = newId('listing')
  const workflowId = newId('workflow')
  const runId = newId('run')

  await db.insert(accounts).values({ id: accountId, email: `${accountId}@test.local`, passwordHash: '!' })
  await db.insert(wallets).values({ id: walletId, accountId, address: ADDRESS_A, encryptedKey: 'gcm1.a.b.c' })
  await db.insert(listings).values({
    id: listingId,
    creatorAccountId: accountId,
    name: 'Seed listing',
    type: 'research',
    endpoint: 'https://agent.example/run',
    declaredPrice: toBaseUnits('0.01').toString(),
    declaredStake: toBaseUnits('0.10').toString(),
    payoutWallet: ADDRESS_B,
    status: 'active',
    stake: toBaseUnits('0.30').toString(),
  })
  await db.insert(workflows).values({ id: workflowId, accountId, name: 'Seed', symbol: 'BNBUSDT' })
  await db.insert(runs).values({
    id: runId,
    workflowId,
    accountId,
    walletId,
    status: 'running',
    priceLock: PRICE_LOCK,
  })
  return { accountId, walletId, listingId, workflowId, runId }
}

async function insertCall(input: {
  runId: string | null
  listingId: string
  kind: 'run' | 'verification'
  status: string
  nodeType?: string
  price?: string
  startedAt?: Date
}): Promise<string> {
  const id = newId('call')
  await db.insert(calls).values({
    id,
    runId: input.runId,
    kind: input.kind,
    listingId: input.listingId,
    nodeIndex: 0,
    nodeType: (input.nodeType ?? 'research') as 'research',
    status: input.status as 'pending',
    lockedPrice: input.price ?? toBaseUnits('0.10').toString(),
    lockedPayTo: ADDRESS_B,
    lockedAsset: '0x00000000000000000000000000000000000000cc',
    lockedNetwork: 'eip155:97',
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
  })
  return id
}

beforeAll(async () => {
  if (HAVE_POSTGRES) await lock.acquire()
})

afterAll(async () => {
  if (!HAVE_POSTGRES) return
  await resetDatabase(db)
  await lock.release()
})

describe.skipIf(!HAVE_POSTGRES)(`stores against ${TEST_DATABASE_URL}`, () => {
  beforeEach(() => resetDatabase(db))

  // ------------------------------------------------------------- chain_tx

  describe('chain_tx store', () => {
    it('inserts pending, then reports the second insert as not inserted', async () => {
      const store = createChainTxStore(db)

      const first = await store.insertPending('list:lst_1', { listing_id: 'lst_1' })
      const second = await store.insertPending('list:lst_1', { listing_id: 'other' })

      expect(first.inserted).toBe(true)
      expect(first.record.status).toBe('pending')
      // AD-8: only the caller that inserted may send, and the payload the first
      // one wrote is the one that stands.
      expect(second.inserted).toBe(false)
      expect(second.record.payload).toEqual({ listing_id: 'lst_1' })
    })

    it('records the hash before the receipt, then settles', async () => {
      const store = createChainTxStore(db)
      const hash = `0x${'ab'.repeat(32)}` as Hex
      await store.insertPending('gas:wal_1', { wallet_id: 'wal_1' })

      await store.attachHash('gas:wal_1', hash)
      expect(await store.find('gas:wal_1')).toMatchObject({ status: 'pending', txHash: hash })

      const confirmedAt = new Date('2026-09-06T12:00:09.000Z')
      await store.settle('gas:wal_1', 'confirmed', { txHash: hash, confirmedAt })
      expect(await store.find('gas:wal_1')).toMatchObject({ status: 'confirmed', txHash: hash, confirmedAt })
    })

    it('lower-cases the hash it stores, which the column check requires', async () => {
      const store = createChainTxStore(db)
      await store.insertPending('mint:wal_1', {})
      await store.attachHash('mint:wal_1', `0x${'AB'.repeat(32)}` as Hex)
      expect((await store.find('mint:wal_1'))?.txHash).toBe(`0x${'ab'.repeat(32)}`)
    })

    it('answers null for an intent key that was never written', async () => {
      expect(await createChainTxStore(db).find('list:lst_missing')).toBeNull()
    })
  })

  // ------------------------------------------------------------- listings

  describe('listings cache store', () => {
    it('writes all nine chain-owned columns and nothing else', async () => {
      const { listingId } = await fixtures()
      const store = createListingCacheStore(db)

      await store.writeChainOwned(listingId, {
        price: '20000',
        stake: '200000',
        reputationBps: 8_750,
        pausedByCreator: true,
        pausedByStake: true,
        payoutWallet: ADDRESS_A,
        endpoint: 'https://agent.example/v2',
        agentId: '31',
        registryListingId: '7',
      })

      const [row] = await db.select().from(listings)
      expect(row).toMatchObject({
        price: '20000',
        stake: '200000',
        reputationBps: 8_750,
        pausedByCreator: true,
        pausedByStake: true,
        payoutWallet: ADDRESS_A,
        endpoint: 'https://agent.example/v2',
        agentId: '31',
        registryListingId: '7',
      })
      // The form-owned columns are the Creator's and are never overwritten.
      expect(row).toMatchObject({
        name: 'Seed listing',
        declaredPrice: '10000',
        declaredStake: '100000',
        status: 'active',
      })
    })

    it('reads back what refreshListingFromChain needs and no more', async () => {
      const { listingId, accountId } = await fixtures()
      expect(await createListingCacheStore(db).read(listingId)).toEqual({
        id: listingId,
        creatorAccountId: accountId,
        type: 'research',
        agentId: null,
        registryListingId: null,
        price: null,
        stake: toBaseUnits('0.30').toString(),
      })
    })

    it('records last_error for a reverted or failed intent', async () => {
      const { listingId } = await fixtures()
      await createListingCacheStore(db).writeLastError(listingId, 'list:lst_1 reverted on chain')
      const [row] = await db.select().from(listings)
      expect(row?.lastError).toBe('list:lst_1 reverted on chain')
    })
  })

  // -------------------------------------------------------------- wallets

  describe('wallet store', () => {
    it('inserts, finds by account, and marks ready once', async () => {
      const store = createWalletStore(db)
      const accountId = newId('account')
      await db.insert(accounts).values({ id: accountId, email: `${accountId}@test.local`, passwordHash: '!' })

      expect(await store.findByAccount(accountId)).toBeNull()
      const inserted = await store.insert({
        id: newId('wallet'),
        accountId,
        address: ADDRESS_A,
        encryptedKey: 'gcm1.a.b.c',
      })
      expect(inserted.readyAt).toBeNull()
      expect(await store.findByAccount(accountId)).toEqual(inserted)

      const readyAt = new Date('2026-09-06T12:00:09.000Z')
      await store.markReady(inserted.id, readyAt)
      expect((await store.findByAccount(accountId))?.readyAt).toEqual(readyAt)

      // AD-5: `ready_at` comes from the approve receipt and is never moved by a
      // redelivered job that read a later block.
      await store.markReady(inserted.id, new Date('2026-09-07T00:00:00.000Z'))
      expect((await store.findByAccount(accountId))?.readyAt).toEqual(readyAt)
    })

    it('lower-cases the address, which the column check requires', async () => {
      const store = createWalletStore(db)
      const accountId = newId('account')
      await db.insert(accounts).values({ id: accountId, email: `${accountId}@test.local`, passwordHash: '!' })
      const wallet = await store.insert({
        id: newId('wallet'),
        accountId,
        address: '0x00000000000000000000000000000000000000AA',
        encryptedKey: 'gcm1.a.b.c',
      })
      expect(wallet.address).toBe(ADDRESS_A)
    })
  })

  // -------------------------------------------------------- signing store

  describe('signing store', () => {
    it('reads platform_settings, which AD-10 re-reads per operation', async () => {
      expect(await createSigningStore(db).platformSettings()).toEqual({
        mode: 'production',
        emergencyStop: false,
        defaultDailyFeeBudget: '1000000',
        verificationCapDaily: '5000000',
        platformAccountId: null,
      })
    })

    it('falls back to the platform default budget when the account sets none', async () => {
      const { accountId, listingId, runId } = await fixtures()
      const callId = await insertCall({ runId, listingId, kind: 'run', status: 'pending' })

      const usage = await createSigningStore(db).budgetUsage(accountId, callId, new Date())

      expect(usage.budget).toBe(1_000_000n)
      // A `pending` Call of a `running` Run is inside the AD-3 spend already, so
      // the policy must not add it a second time.
      expect(usage.spend).toBe(toBaseUnits('0.10'))
      expect(usage.callCounted).toBe(true)
    })

    it('prefers the account budget and drops a Call the spend does not count', async () => {
      const { accountId, listingId, runId } = await fixtures()
      await db.update(accounts).set({ dailyFeeBudget: toBaseUnits('2').toString() })
      await db.update(runs).set({ status: 'completed' })
      const callId = await insertCall({ runId, listingId, kind: 'run', status: 'pending' })

      const usage = await createSigningStore(db).budgetUsage(accountId, callId, new Date())

      expect(usage.budget).toBe(toBaseUnits('2'))
      // The Run is no longer `running`, so its `pending` Call counts for nothing.
      expect(usage.spend).toBe(0n)
      expect(usage.callCounted).toBe(false)
    })

    it('reads the Stake from the chain-owned cache and reserves the unscored Calls', async () => {
      const { listingId, runId } = await fixtures()
      const paid = await insertCall({ runId, listingId, kind: 'run', status: 'paid_awaiting_result' })
      const second = await insertCall({ runId, listingId, kind: 'run', status: 'paid_awaiting_result' })

      const store = createSigningStore(db)
      const before = await store.stakeUsage(listingId, second)
      expect(before.stake).toBe(toBaseUnits('0.30'))
      expect(before.reserved).toBe(toBaseUnits('0.20'))
      expect(before.callCounted).toBe(true)

      // FR-25: the Settlement row releases the reservation, whatever it says.
      await db.insert(settlements).values({
        id: newId('settlement'),
        callId: paid,
        listingId,
        result: 'passed',
        mode: 'production',
        ruleLabel: 'test',
        scoredAt: new Date(),
      })
      const after = await store.stakeUsage(listingId, second)
      expect(after.reserved).toBe(toBaseUnits('0.10'))
    })

    it('measures the verification spend against the platform cap', async () => {
      const { listingId } = await fixtures()
      const inside = await insertCall({
        runId: null,
        listingId,
        kind: 'verification',
        status: 'succeeded',
        startedAt: new Date(Date.now() - 60_000),
      })
      await insertCall({
        runId: null,
        listingId,
        kind: 'verification',
        status: 'succeeded',
        startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      })

      const usage = await createSigningStore(db).verificationUsage(inside, new Date())

      expect(usage.cap).toBe(5_000_000n)
      // Only the Call inside the 24 h window.
      expect(usage.spent).toBe(toBaseUnits('0.10'))
      expect(usage.callCounted).toBe(true)
    })

    it('writes the payment payload and the status in one transaction (AD-5)', async () => {
      const { listingId, runId } = await fixtures()
      const callId = await insertCall({ runId, listingId, kind: 'run', status: 'pending' })
      const store = createSigningStore(db)
      const startedAt = new Date('2026-09-06T12:00:00.000Z')

      expect(await store.readPaymentPayload(callId)).toBeNull()
      await store.recordPaymentAuthorization({
        callId,
        startedAt,
        payload: {
          header: 'eyJ4NDAy',
          nonce: `0x${'11'.repeat(32)}` as Hex,
          validAfter: '0',
          validBefore: '1793000000',
          from: ADDRESS_A,
          to: ADDRESS_B,
          value: '10000',
          signature: `0x${'22'.repeat(65)}` as Hex,
        },
      })

      const [row] = await db.select().from(calls)
      expect(row?.status).toBe('paid_awaiting_result')
      expect(row?.startedAt).toEqual(startedAt)
      expect(await store.readPaymentPayload(callId)).toMatchObject({
        header: 'eyJ4NDAy',
        from: ADDRESS_A,
        to: ADDRESS_B,
        value: '10000',
      })
    })

    it('does not move started_at on a Call that already has one', async () => {
      const { listingId, runId } = await fixtures()
      const startedAt = new Date('2026-09-06T11:00:00.000Z')
      const callId = await insertCall({ runId, listingId, kind: 'run', status: 'pending', startedAt })

      await createSigningStore(db).recordPaymentAuthorization({
        callId,
        startedAt: new Date('2026-09-06T12:00:00.000Z'),
        payload: {
          header: 'h',
          nonce: `0x${'11'.repeat(32)}` as Hex,
          validAfter: '0',
          validBefore: '1',
          from: ADDRESS_A,
          to: ADDRESS_B,
          value: '10000',
          signature: `0x${'22'.repeat(65)}` as Hex,
        },
      })

      const [row] = await db.select().from(calls)
      expect(row?.startedAt).toEqual(startedAt)
    })

    it('finds a wallet by id and answers null for one that does not exist', async () => {
      const { walletId, accountId } = await fixtures()
      const store = createSigningStore(db)
      expect(await store.getWallet(walletId)).toMatchObject({ id: walletId, accountId, address: ADDRESS_A })
      expect(await store.getWallet('wal_missing')).toBeNull()
    })
  })
})
