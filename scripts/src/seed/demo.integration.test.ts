import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import {
  accounts,
  listings,
  platformSettings,
  runs,
  wallets,
  workflowNodes,
  workflows,
  type Database,
} from '@agent-desk/db'
import { newId, toBaseUnits, type PriceLock } from '@agent-desk/schemas'
import { TEST_DATABASE_URL, databaseLock, databaseReachable, resetDatabase, testDb } from '../test-db.ts'
import { SEED_AGENTS, seedAgent } from './agents.ts'
import {
  applySpareSwap,
  chainNodes,
  ensureDemoMode,
  ensureDemoWorkflows,
  ensureTelegramChatId,
  readWorkflowOwners,
} from './demo.ts'
import {
  SEED_CHAINS,
  SEED_DEMO_ACCOUNTS,
  SEED_DEMO_BUILDER,
  SEED_DEMO_DAILY_FEE_BUDGET,
  SEED_DEMO_WORKFLOW_IDS,
  SEED_GOOD_CHAIN,
  SEED_SLOPPY_CHAIN,
  SEED_SPARE_BUILDER,
  SEED_WORKFLOW,
} from './fixtures.ts'
import { planSpareSwap } from './spare.ts'

/**
 * The parts of Story 2.10 that can only be wrong in SQL: the AD-10 single-row
 * mode switch, the two demo Workflows and their Nodes, and the spare swap.
 *
 * The decisions themselves — which Nodes, which pair, which prices — are unit
 * tested in `demo.test.ts`, `spare.test.ts` and `agents.test.ts`. What is left
 * is the promise the story makes about state rather than about a value: running
 * `pnpm seed` twice leaves the same rows, and a `--activate-spare` survives the
 * next seed. Neither is provable without a real `on conflict`.
 *
 * `ensureDemoAccounts` is not here: its only non-trivial half is
 * `runWalletCreate`, which mints and approves on chain, and Story 1.10 already
 * covers that seam. The account columns it writes are asserted through the
 * fixtures it inserts below.
 */

const HAVE_POSTGRES = await databaseReachable()
const db: Database = testDb()
const lock = databaseLock()

const lines: string[] = []
const log = (line: string): void => {
  lines.push(line)
}

const PRICE_LOCK: PriceLock = {
  nodes: [],
  total: '0',
  locked_at: '2026-09-06T12:00:00.000',
}

/**
 * The six demo Accounts, the six Seed Listings the Nodes point at, and Story
 * 1.10's one-node Workflow — everything `ensureDemoWorkflows` and the spare
 * swap need, without the chain.
 *
 * `budgetWindowStart` is pinned to the epoch on purpose: the column defaults to
 * `now()`, and the AD-3 budget window is "since `budget_window_start`", so a row
 * created mid-test would put a fixed fixture clock outside its own window.
 */
async function seedFixtures(): Promise<void> {
  for (const account of SEED_DEMO_ACCOUNTS) {
    await db.insert(accounts).values({
      id: account.accountId,
      email: account.email,
      passwordHash: account.passwordHash,
      dailyFeeBudget: SEED_DEMO_DAILY_FEE_BUDGET,
      budgetWindowStart: new Date(0),
    })
  }

  for (const agent of SEED_AGENTS) {
    await db.insert(listings).values({
      id: agent.listingId,
      creatorAccountId: SEED_DEMO_BUILDER.accountId,
      name: agent.name,
      type: agent.type,
      endpoint: `http://localhost:${agent.port}`,
      declaredPrice: toBaseUnits(agent.priceUsdt).toString(),
      declaredStake: toBaseUnits(agent.stakeUsdt).toString(),
      payoutWallet: '0x00000000000000000000000000000000000000aa',
      status: 'active',
      price: toBaseUnits(agent.priceUsdt).toString(),
      stake: toBaseUnits(agent.stakeUsdt).toString(),
    })
  }

  await db.insert(workflows).values({
    id: SEED_WORKFLOW.workflowId,
    accountId: SEED_DEMO_BUILDER.accountId,
    name: SEED_WORKFLOW.name,
    symbol: SEED_WORKFLOW.symbol,
  })
}

async function nodeRows(workflowId: string) {
  return db
    .select({
      nodeIndex: workflowNodes.nodeIndex,
      nodeType: workflowNodes.nodeType,
      listingId: workflowNodes.listingId,
    })
    .from(workflowNodes)
    .where(eq(workflowNodes.workflowId, workflowId))
    .orderBy(workflowNodes.nodeIndex)
}

async function ownerOf(workflowId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ accountId: workflows.accountId })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .limit(1)
  return row?.accountId
}

