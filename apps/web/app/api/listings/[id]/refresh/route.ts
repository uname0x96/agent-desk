import { MARKETPLACE_STATUSES } from '../../listings-view.ts'
import { listingDetailResponse } from '../../listing-progress.ts'
import { readListingDetail } from '../../listing-detail.ts'
import { reconcileListingStatus, refreshListingFromChain } from '../../refresh-context.ts'
import { jsonError, jsonOk } from '../../../../../lib/route.ts'
import { requireSession } from '../../../../../lib/session.ts'

/**
 * `POST /api/listings/<id>/refresh` — the second caller of
 * `refreshListingFromChain` named by AD-2 (Story 3.6).
 *
 * Any signed-in user may call it, and it reads nothing from the caller but the
 * session: the answer is the Registry's own, so there is nothing here to abuse
 * beyond an RPC round trip. It exists for one case — a receipt the worker never
 * saw, which leaves the cache behind the chain — and the manage page offers it
 * as "refresh from chain" next to the numbers it would correct.
 *
 * The body is the same `GET /api/listings/<id>` answers, so the page can drop it
 * straight into the query cache.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requireSession()
  if (!guard.ok) return guard.response

  const { id } = await context.params

  const refreshed = await refreshListingFromChain(id)
  if (!refreshed.refreshed && refreshed.reason === 'listing_not_found') {
    return jsonError('not_found', `no listing ${id}`)
  }
  // `no_registry_listing_id` is not an error: a Listing still in `verifying` has
  // no Registry entry to read yet, and the honest answer is the row as it is.
  if (refreshed.refreshed) await reconcileListingStatus(id)

  const detail = await readListingDetail(id, guard.session.account_id)
  const visible =
    detail !== null &&
    (detail.creatorAccountId === guard.session.account_id ||
      MARKETPLACE_STATUSES.includes(detail.status))
  if (!detail || !visible) return jsonError('not_found', `no listing ${id}`)

  const body = listingDetailResponse.safeParse(detail.body)
  if (!body.success) {
    return jsonError('internal_error', 'the listing body did not match its schema', {
      issues: body.error.issues,
    })
  }
  return jsonOk(body.data)
}
