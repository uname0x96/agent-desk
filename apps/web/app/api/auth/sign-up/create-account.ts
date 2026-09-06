import { hash } from 'bcryptjs'
import type { Database } from '@agent-desk/db'
import { newId, type ErrorCode } from '@agent-desk/schemas'

/**
 * Story 3.1 / FR-1 / AD-5: `POST /api/auth/sign-up` inserts exactly one
 * `accounts` row and publishes `wallet.create { account_id }` **in the same
 * transaction**, so an Account can never exist without the job that gives it a
 * System Wallet, and a failed publish leaves no half-signed-up person behind.
 *
 * AD-1: nothing here generates or touches a key. The web app inserts the row
 * and enqueues the work; the worker's signer creates and encrypts the private
 * key and sets `wallets.ready_at` from the approve receipt.
 *
 * The transaction is opened on the postgres-js client under Drizzle rather than
 * through `db.transaction`, because pg-boss has to enlist in it: `boss.send`
 * takes a `db` whose `executeSql(text, values)` runs the insert, and Drizzle's
 * transaction handle cannot run a parameterised statement it did not build
 * (`apps/web` depends on `@agent-desk/db` but not on `drizzle-orm`, so there is
 * no `sql` template here). One handle, two statements, one commit.
 */

/** What pg-boss needs of a connection so `send` can join a transaction. */
export interface JobConnection {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}

export interface Refusal {
  code: ErrorCode
  message: string
}

export const EMAIL_TAKEN: Refusal = { code: 'conflict', message: 'email already registered' }

/** The cost the seed's hashes use; a sign-up must not be cheaper to crack. */
export const BCRYPT_ROUNDS = 10

export interface CreateAccountDeps {
  db: Database
  /**
   * `boss.send('wallet.create', { account_id }, { singletonKey: account_id, db })`.
   * The connection is the open transaction, and it is the caller's only way in:
   * a publish that ignores it publishes outside the guarantee above.
   */
  publish(accountId: string, connection: JobConnection): Promise<void>
  newAccountId?: () => string
  hashPassword?: (password: string) => Promise<string>
}

export type CreateAccountResult =
  | { ok: true; accountId: string }
  | { ok: false; refusal: Refusal }

/**
 * postgres-js surfaces a unique violation as SQLSTATE 23505; Drizzle wraps it,
 * so the `cause` chain is walked rather than the top-level error read (the same
 * reasoning as `app/api/runs/create-run.ts`).
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === '23505') return true
  }
  return false
}

export async function createAccount(
  deps: CreateAccountDeps,
  request: { email: string; password: string },
): Promise<CreateAccountResult> {
  const accountId = deps.newAccountId?.() ?? newId('account')
  // One spelling of an address, so `accounts_email_key` refuses the same person
  // twice however they capitalise it.
  const email = request.email.trim().toLowerCase()
  const passwordHash = await (deps.hashPassword ?? defaultHash)(request.password)

  try {
    await deps.db.$client.begin(async (tx) => {
      // `is_operator` is written false rather than left to the column default:
      // sign-up is the one place a person could otherwise be handed the
      // Operator page, and that must be impossible to do by omission.
      await tx`
        insert into accounts (id, email, password_hash, is_operator)
        values (${accountId}, ${email}, ${passwordHash}, false)
      `
      await deps.publish(accountId, {
        executeSql: async (text, values = []) => ({
          rows: [...(await tx.unsafe(text, values as never[]))],
        }),
      })
    })
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, refusal: EMAIL_TAKEN }
    throw error
  }

  return { ok: true, accountId }
}

function defaultHash(password: string): Promise<string> {
  return hash(password, BCRYPT_ROUNDS)
}
