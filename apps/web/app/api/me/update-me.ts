import type { z } from 'zod'
import type { Database } from '@agent-desk/db'
import { patchMeRequest, toBaseUnits } from '@agent-desk/schemas'

/**
 * Story 3.2: the two settings a Builder owns — the Daily Fee Budget and the
 * Telegram chat id — behind `PATCH /api/me`.
 *
 * AD-13: the budget arrives as a decimal tUSD string and is stored in base
 * units, converted by the one helper in `packages/schemas` and nowhere else. A
 * null budget clears the column, which is what "restore the platform default"
 * means: AD-3 reads `platform_settings.default_daily_fee_budget` whenever
 * `accounts.daily_fee_budget` is null, so there is no default to copy in and
 * nothing to keep in step afterwards.
 *
 * AD-3: nothing here touches the spend. The window is a query over `calls`, and
 * changing the budget changes only the number it is compared against.
 */

/** `packages/schemas` exports the object but not its type; this is that type. */
export type PatchMeRequest = z.infer<typeof patchMeRequest>

/** The columns this patch may write, in the shape the update statement uses. */
export interface AccountPatch {
  /** Base units, or null to fall back to the platform default. */
  dailyFeeBudget?: string | null
  /** Digits, or null to unlink the chat. */
  telegramChatId?: string | null
}

export type ParsedPatch =
  | { ok: true; patch: AccountPatch }
  | { ok: false; message: string }

/**
 * `patchMeRequest` has already settled the shapes — a decimal budget, a chat id
 * of digits, either of them null, either of them absent. What is left is the
 * one rule a regex cannot express: tUSD has six decimals, so "0.0000001" is a
 * budget the token cannot represent, and it is a 400 rather than a rounding.
 */
export function parseMePatch(body: PatchMeRequest): ParsedPatch {
  const patch: AccountPatch = {}

  if (body.daily_fee_budget !== undefined) {
    if (body.daily_fee_budget === null) {
      patch.dailyFeeBudget = null
    } else {
      let base: bigint
      try {
        base = toBaseUnits(body.daily_fee_budget)
      } catch {
        return { ok: false, message: 'the Daily Fee Budget has more than six decimal places' }
      }
      patch.dailyFeeBudget = base.toString()
    }
  }

  if (body.telegram_chat_id !== undefined) {
    patch.telegramChatId = body.telegram_chat_id
  }

  return { ok: true, patch }
}

/** True when the patch would change nothing, so the route can skip the write. */
export function isEmptyPatch(patch: AccountPatch): boolean {
  return patch.dailyFeeBudget === undefined && patch.telegramChatId === undefined
}

/**
 * The update itself. `apps/web` depends on `@agent-desk/db` but not on
 * `drizzle-orm`, so there is no `eq` to build a `where` with; the statement goes
 * through the postgres-js client under Drizzle, where every value — including
 * the chat id a person typed — is a bound parameter and never string-pasted.
 */
export async function applyMePatch(
  db: Database,
  accountId: string,
  patch: AccountPatch,
): Promise<void> {
  if (isEmptyPatch(patch)) return

  const columns: Record<string, string | null> = {}
  if (patch.dailyFeeBudget !== undefined) columns.daily_fee_budget = patch.dailyFeeBudget
  if (patch.telegramChatId !== undefined) columns.telegram_chat_id = patch.telegramChatId

  const sql = db.$client
  await sql`update accounts set ${sql(columns)} where id = ${accountId}`
}
