import { db } from '@agent-desk/db'
import { paymentsResponse } from '@agent-desk/schemas'
import { parsePaymentsQuery, toPaymentsPage } from './payments-model.ts'
import { selectAccountRunIds, selectPaymentRows } from './query.ts'
import { jsonError, jsonOk } from '../../../lib/route.ts'
import { requireSession } from '../../../lib/session.ts'

/**
 * `GET /api/payments?run_id=&cursor=&limit=` — the payments view (FR-40,
 * Story 5.2).
 *
 * Answers `{ items, next }` over `calls` joined to `runs`, `listings` and
 * `wallets` for the signed-in account's Runs, amounts as base-unit strings and
 * addresses lower-case (AD-13). The body is parsed against `paymentsResponse`
 * before it is sent, so this route can never ship a shape the client's own
 * parse would reject (AD-14).
 *
 * The session is the whole authorisation: every Run read is filtered by
 * `runs.account_id`, so a Builder sees their own payments and nothing else, and
 * a `run_id` they do not own is answered as an empty page rather than a 404
 * that would confirm the id exists.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: Request) {
  const guard = await requireSession()
  if (!guard.ok) return guard.response

  const query = parsePaymentsQuery(new URL(request.url).searchParams)
  const database = db()

  const runs = await selectAccountRunIds(database, guard.session.account_id, query)
  const rows = await selectPaymentRows(database, runs.slice(0, query.limit))

  const body = paymentsResponse.safeParse(
    toPaymentsPage(
      runs.map((run) => run.id),
      rows,
      query.limit,
    ),
  )
  if (!body.success) {
    return jsonError('internal_error', 'the payments body did not match its schema', {
      issues: body.error.issues,
    })
  }

  return jsonOk(body.data)
}
