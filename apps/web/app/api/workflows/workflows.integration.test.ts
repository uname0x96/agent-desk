import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accounts,
  createDb,
  listings,
  runs,
  wallets,
  type Database,
} from '@agent-desk/db'
import {
  newId,
  toBaseUnits,
  workflowResponse,
  type AgentType,
  type SaveWorkflowRequest,
} from '@agent-desk/schemas'
import { CHAIN_RULES } from '@agent-desk/core/workflow'
import { findWorkflowOwner } from '../../../lib/session-store.ts'
import { selectWorkflowById, selectWorkflowsForAccount } from './query.ts'
import { saveWorkflowChain } from './save.ts'
import { toWorkflowsPage, workflowsResponse } from './workflows-view.ts'

/**
 * `POST /api/workflows`, `PUT /api/workflows/<id>` and `GET /api/workflows`
 * against real Postgres. The chain rules themselves are unit-tested in
 * `packages/core/src/workflow/validate.test.ts`; what can only be wrong in SQL
 * is here — that a refused chain writes nothing, that a replace really does
 * replace the Nodes rather than append to them, that `node_index` is dense and
 * ordered, and that the list is scoped to one Account and carries its last Run.
 *
 * The database is the one the other integration tests truncate, so this file
 * takes the same session advisory lock they do; the key has to stay equal to
 * `LOCK_KEY` in `app/api/runs/runs.integration.test.ts` and
 * `scripts/src/test-db.ts`.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/agentdesk_story16'

const LOCK_KEY = 1_620_000_016

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
}

let addressCounter = 0
function nextAddress(): string {
  addressCounter += 1
  return `0x${addressCounter.toString(16).padStart(40, '0')}`
}

/** The Seed Listings of Stories 1.10 and 2.3 to 2.6, at the PRD addendum §2 prices. */
const SEED_PRICES: [name: string, type: AgentType, price: string][] = [
  ['Binance Ticker', 'data', '0.01'],
  ['Alpha Research', 'research', '0.05'],
  ['Sloppy Research', 'research', '0.03'],
  ['Guardrail Risk', 'risk', '0.02'],
  ['Binance Spot Executor', 'execution', '0.01'],
  ['Telegram Notifier', 'notify', '0.005'],
]

interface Fixture {
  accountId: string
  /** Listing id by Provider name. */
  listing: Record<string, string>
}

async function fixture(): Promise<Fixture> {
  const accountId = newId('account')
  await db.insert(accounts).values({
    id: accountId,
    email: `${accountId}@test.local`,
    passwordHash: '!',
  })
  await db.insert(wallets).values({
    id: newId('wallet'),
    accountId,
    address: nextAddress(),
    encryptedKey: 'gcm1.a.b.c',
    readyAt: new Date(),
  })

  const listing: Record<string, string> = {}
  for (const [name, type, price] of SEED_PRICES) {
    const listingId = newId('listing')
    listing[name] = listingId
    await db.insert(listings).values({
      id: listingId,
      creatorAccountId: accountId,
      name,
      type,
      endpoint: 'https://agent.example/run',
      declaredPrice: toBaseUnits(price).toString(),
      declaredStake: toBaseUnits('0.30').toString(),
      payoutWallet: nextAddress(),
      status: 'active',
      price: toBaseUnits(price).toString(),
      stake: toBaseUnits('0.30').toString(),
    })
  }
  return { accountId, listing }
}

function goodChain(setup: Fixture): SaveWorkflowRequest {
  return {
    name: 'BNB momentum desk',
    symbol: 'BNBUSDT',
    order_cap_usdt: '10',
    nodes: [
      { type: 'data', listing_id: setup.listing['Binance Ticker']! },
      { type: 'research', listing_id: setup.listing['Alpha Research']! },
      { type: 'risk', listing_id: setup.listing['Guardrail Risk']! },
      { type: 'execution', listing_id: setup.listing['Binance Spot Executor']! },
      { type: 'notify', listing_id: setup.listing['Telegram Notifier']! },
    ],
  }
}

async function countWorkflows(): Promise<{ workflows: number; nodes: number }> {
  const [workflowRows, nodeRows] = await Promise.all([
    db.query.workflows.findMany({ columns: { id: true } }),
    db.query.workflowNodes.findMany({ columns: { nodeIndex: true } }),
  ])
  return { workflows: workflowRows.length, nodes: nodeRows.length }
}

