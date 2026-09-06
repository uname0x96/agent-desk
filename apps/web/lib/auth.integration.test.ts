import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hash } from 'bcryptjs'
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
import {
  findAccountsForOperator,
  readMe,
  readOperatorAccount,
  resetBudgetWindow,
  verifyCredentials,
} from './accounts.ts'
import {
  readPlatformSettings,
  toInternalSettings,
  toPublicSettings,
  updatePlatformSettings,
} from './settings.ts'
import { findWorkflowOwner } from './session-store.ts'

/**
 * Stories 2.1 and 2.2 against real Postgres. The access rules themselves are
 * unit-tested in `session-policy.test.ts`; what can only be wrong in SQL is
 * here — that a wrong pair is refused the same way a wrong email is, that
 * `/api/me` reports the AD-3 spend rather than a counter, that
 * `platform_settings` is read fresh after another connection changes it, and
 * that a budget reset moves the window rather than clearing anything.
 *
 * The database is the one the other integration tests truncate, so this file
 * takes the same session advisory lock; the key has to stay equal to `LOCK_KEY`
 * in `scripts/src/test-db.ts` or the two will truncate each other's fixtures.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/agentdesk_story16'

const LOCK_KEY = 1_620_000_016

/** The credentials `pnpm seed` writes; the fixtures below mirror them. */
const PASSWORD = 'agentdesk'
const BUILDER_EMAIL = 'builder@agentdesk.local'
const OPERATOR_EMAIL = 'platform@agentdesk.local'

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
      order_ceiling_usdt = '1000',
      default_daily_fee_budget = '1000000',
      verification_cap_daily = '5000000',
      platform_account_id = null
  `)
}

let addressCounter = 0
function nextAddress(): string {
  addressCounter += 1
  return `0x${addressCounter.toString(16).padStart(40, '0')}`
}

interface AccountFixture {
  accountId: string
  email: string
  walletAddress: string
}

async function account(
  options: {
    email?: string
    password?: string
    isOperator?: boolean
    dailyFeeBudget?: string | null
    telegramChatId?: string | null
    withWallet?: boolean
    budgetWindowStart?: Date
  } = {},
): Promise<AccountFixture> {
  const accountId = newId('account')
  const email = options.email ?? `${accountId.toLowerCase()}@test.local`
  const walletAddress = nextAddress()

  await db.insert(accounts).values({
    id: accountId,
    email,
    passwordHash: await hash(options.password ?? PASSWORD, 10),
    isOperator: options.isOperator ?? false,
    dailyFeeBudget: options.dailyFeeBudget ?? null,
    telegramChatId: options.telegramChatId ?? null,
    // The fixture clock is fixed at NOW, but the column defaults to the real
    // `now()`, and AD-3 takes the later of it and UTC midnight. The epoch
    // makes the window UTC midnight, so the spend query is not a function of
    // what time of day the suite runs.
    budgetWindowStart: options.budgetWindowStart ?? new Date(0),
  })
  if (options.withWallet !== false) {
    await db.insert(wallets).values({
      id: newId('wallet'),
      accountId,
      address: walletAddress,
      encryptedKey: 'gcm1.a.b.c',
      readyAt: NOW,
    })
  }
  return { accountId, email, walletAddress }
}

/** One `succeeded` Call, which is what AD-3 counts as Daily Fee Budget spend. */
async function spendOnce(accountId: string, at: Date = NOW): Promise<void> {
  const listingId = newId('listing')
  const workflowId = newId('workflow')
  const runId = newId('run')
  const wallet = await db.query.wallets.findFirst({
    where: (table, { eq }) => eq(table.accountId, accountId),
  })

  await db.insert(listings).values({
    id: listingId,
    creatorAccountId: accountId,
    name: 'Fixture',
    type: 'data',
    endpoint: 'https://agent.example/run',
    declaredPrice: PRICE,
    declaredStake: toBaseUnits('0.10').toString(),
    payoutWallet: nextAddress(),
    status: 'active',
    price: PRICE,
    stake: toBaseUnits('0.30').toString(),
  })
  await db.insert(workflows).values({ id: workflowId, accountId, name: 'Fixture', symbol: 'BNBUSDT' })
  await db.insert(workflowNodes).values({ workflowId, nodeIndex: 0, nodeType: 'data', listingId })
  await db.insert(runs).values({
    id: runId,
    workflowId,
    accountId,
    walletId: wallet!.id,
    status: 'completed',
    priceLock: {
      nodes: [
        {
          node_index: 0,
          node_type: 'data',
          listing_id: listingId,
          provider: 'Fixture',
          price: PRICE,
          asset: nextAddress(),
          network: 'eip155:97',
          pay_to: nextAddress(),
        },
      ],
      total: PRICE,
      locked_at: at.toISOString(),
    },
    createdAt: at,
    endedAt: at,
  })
  await db.insert(calls).values({
    id: newId('call'),
    runId,
    kind: 'run',
    listingId,
    nodeIndex: 0,
    nodeType: 'data',
    status: 'succeeded',
    lockedPrice: PRICE,
    lockedPayTo: nextAddress(),
    lockedAsset: nextAddress(),
    lockedNetwork: 'eip155:97',
    startedAt: at,
    endedAt: at,
  })
}

beforeAll(async () => {
  if (HAVE_POSTGRES) await holder.execute(`select pg_advisory_lock(${LOCK_KEY})`)
})

afterAll(async () => {
  if (!HAVE_POSTGRES) return
  await reset()
  await holder.execute(`select pg_advisory_unlock(${LOCK_KEY})`)
})

describe.skipIf(!HAVE_POSTGRES)(`auth and settings against ${TEST_DATABASE_URL}`, () => {
  beforeEach(reset)

  // ------------------------------------------------------------ Story 2.1

  describe('verifyCredentials', () => {
    it('accepts the seeded pair and carries is_operator into the session', async () => {
      const builder = await account({ email: BUILDER_EMAIL })
      const operator = await account({ email: OPERATOR_EMAIL, isOperator: true })

      expect(await verifyCredentials(db, BUILDER_EMAIL, PASSWORD)).toEqual({
        account_id: builder.accountId,
        is_operator: false,
      })
      expect(await verifyCredentials(db, OPERATOR_EMAIL, PASSWORD)).toEqual({
        account_id: operator.accountId,
        is_operator: true,
      })
    })

    it('refuses a wrong password and an unknown email identically', async () => {
      await account({ email: BUILDER_EMAIL })

      const wrongPassword = await verifyCredentials(db, BUILDER_EMAIL, 'not the password')
      const unknownEmail = await verifyCredentials(db, 'nobody@agentdesk.local', PASSWORD)

      // Same answer, so nothing downstream can tell which field failed.
      expect(wrongPassword).toBeNull()
      expect(unknownEmail).toBeNull()
    })

    it('ignores surrounding whitespace and the case of the typed email', async () => {
      const builder = await account({ email: BUILDER_EMAIL })
      expect(await verifyCredentials(db, `  ${BUILDER_EMAIL.toUpperCase()} `, PASSWORD)).toEqual({
        account_id: builder.accountId,
        is_operator: false,
      })
    })

    it('refuses an empty password against a real Account', async () => {
      await account({ email: BUILDER_EMAIL })
      expect(await verifyCredentials(db, BUILDER_EMAIL, '')).toBeNull()
    })
  })

  describe('readMe', () => {
    it('answers the Account, its wallet, and its budget in base units', async () => {
      const builder = await account({
        email: BUILDER_EMAIL,
        telegramChatId: '-1001234567890',
      })

      const me = await readMe(db, builder.accountId, NOW)

      expect(me).toEqual({
        account_id: builder.accountId,
        email: BUILDER_EMAIL,
        is_operator: false,
        wallet_address: builder.walletAddress,
        wallet_ready_at: NOW.toISOString(),
        telegram_chat_id: '-1001234567890',
        // No `accounts.daily_fee_budget`, so the platform default applies (AD-3).
        daily_fee_budget: '1000000',
        budget_spent: '0',
        budget_remaining: '1000000',
      })
    })

    it('subtracts the AD-3 spend from the remaining budget', async () => {
      const builder = await account({ dailyFeeBudget: toBaseUnits('0.05').toString() })
      await spendOnce(builder.accountId)

      const me = await readMe(db, builder.accountId, NOW)
      expect(me?.budget_spent).toBe(PRICE)
      expect(me?.budget_remaining).toBe(toBaseUnits('0.04').toString())
    })

    it('never reports a negative remaining budget', async () => {
      const builder = await account({ dailyFeeBudget: toBaseUnits('0.005').toString() })
      await spendOnce(builder.accountId)

      const me = await readMe(db, builder.accountId, NOW)
      expect(me?.budget_remaining).toBe('0')
    })

    it('answers null for an Account that is gone', async () => {
      expect(await readMe(db, newId('account'), NOW)).toBeNull()
    })

    it('reports a null wallet address before the wallet exists', async () => {
      const builder = await account({ withWallet: false })
      expect((await readMe(db, builder.accountId, NOW))?.wallet_address).toBeNull()
    })
  })

  describe('findWorkflowOwner', () => {
    it('names the owner, and answers null for an unknown Workflow', async () => {
      const builder = await account()
      const workflowId = newId('workflow')
      await db.insert(workflows).values({
        id: workflowId,
        accountId: builder.accountId,
        name: 'Fixture',
        symbol: 'BNBUSDT',
      })

      expect(await findWorkflowOwner(db, workflowId)).toBe(builder.accountId)
      expect(await findWorkflowOwner(db, newId('workflow'))).toBeNull()
    })
  })

  // ------------------------------------------------------------ Story 2.2

  describe('platform_settings', () => {
    it('reads the row fresh, so a change made elsewhere is visible at once', async () => {
      expect((await readPlatformSettings(db)).mode).toBe('production')

      // Another connection, exactly as the Operator page's request would be.
      const other = createDb({ url: TEST_DATABASE_URL, max: 1 })
      await other.execute(`update platform_settings set mode = 'demo', emergency_stop = true`)

      const row = await readPlatformSettings(db)
      expect(toPublicSettings(row)).toEqual({ mode: 'demo', emergency_stop: true })
    })

    it('projects the public and internal bodies from the same row', async () => {
      const row = await readPlatformSettings(db)
      expect(toPublicSettings(row)).toEqual({ mode: 'production', emergency_stop: false })
      expect(toInternalSettings(row)).toEqual({
        emergency_stop: false,
        order_ceiling_usdt: '1000',
      })
    })

    it('persists emergency_stop, mode, and the order ceiling', async () => {
      const updated = await updatePlatformSettings(db, {
        emergencyStop: true,
        mode: 'demo',
        orderCeilingUsdt: '250.5',
      })

      expect(toPublicSettings(updated)).toEqual({ mode: 'demo', emergency_stop: true })
      expect(toInternalSettings(await readPlatformSettings(db))).toEqual({
        emergency_stop: true,
        order_ceiling_usdt: '250.5',
      })
    })

    it('changes only what the patch names', async () => {
      await updatePlatformSettings(db, { mode: 'demo' })
      const row = await updatePlatformSettings(db, { emergencyStop: true })
      expect(row.mode).toBe('demo')
      expect(row.emergencyStop).toBe(true)
      expect(row.orderCeilingUsdt).toBe('1000')
    })
  })

  describe('operator account lookup', () => {
    it('resolves a typed email to an id, whatever its case', async () => {
      const builder = await account({ email: BUILDER_EMAIL })
      await account({ email: OPERATOR_EMAIL, isOperator: true })

      const found = await findAccountsForOperator(db, BUILDER_EMAIL.toUpperCase(), 50, NOW)
      expect(found.map((view) => view.account_id)).toEqual([builder.accountId])
      expect(found[0]).toMatchObject({
        email: BUILDER_EMAIL,
        wallet_address: builder.walletAddress,
        daily_fee_budget: '1000000',
        budget_spent: '0',
      })
    })

    it('answers an empty list for an unknown email, not an error', async () => {
      await account({ email: BUILDER_EMAIL })
      expect(await findAccountsForOperator(db, 'nobody@agentdesk.local', 50, NOW)).toEqual([])
    })

    it('does not treat an email as a LIKE pattern', async () => {
      await account({ email: BUILDER_EMAIL })
      expect(await findAccountsForOperator(db, '%@agentdesk.local', 50, NOW)).toEqual([])
    })

    it('lists every Account when no email is given', async () => {
      await account({ email: BUILDER_EMAIL })
      await account({ email: OPERATOR_EMAIL, isOperator: true })
      expect(await findAccountsForOperator(db, null, 50, NOW)).toHaveLength(2)
    })
  })

  describe('resetBudgetWindow', () => {
    it('moves the window to now, so the spend before it stops counting', async () => {
      // Real clock, because the reset writes `now()` in the database.
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      const builder = await account({ budgetWindowStart: twoHoursAgo })
      await spendOnce(builder.accountId, oneHourAgo)

      const before = await readOperatorAccount(db, builder.accountId, new Date())
      expect(before?.budget_spent).toBe(PRICE)

      expect(await resetBudgetWindow(db, builder.accountId)).toBe(true)

      // AD-3: the window is the later of UTC midnight and budget_window_start,
      // and the reset moved the column past the Call, so the query is now zero.
      const after = await readOperatorAccount(db, builder.accountId, new Date())
      expect(after?.budget_spent).toBe('0')

      const row = await db.query.accounts.findFirst({
        where: (table, { eq }) => eq(table.id, builder.accountId),
      })
      expect(row?.budgetWindowStart.getTime()).toBeGreaterThan(oneHourAgo.getTime())
    })

    it('refuses an unknown id and a malformed one without writing', async () => {
      expect(await resetBudgetWindow(db, newId('account'))).toBe(false)
      expect(await resetBudgetWindow(db, "acc_'; drop table accounts; --")).toBe(false)
      expect(await db.query.accounts.findMany({ columns: { id: true } })).toEqual([])
    })
  })
})
