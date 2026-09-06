import { compare } from 'bcryptjs'
import { dailyFeeSpendForAccount, type Database } from '@agent-desk/db'
import { meResponse, operatorAccountView, type MeResponse } from '@agent-desk/schemas'
import { readPlatformSettings } from './settings.ts'

/**
 * The account reads and writes behind `/api/auth/*`, `/api/me` and
 * `/api/operator/accounts*`. The route handlers own HTTP; everything that needs
 * a database, a hash comparison or an AD-3 derived amount lives here, so it can
 * be tested against real Postgres without a request.
 */

/**
 * A bcrypt hash of a value nobody knows, compared against when the email does
 * not exist. Story 2.1: a wrong pair answers 401 "without revealing which field
 * failed" — a missing account must therefore cost the same ~60 ms of bcrypt as
 * a wrong password, or the response time answers the question the body refuses
 * to. Cost 10, the same as the seed's hashes.
 */
const ABSENT_ACCOUNT_HASH = '$2b$10$JcZFlBqXJHc1E0vbRkyROeDt7Lh2lby2KR1WXGtgz1JfbiqHfwYIq'

export interface AccountIdentity {
  account_id: string
  is_operator: boolean
}

/**
 * The single decision behind `POST /api/auth/sign-in`. It returns null for a
 * wrong email and for a wrong password alike, and it never says which.
 */
export async function verifyCredentials(
  db: Database,
  email: string,
  password: string,
): Promise<AccountIdentity | null> {
  const account = await db.query.accounts.findFirst({
    where: (table, { eq }) => eq(table.email, email.trim().toLowerCase()),
    columns: { id: true, passwordHash: true, isOperator: true },
  })

  const matches = await compare(password, account?.passwordHash ?? ABSENT_ACCOUNT_HASH)
  if (!account || !matches) return null

  return { account_id: account.id, is_operator: account.isOperator }
}

/**
 * `GET /api/me`. The Daily Fee Budget is the account's own value, else the
 * platform default from `platform_settings` (AD-3), and the spend is the AD-3
 * query in `packages/db` — never a counter kept here.
 */
export async function readMe(
  db: Database,
  accountId: string,
  now: Date = new Date(),
): Promise<MeResponse | null> {
  const account = await db.query.accounts.findFirst({
    where: (table, { eq }) => eq(table.id, accountId),
    columns: { id: true, email: true, isOperator: true, telegramChatId: true, dailyFeeBudget: true },
  })
  if (!account) return null

  const [wallet, settings, spent] = await Promise.all([
    findWallet(db, accountId),
    readPlatformSettings(db),
    dailyFeeSpendForAccount(db, accountId, now),
  ])

  const budget = BigInt(account.dailyFeeBudget ?? settings.defaultDailyFeeBudget)

  return meResponse.parse({
    account_id: account.id,
    email: account.email,
    is_operator: account.isOperator,
    wallet_address: wallet?.address ?? null,
    wallet_ready_at: wallet?.readyAt?.toISOString() ?? null,
    telegram_chat_id: account.telegramChatId,
    daily_fee_budget: budget.toString(),
    budget_spent: spent.toString(),
    budget_remaining: remainingBudget(budget, spent).toString(),
  })
}

/** Never negative: a budget already overspent has nothing left, not a debt. */
export function remainingBudget(budget: bigint, spent: bigint): bigint {
  const remaining = budget - spent
  return remaining > 0n ? remaining : 0n
}

async function findWallet(db: Database, accountId: string) {
  return db.query.wallets.findFirst({
    where: (table, { eq }) => eq(table.accountId, accountId),
    orderBy: (table, { asc }) => [asc(table.createdAt)],
    columns: { address: true, readyAt: true },
  })
}

// -------------------------------------------------------- operator lookups

export type OperatorAccountView = ReturnType<typeof operatorAccountView.parse>

/**
 * `GET /api/operator/accounts?email=`. The Operator page types an email and
 * needs the id before it can call reset-budget, so an exact, case-insensitive
 * match is the whole query; an unknown email answers an empty list and the page
 * says "no such account".
 */
export async function findAccountsForOperator(
  db: Database,
  email: string | null,
  limit = 50,
  now: Date = new Date(),
): Promise<OperatorAccountView[]> {
  const needle = email?.trim() ?? ''
  const rows = await db.query.accounts.findMany({
    where:
      needle.length === 0
        ? undefined
        : // `ilike` with every wildcard escaped is a case-insensitive equality,
          // which is what "resolve the typed email to an id" means.
          (table, { ilike }) => ilike(table.email, escapeLike(needle)),
    orderBy: (table, { asc }) => [asc(table.email)],
    columns: { id: true, email: true, dailyFeeBudget: true },
    limit,
  })

  const fallbackBudget = (await readPlatformSettings(db)).defaultDailyFeeBudget
  return Promise.all(rows.map((row) => toOperatorView(db, row, fallbackBudget, now)))
}

/** The same view for one Account, after a budget reset has moved its window. */
export async function readOperatorAccount(
  db: Database,
  accountId: string,
  now: Date = new Date(),
): Promise<OperatorAccountView | null> {
  const row = await db.query.accounts.findFirst({
    where: (table, { eq }) => eq(table.id, accountId),
    columns: { id: true, email: true, dailyFeeBudget: true },
  })
  if (!row) return null
  const fallbackBudget = (await readPlatformSettings(db)).defaultDailyFeeBudget
  return toOperatorView(db, row, fallbackBudget, now)
}

async function toOperatorView(
  db: Database,
  row: { id: string; email: string; dailyFeeBudget: string | null },
  fallbackBudget: string,
  now: Date,
): Promise<OperatorAccountView> {
  const [wallet, spent] = await Promise.all([
    findWallet(db, row.id),
    dailyFeeSpendForAccount(db, row.id, now),
  ])
  return operatorAccountView.parse({
    account_id: row.id,
    email: row.email,
    wallet_address: wallet?.address ?? null,
    daily_fee_budget: row.dailyFeeBudget ?? fallbackBudget,
    budget_spent: spent.toString(),
  })
}

/** `%`, `_` and `\` are `LIKE` metacharacters; an email is matched literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

/** AD-13: `acc_` and 26 Crockford base-32 characters, and nothing else, ever. */
const ACCOUNT_ID = /^acc_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

export function isAccountId(value: string): boolean {
  return ACCOUNT_ID.test(value)
}

/**
 * `POST /api/operator/accounts/<id>/reset-budget`. AD-3: the Daily Fee Budget
 * window starts at the later of UTC midnight and `accounts.budget_window_start`,
 * so moving that column to now is the whole reset — no counter is cleared,
 * because there is no counter.
 *
 * `apps/web` does not depend on `drizzle-orm`, so there is no `eq` to build a
 * `where` with; the statement is issued directly, exactly as `lockAccountRow` in
 * `app/api/runs/create-run.ts` does, and the only value in it is asserted to be
 * a type-prefixed ULID first, so the string can hold nothing but `[0-9A-Z_]`.
 */
export async function resetBudgetWindow(db: Database, accountId: string): Promise<boolean> {
  if (!isAccountId(accountId)) return false
  const exists = await db.query.accounts.findFirst({
    where: (table, { eq }) => eq(table.id, accountId),
    columns: { id: true },
  })
  if (!exists) return false
  await db.execute(`update accounts set budget_window_start = now() where id = '${accountId}'`)
  return true
}