beforeAll(async () => {
  if (HAVE_POSTGRES) await holder.execute(`select pg_advisory_lock(${LOCK_KEY})`)
})

afterAll(async () => {
  if (!HAVE_POSTGRES) return
  await reset()
  await holder.execute(`select pg_advisory_unlock(${LOCK_KEY})`)
})

describe.skipIf(!HAVE_POSTGRES)(`/api/workflows against ${TEST_DATABASE_URL}`, () => {
  beforeEach(async () => {
    await reset()
  })

  it('persists a valid chain and its Nodes in node_index order, owned by the session Account', async () => {
    const setup = await fixture()

    const result = await saveWorkflowChain(db, {
      accountId: setup.accountId,
      workflowId: null,
      request: goodChain(setup),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(workflowResponse.parse(result.body)).toEqual(result.body)
    expect(result.body.nodes.map((node) => node.node_index)).toEqual([0, 1, 2, 3, 4])
    expect(result.body.nodes.map((node) => node.type)).toEqual([
      'data',
      'research',
      'risk',
      'execution',
      'notify',
    ])
    expect(result.body.nodes.map((node) => node.provider)).toEqual([
      'Binance Ticker',
      'Alpha Research',
      'Guardrail Risk',
      'Binance Spot Executor',
      'Telegram Notifier',
    ])
    // AD-13: the column holds the Order Cap as a decimal, the API as base units.
    expect(result.body.order_cap_usdt).toBe(toBaseUnits('10').toString())
    const stored = await db.query.workflows.findFirst({
      where: (table, { eq }) => eq(table.id, result.body.id),
    })
    expect(stored?.orderCapUsdt).toBe('10')
    expect(stored?.accountId).toBe(setup.accountId)
    expect(await findWorkflowOwner(db, result.body.id)).toBe(setup.accountId)
  })

  it('refuses an invalid chain with violations and writes nothing at all', async () => {
    const setup = await fixture()

    const result = await saveWorkflowChain(db, {
      accountId: setup.accountId,
      workflowId: null,
      request: {
        ...goodChain(setup),
        nodes: [
          { type: 'data', listing_id: setup.listing['Binance Ticker']! },
          { type: 'execution', listing_id: setup.listing['Binance Spot Executor']! },
        ],
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations).toEqual([
      {
        node_index: 1,
        rule: CHAIN_RULES.executionRequiresRisk,
        message: 'an execution Node needs a risk Node earlier in the chain',
      },
    ])
    expect(await countWorkflows()).toEqual({ workflows: 0, nodes: 0 })
  })

  it('refuses a chain bound to a paused Listing, naming FR-8', async () => {
    const setup = await fixture()
    await db.execute(
      `update listings set status = 'paused' where id = '${setup.listing['Alpha Research']!}'`,
    )

    const result = await saveWorkflowChain(db, {
      accountId: setup.accountId,
      workflowId: null,
      request: {
        ...goodChain(setup),
        nodes: goodChain(setup).nodes.slice(0, 2),
        order_cap_usdt: null,
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations[0]!.rule).toBe(CHAIN_RULES.listingNotActive)
    expect(result.violations[0]!.message).toContain('FR-8')
    expect(await countWorkflows()).toEqual({ workflows: 0, nodes: 0 })
  })

  it('replaces the Nodes of an existing Workflow rather than appending to them', async () => {
    const setup = await fixture()
    const created = await saveWorkflowChain(db, {
      accountId: setup.accountId,
      workflowId: null,
      request: goodChain(setup),
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const replaced = await saveWorkflowChain(db, {
      accountId: setup.accountId,
      workflowId: created.body.id,
      request: {
        name: 'Sloppy desk',
        symbol: 'bnbusdt',
        order_cap_usdt: null,
        nodes: [
          { type: 'data', listing_id: setup.listing['Binance Ticker']! },
          { type: 'research', listing_id: setup.listing['Sloppy Research']! },
          { type: 'notify', listing_id: setup.listing['Telegram Notifier']! },
        ],
      },
    })
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) return

    expect(replaced.body.id).toBe(created.body.id)
    expect(replaced.body.name).toBe('Sloppy desk')
    // The route is the boundary: an agent parses `symbol` with `symbolSchema`.
    expect(replaced.body.symbol).toBe('BNBUSDT')
    expect(replaced.body.order_cap_usdt).toBeNull()
    expect(replaced.body.nodes.map((node) => node.provider)).toEqual([
      'Binance Ticker',
      'Sloppy Research',
      'Telegram Notifier',
    ])
    expect(await countWorkflows()).toEqual({ workflows: 1, nodes: 3 })
    expect(await findWorkflowOwner(db, created.body.id)).toBe(setup.accountId)
  })

  it('refuses a replacement that would make the chain invalid, leaving the saved chain intact', async () => {
    const setup = await fixture()
    const created = await saveWorkflowChain(db, {
      accountId: setup.accountId,
      workflowId: null,
      request: goodChain(setup),
    })
    if (!created.ok) throw new Error('the fixture chain should have saved')

    const refused = await saveWorkflowChain(db, {
      accountId: setup.accountId,
      workflowId: created.body.id,
      request: { ...goodChain(setup), order_cap_usdt: null },
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.violations.map((violation) => violation.rule)).toEqual([
      CHAIN_RULES.orderCapRequired,
    ])

    const unchanged = await selectWorkflowById(db, created.body.id)
    expect(unchanged?.nodes).toHaveLength(5)
    expect(unchanged?.orderCapUsdt).toBe('10')
  })

  it('lists only the session Account own Workflows, with node count and last Run status', async () => {
    const mine = await fixture()
    const theirs = await fixture()

    const first = await saveWorkflowChain(db, {
      accountId: mine.accountId,
      workflowId: null,
      request: goodChain(mine),
    })
    const second = await saveWorkflowChain(db, {
      accountId: mine.accountId,
      workflowId: null,
      request: {
        name: 'Ticker only',
        symbol: 'BNBUSDT',
        order_cap_usdt: null,
        nodes: [{ type: 'data', listing_id: mine.listing['Binance Ticker']! }],
      },
    })
    await saveWorkflowChain(db, {
      accountId: theirs.accountId,
      workflowId: null,
      request: goodChain(theirs),
    })
    if (!first.ok || !second.ok) throw new Error('the fixture chains should have saved')

    const wallet = await db.query.wallets.findFirst({
      where: (table, { eq }) => eq(table.accountId, mine.accountId),
      columns: { id: true },
    })
    await db.insert(runs).values({
      id: newId('run'),
      workflowId: first.body.id,
      accountId: mine.accountId,
      walletId: wallet!.id,
      status: 'completed, no order',
      priceLock: { nodes: [], total: '0', locked_at: new Date().toISOString() },
    })

    const rows = await selectWorkflowsForAccount(db, mine.accountId, 50, null)
    const page = toWorkflowsPage(rows, 50)
    expect(workflowsResponse.parse(page)).toEqual(page)
    expect(page.items).toHaveLength(2)

    const byId = new Map(page.items.map((item) => [item.id, item]))
    expect(byId.get(first.body.id)?.nodes).toHaveLength(5)
    expect(byId.get(first.body.id)?.last_run_status).toBe('completed, no order')
    expect(byId.get(second.body.id)?.nodes).toHaveLength(1)
    expect(byId.get(second.body.id)?.last_run_status).toBeNull()
  })

  it('keyset-paginates the list newest first', async () => {
    const setup = await fixture()
    for (const name of ['One', 'Two', 'Three']) {
      const saved = await saveWorkflowChain(db, {
        accountId: setup.accountId,
        workflowId: null,
        request: {
          name,
          symbol: 'BNBUSDT',
          order_cap_usdt: null,
          nodes: [{ type: 'data', listing_id: setup.listing['Binance Ticker']! }],
        },
      })
      expect(saved.ok).toBe(true)
    }

    const firstPage = toWorkflowsPage(
      await selectWorkflowsForAccount(db, setup.accountId, 2, null),
      2,
    )
    expect(firstPage.items.map((item) => item.name)).toEqual(['Three', 'Two'])
    expect(firstPage.next).not.toBeNull()

    const secondPage = toWorkflowsPage(
      await selectWorkflowsForAccount(db, setup.accountId, 2, firstPage.next),
      2,
    )
    expect(secondPage.items.map((item) => item.name)).toEqual(['One'])
    expect(secondPage.next).toBeNull()
  })
})