describe.skipIf(!HAVE_POSTGRES)(`the demo seed against ${TEST_DATABASE_URL}`, () => {
  beforeAll(async () => {
    await lock.acquire()
  })
  afterAll(async () => {
    await lock.release()
  })
  beforeEach(async () => {
    await resetDatabase(db)
    await seedFixtures()
    lines.length = 0
  })

  describe('ensureDemoMode', () => {
    it('switches the AD-10 single row to demo and says what it was', async () => {
      await ensureDemoMode(db, log)

      const [row] = await db.select().from(platformSettings)
      expect(row?.id).toBe(1)
      expect(row?.mode).toBe('demo')
      expect(lines.join('\n')).toContain('was production')
    })

    it('is a no-op the second time, and never inserts a second row', async () => {
      await ensureDemoMode(db, log)
      lines.length = 0
      await ensureDemoMode(db, log)

      expect(lines.join('\n')).toContain('already set')
      expect(await db.select().from(platformSettings)).toHaveLength(1)
    })
  })

  describe('ensureDemoWorkflows', () => {
    it('writes both chains with five Nodes each, in FR-17 order', async () => {
      await ensureDemoWorkflows(db, SEED_DEMO_BUILDER.accountId, log)

      for (const chain of SEED_CHAINS) {
        const nodes = await nodeRows(chain.workflowId)
        expect(nodes.map((node) => node.nodeIndex)).toEqual([0, 1, 2, 3, 4])
        expect(nodes.map((node) => node.nodeType)).toEqual([
          'data',
          'research',
          'risk',
          'execution',
          'notify',
        ])
        expect(nodes.map((node) => node.listingId)).toEqual(
          chainNodes(chain).map((key) => seedAgent(key).listingId),
        )
      }
    })

    it('gives the good chain Alpha Research and the sloppy chain Sloppy Research', async () => {
      await ensureDemoWorkflows(db, SEED_DEMO_BUILDER.accountId, log)

      const good = await nodeRows(SEED_GOOD_CHAIN.workflowId)
      const sloppy = await nodeRows(SEED_SLOPPY_CHAIN.workflowId)
      expect(good[1]?.listingId).toBe(seedAgent('alpha-research').listingId)
      expect(sloppy[1]?.listingId).toBe(seedAgent('sloppy-research').listingId)
    })

    it('carries the FR-4 Order Cap of 10 USDT onto both chains', async () => {
      await ensureDemoWorkflows(db, SEED_DEMO_BUILDER.accountId, log)

      const rows = await db
        .select({ id: workflows.id, orderCapUsdt: workflows.orderCapUsdt })
        .from(workflows)
        .where(inArray(workflows.id, SEED_CHAINS.map((chain) => chain.workflowId)))
      expect(rows).toHaveLength(2)
      for (const row of rows) expect(row.orderCapUsdt).toBe('10')
    })

    it('is idempotent: seeding twice leaves two Workflows and ten Nodes', async () => {
      await ensureDemoWorkflows(db, SEED_DEMO_BUILDER.accountId, log)
      const before = await db.select().from(workflowNodes).orderBy(workflowNodes.workflowId)

      await ensureDemoWorkflows(db, SEED_DEMO_BUILDER.accountId, log)
      const after = await db.select().from(workflowNodes).orderBy(workflowNodes.workflowId)

      expect(after).toEqual(before)
      expect(after).toHaveLength(10)
    })

    it('repairs a Node whose Provider was changed by hand', async () => {
      await ensureDemoWorkflows(db, SEED_DEMO_BUILDER.accountId, log)
      await db
        .update(workflowNodes)
        .set({ listingId: seedAgent('sloppy-research').listingId })
        .where(
          and(
            eq(workflowNodes.workflowId, SEED_GOOD_CHAIN.workflowId),
            eq(workflowNodes.nodeIndex, 1),
          ),
        )

      await ensureDemoWorkflows(db, SEED_DEMO_BUILDER.accountId, log)

      const nodes = await nodeRows(SEED_GOOD_CHAIN.workflowId)
      expect(nodes[1]?.listingId).toBe(seedAgent('alpha-research').listingId)
    })
  })

  describe('the spare swap', () => {
    it('moves every demo Workflow to the spare Builder and back', async () => {
      await ensureDemoWorkflows(db, SEED_DEMO_BUILDER.accountId, log)

      await applySpareSwap(db, planSpareSwap(true, await readWorkflowOwners(db)))
      for (const id of SEED_DEMO_WORKFLOW_IDS) {
        expect(await ownerOf(id)).toBe(SEED_SPARE_BUILDER.accountId)
      }

      await applySpareSwap(db, planSpareSwap(false, await readWorkflowOwners(db)))
      for (const id of SEED_DEMO_WORKFLOW_IDS) {
        expect(await ownerOf(id)).toBe(SEED_DEMO_BUILDER.accountId)
      }
    })

    it('survives the next seed, which is the whole point of not upserting account_id', async () => {
      await ensureDemoWorkflows(db, SEED_DEMO_BUILDER.accountId, log)
      await applySpareSwap(db, planSpareSwap(true, await readWorkflowOwners(db)))

      // A plain `pnpm seed` after `pnpm seed --activate-spare`.
      await ensureDemoWorkflows(db, SEED_SPARE_BUILDER.accountId, log)

      expect(await ownerOf(SEED_GOOD_CHAIN.workflowId)).toBe(SEED_SPARE_BUILDER.accountId)
      expect(await ownerOf(SEED_SLOPPY_CHAIN.workflowId)).toBe(SEED_SPARE_BUILDER.accountId)
    })

    it('is idempotent: the second --activate-spare has nothing to move', async () => {
      await ensureDemoWorkflows(db, SEED_DEMO_BUILDER.accountId, log)
      await applySpareSwap(db, planSpareSwap(true, await readWorkflowOwners(db)))

      const second = planSpareSwap(true, await readWorkflowOwners(db))
      expect(second.moves).toEqual([])
      expect(second.settled).toBe(true)
    })

    it('reads a Workflow the seed has not written yet as missing, not as a move', async () => {
      const plan = planSpareSwap(true, await readWorkflowOwners(db))

      expect(plan.missing).toEqual([SEED_GOOD_CHAIN.workflowId, SEED_SLOPPY_CHAIN.workflowId])
      expect(plan.moves.map((move) => move.workflowId)).toEqual([SEED_WORKFLOW.workflowId])
    })

    it('sees a live Run and warns that the Run keeps paying the old Builder', async () => {
      await ensureDemoWorkflows(db, SEED_DEMO_BUILDER.accountId, log)
      const walletId = newId('wallet')
      await db.insert(wallets).values({
        id: walletId,
        accountId: SEED_DEMO_BUILDER.accountId,
        address: '0x00000000000000000000000000000000000000bb',
        encryptedKey: 'gcm1.a.b.c',
      })
      await db.insert(runs).values({
        id: newId('run'),
        workflowId: SEED_GOOD_CHAIN.workflowId,
        accountId: SEED_DEMO_BUILDER.accountId,
        walletId,
        status: 'running',
        priceLock: PRICE_LOCK,
      })

      const plan = planSpareSwap(true, await readWorkflowOwners(db))

      expect(plan.warnings).toHaveLength(1)
      expect(plan.warnings[0]).toContain(SEED_GOOD_CHAIN.workflowId)
      expect(plan.moves).toHaveLength(SEED_DEMO_WORKFLOW_IDS.length)
    })
  })

  describe('ensureTelegramChatId', () => {
    it('sets the chat id on the demo Builder, then reports it as already set', async () => {
      expect(await ensureTelegramChatId(db, SEED_DEMO_BUILDER.accountId, '-1001234567890', log)).toBe(
        'set',
      )
      expect(await ensureTelegramChatId(db, SEED_DEMO_BUILDER.accountId, '-1001234567890', log)).toBe(
        'already set',
      )

      const [row] = await db
        .select({ telegramChatId: accounts.telegramChatId })
        .from(accounts)
        .where(eq(accounts.id, SEED_DEMO_BUILDER.accountId))
      expect(row?.telegramChatId).toBe('-1001234567890')
    })

    it('leaves the column null and says why when the variable is absent', async () => {
      expect(await ensureTelegramChatId(db, SEED_DEMO_BUILDER.accountId, null, log)).toBe('absent')

      const [row] = await db
        .select({ telegramChatId: accounts.telegramChatId })
        .from(accounts)
        .where(eq(accounts.id, SEED_DEMO_BUILDER.accountId))
      expect(row?.telegramChatId).toBeNull()
      expect(lines.join('\n')).toContain('SEED_TELEGRAM_CHAT_ID')
    })
  })

  describe('the demo Accounts the fixtures stand in for', () => {
    it('carry the addendum §6 budget of 100 tUSD in base units', async () => {
      const rows = await db
        .select({ id: accounts.id, dailyFeeBudget: accounts.dailyFeeBudget })
        .from(accounts)
        .where(inArray(accounts.id, SEED_DEMO_ACCOUNTS.map((account) => account.accountId)))

      expect(rows).toHaveLength(6)
      for (const row of rows) expect(row.dailyFeeBudget).toBe('100000000')
    })
  })
})
