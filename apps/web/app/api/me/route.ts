import { db } from '@agent-desk/db'
import { readMe } from '../../../lib/accounts.ts'
import { jsonError, jsonOk } from '../../../lib/route.ts'
import { requireSession } from '../../../lib/session.ts'

/**
 * `GET /api/me` (Story 2.1). The Account's id, email, wallet address,
 * `is_operator`, `telegram_chat_id` and its Daily Fee Budget — budget, spend and
 * remaining, all base-unit strings (AD-13). The spend is the AD-3 query, run
 * fresh here, so `/api/me` and the signing policy can never disagree.
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
