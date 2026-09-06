import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { compare } from 'bcryptjs'
import { accounts, createDb, wallets, type Database } from '@agent-desk/db'
import { newId, toBaseUnits } from '@agent-desk/schemas'
import { findAccountsForOperator, readMe, readOperatorAccount } from '../../../../lib/accounts.ts'
import { applyMePatch, parseMePatch } from '../../me/update-me.ts'
import { createAccount, type CreateAccountDeps, type JobConnection } from './create-account.ts'

/**
 * Stories 3.1 and 3.2 against real Postgres.
 *
 * The shapes and the conversions are unit-tested next door; what can only be
 * wrong in SQL is here — that sign-up inserts exactly one row, that
 * `wallet.create` is published in that same transaction and takes the row down
 * with it when it fails, that a taken address is a `conflict` and not a second
 * row, that `PATCH /api/me` stores base units, and that no read of an Account
 * can carry the wallet's encrypted key.
 *
 * The database is the one the other integration tests truncate, so this file
 * takes the same session advisory lock; the key has to stay equal to `LOCK_KEY`
 * in `scripts/src/test-db.ts` or the two will truncate each other's fixtures.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/agentdesk_story16'

const LOCK_KEY = 1_620_000_016

const PLATFORM_DEFAULT_BUDGET = '1000000'

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
    values (1, 'production', false, '1000', '${PLATFORM_DEFAULT_BUDGET}', '5000000')
    on conflict (id) do update set
      default_daily_fee_budget = '${PLATFORM_DEFAULT_BUDGET}',
      platform_account_id = null
  `)
}

/** Every published job, with the connection it was handed. */
const published: { accountId: string; sawItsOwnAccount: boolean }[] = []

function deps(overrides: Partial<CreateAccountDeps> = {}): CreateAccountDeps {
  return {
    db,
    publish: async (accountId: string, connection: JobConnection) => {
      // The whole point of the `db` handle pg-boss is given: if this sees the
      // row, the job insert and the account insert share one commit.
      const { rows } = await connection.executeSql(
        'select count(*)::int as count from accounts where id = $1',
        [accountId],
      )
      published.push({
        accountId,
        sawItsOwnAccount: (rows[0] as { count: number }).count === 1,
      })
    },
    ...overrides,
  }
}

async function countAccounts(): Promise<number> {
  return (await db.query.accounts.findMany({ columns: { id: true } })).length
}

beforeAll(async () => {
  if (HAVE_POSTGRES) await holder.execute(`select pg_advisory_lock(${LOCK_KEY})`)
})

afterAll(async () => {
  if (!HAVE_POSTGRES) return
  await holder.execute(`select pg_advisory_unlock(${LOCK_KEY})`)
})

beforeEach(async () => {
  if (!HAVE_POSTGRES) return
  published.length = 0
  await reset()
})

describe.skipIf(!HAVE_POSTGRES)('POST /api/auth/sign-up (Story 3.1)', () => {
  it('inserts exactly one Account and publishes wallet.create for it', async () => {
    const result = await createAccount(deps(), {
      email: 'new@agentdesk.local',
      password: 'agentdesk',
    })

    expect(result).toMatchObject({ ok: true })
    expect(await countAccounts()).toBe(1)

    const row = await db.query.accounts.findFirst()
    expect(row?.email).toBe('new@agentdesk.local')
    expect(row?.isOperator).toBe(false)
    expect(published).toHaveLength(1)
    expect(published[0]?.accountId).toBe(row?.id)
  })

  it('publishes inside the insert transaction', async () => {
    await createAccount(deps(), { email: 'atomic@agentdesk.local', password: 'agentdesk' })
    expect(published[0]?.sawItsOwnAccount).toBe(true)
  })

  it('leaves no Account behind when the publish fails', async () => {
    const failing = deps({
      publish: async () => {
        throw new Error('pg-boss is down')
      },
    })

    await expect(
      createAccount(failing, { email: 'orphan@agentdesk.local', password: 'agentdesk' }),
    ).rejects.toThrow('pg-boss is down')
    expect(await countAccounts()).toBe(0)
  })

  it('stores a bcrypt hash and never the password', async () => {
    await createAccount(deps(), { email: 'hashed@agentdesk.local', password: 'agentdesk' })

    const row = await db.query.accounts.findFirst()
    expect(row?.passwordHash).not.toBe('agentdesk')
    expect(row?.passwordHash.startsWith('$2')).toBe(true)
    expect(await compare('agentdesk', row?.passwordHash ?? '')).toBe(true)
    expect(await compare('wrong', row?.passwordHash ?? '')).toBe(false)
  })

  it('is one address however it is capitalised', async () => {
    const first = await createAccount(deps(), {
      email: 'Mixed@AgentDesk.Local',
      password: 'agentdesk',
    })
    expect(first).toMatchObject({ ok: true })
    expect((await db.query.accounts.findFirst())?.email).toBe('mixed@agentdesk.local')

    const second = await createAccount(deps(), {
      email: ' mixed@agentdesk.local ',
      password: 'another-one',
    })
    expect(second).toMatchObject({ ok: false, refusal: { code: 'conflict' } })
    expect(await countAccounts()).toBe(1)
    expect(published).toHaveLength(1)
  })

  it('refuses a taken address without publishing a second job', async () => {
    await createAccount(deps(), { email: 'taken@agentdesk.local', password: 'agentdesk' })
    const again = await createAccount(deps(), {
      email: 'taken@agentdesk.local',
      password: 'agentdesk',
    })

    expect(again).toEqual({
      ok: false,
      refusal: { code: 'conflict', message: 'email already registered' },
    })
    expect(await countAccounts()).toBe(1)
    expect(published).toHaveLength(1)
  })

  it('answers a body a brand-new Account can be shown with', async () => {
    const result = await createAccount(deps(), {
      email: 'fresh@agentdesk.local',
      password: 'agentdesk',
    })
    if (!result.ok) throw new Error('sign-up was refused')

    const me = await readMe(db, result.accountId)
    expect(me).toMatchObject({
      email: 'fresh@agentdesk.local',
      is_operator: false,
      // The worker has not run yet, which is exactly what `/settings` shows as
      // "wallet preparing" while it polls.
      wallet_address: null,
      wallet_ready_at: null,
      telegram_chat_id: null,
      daily_fee_budget: PLATFORM_DEFAULT_BUDGET,
      budget_spent: '0',
      budget_remaining: PLATFORM_DEFAULT_BUDGET,
    })
  })
})

