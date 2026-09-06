import { db } from '@agent-desk/db'
import { settlementsResponse } from '@agent-desk/schemas'
import { selectSettlements } from './query.ts'
import { parseFilterValue, parsePageSize, toSettlementsPage } from './settlements-page.ts'
import { jsonError, jsonOk } from '../../../lib/route.ts'
import { requireSession } from '../../../lib/session.ts'

/**
 * `GET /api/settlements?run_id=&listing_id=&cursor=` — the settlement view
 * (FR-41, Story 5.3, AD-9).
 *
 * `{ items, next }` over `settlements` joined to `calls`, `runs` and
 * `listings`, newest first. The scope is the session's own Runs and there is no
 * way to widen it: `account_id` comes from the iron-session cookie, never from
 * the query string, so `?run_id=` belonging to someone else matches nothing and
 * the route never confirms that the Run exists.
 *
 * The body is parsed against `settlementsResponse` before it is sent (AD-14),
 * so a shape the page's own parse would reject is a 500 here rather than a
 * broken screen there.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: Request) {
  const guard = await requireSession()
  if (!guard.ok) return guard.response

  const params = new URL(request.url).searchParams
  const limit = parsePageSize(params.get('limit'))

  const records = await selectSettlements(
    db(),
    {
      accountId: guard.session.account_id,
      runId: parseFilterValue(params.get('run_id')),
      listingId: parseFilterValue(params.get('listing_id')),
      cursor: parseFilterValue(params.get('cursor')),
    },
    limit,
  )

  const body = settlementsResponse.safeParse(toSettlementsPage(records, limit))
  if (!body.success) {
    return jsonError('internal_error', 'the settlements body did not match its schema', {
      issues: body.error.issues,
    })
  }

  return jsonOk(body.data)
}
