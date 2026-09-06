import { db } from '@agent-desk/db'
import { patchMeRequest } from '@agent-desk/schemas'
import { readMe } from '../../../lib/accounts.ts'
import { jsonError, jsonOk, readBody } from '../../../lib/route.ts'
import { requireSession } from '../../../lib/session.ts'
import { applyMePatch, parseMePatch } from './update-me.ts'

/**
 * `GET /api/me` (Story 2.1). The Account's id, email, wallet address,
 * `is_operator`, `telegram_chat_id` and its Daily Fee Budget — budget, spend and
 * remaining, all base-unit strings (AD-13). The spend is the AD-3 query, run
 * fresh here, so `/api/me` and the signing policy can never disagree.
 *
 * `PATCH /api/me { daily_fee_budget?, telegram_chat_id? }` (Story 3.2) writes
 * the two settings a Builder owns and answers the same body, so `/settings`
 * shows the new budget and the remaining budget in one round trip.
 *
 * Neither verb ever returns a key: `readMe` selects the wallet's `address` and
 * `ready_at` and no other wallet column, and `encrypted_key` has no name in
 * `meResponse` to be carried under (AD-5).
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  const guard = await requireSession()
  if (!guard.ok) return guard.response

  const me = await readMe(db(), guard.session.account_id)
  if (!me) {
    // The cookie names an Account that is gone. Treat it as signed out rather
    // than as a server error; the client's next move is the sign-in page.
    return jsonError('unauthorized', 'sign in first')
  }
  return jsonOk(me, 200)
}

export async function PATCH(request: Request) {
  const guard = await requireSession()
  if (!guard.ok) return guard.response

  const body = await readBody(request, patchMeRequest)
  if (!body.ok) return body.response

  const parsed = parseMePatch(body.data)
  if (!parsed.ok) return jsonError('validation_failed', parsed.message)

  const database = db()
  await applyMePatch(database, guard.session.account_id, parsed.patch)

  // Read back rather than echo the patch: the row is the record, and the
  // remaining budget the page is about to show is derived from it (AD-3).
  const me = await readMe(database, guard.session.account_id)
  if (!me) return jsonError('unauthorized', 'sign in first')
  return jsonOk(me, 200)
}