describe.skipIf(!HAVE_POSTGRES)('no read of an Account carries a key (AD-1, AD-5)', () => {
  const FORBIDDEN = ['encrypted_key', 'encryptedKey', 'private_key', 'privateKey', 'key', 'secret']

  function assertNoKey(body: unknown): void {
    const json = JSON.stringify(body)
    for (const field of FORBIDDEN) {
      expect(json).not.toContain(`"${field}"`)
    }
    expect(json).not.toContain('gcm1.')
  }

  it('GET /api/me and the operator account views carry no key material', async () => {
    const result = await createAccount(deps(), {
      email: 'keyless@agentdesk.local',
      password: 'agentdesk',
    })
    if (!result.ok) throw new Error('sign-up was refused')

    // The wallet the worker would have written, encrypted key and all.
    await db.insert(wallets).values({
      id: newId('wallet'),
      accountId: result.accountId,
      address: `0x${'1'.repeat(40)}`,
      encryptedKey: 'gcm1.aaaa.bbbb.cccc',
      readyAt: new Date('2026-09-06T09:29:52.000Z'),
    })

    const me = await readMe(db, result.accountId)
    expect(me?.wallet_address).toBe(`0x${'1'.repeat(40)}`)
    assertNoKey(me)

    assertNoKey(await readOperatorAccount(db, result.accountId))
    assertNoKey(await findAccountsForOperator(db, 'keyless@agentdesk.local'))
  })
})

describe.skipIf(!HAVE_POSTGRES)('PATCH /api/me (Story 3.2)', () => {
  async function signUp(email: string): Promise<string> {
    const result = await createAccount(deps(), { email, password: 'agentdesk' })
    if (!result.ok) throw new Error(`sign-up was refused for ${email}`)
    return result.accountId
  }

  async function patch(accountId: string, body: Parameters<typeof parseMePatch>[0]) {
    const parsed = parseMePatch(body)
    if (!parsed.ok) throw new Error(parsed.message)
    await applyMePatch(db, accountId, parsed.patch)
    return readMe(db, accountId)
  }

  it('stores a decimal budget in base units and reports the remainder', async () => {
    const accountId = await signUp('budget@agentdesk.local')

    const me = await patch(accountId, { daily_fee_budget: '2.5' })
    expect(me).toMatchObject({
      daily_fee_budget: toBaseUnits('2.5').toString(),
      budget_spent: '0',
      budget_remaining: toBaseUnits('2.5').toString(),
    })

    const row = await db.query.accounts.findFirst({
      where: (table, { eq }) => eq(table.id, accountId),
      columns: { dailyFeeBudget: true },
    })
    expect(row?.dailyFeeBudget).toBe('2500000')
  })

  it('a null budget clears the column, so the platform default applies again', async () => {
    const accountId = await signUp('default@agentdesk.local')
    await patch(accountId, { daily_fee_budget: '9' })

    const me = await patch(accountId, { daily_fee_budget: null })
    expect(me?.daily_fee_budget).toBe(PLATFORM_DEFAULT_BUDGET)

    const row = await db.query.accounts.findFirst({
      where: (table, { eq }) => eq(table.id, accountId),
      columns: { dailyFeeBudget: true },
    })
    expect(row?.dailyFeeBudget).toBeNull()
  })

  it('stores the Telegram chat id and unlinks it again', async () => {
    const accountId = await signUp('chat@agentdesk.local')

    expect((await patch(accountId, { telegram_chat_id: '123456789' }))?.telegram_chat_id).toBe(
      '123456789',
    )
    expect((await patch(accountId, { telegram_chat_id: null }))?.telegram_chat_id).toBeNull()
  })

  it('writes only the field the body carried', async () => {
    const accountId = await signUp('partial@agentdesk.local')
    await patch(accountId, { daily_fee_budget: '3', telegram_chat_id: '42' })

    const me = await patch(accountId, { telegram_chat_id: '43' })
    expect(me).toMatchObject({
      daily_fee_budget: toBaseUnits('3').toString(),
      telegram_chat_id: '43',
    })
  })

  it('binds the chat id as a parameter, so a quote in it cannot be SQL', async () => {
    const accountId = await signUp('quoted@agentdesk.local')
    // `patchMeRequest` refuses this body long before the update; the assertion
    // is that the statement underneath is parameterised anyway, because the
    // update is one string away from being the app's only injection site.
    await applyMePatch(db, accountId, { telegramChatId: "1'); drop table accounts; --" })

    const row = await db.query.accounts.findFirst({
      where: (table, { eq }) => eq(table.id, accountId),
      columns: { telegramChatId: true },
    })
    expect(row?.telegramChatId).toBe("1'); drop table accounts; --")
    expect(await countAccounts()).toBe(1)
  })
})
