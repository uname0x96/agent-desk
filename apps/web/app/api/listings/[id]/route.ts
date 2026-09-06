import { MARKETPLACE_STATUSES } from '../listings-view.ts'
import { listingDetailResponse } from '../listing-progress.ts'
import { readListingDetail } from '../listing-detail.ts'
import { jsonError, jsonOk } from '../../../../lib/route.ts'
import { requireSession } from '../../../../lib/session.ts'

/**
 * `GET /api/listings/<id>` — one Listing with its pipeline (Story 3.3, AD-12).
 *
 * The listing page polls this every two seconds while the Listing is
 * `verifying`, so the Creator sees each step land rather than a spinner. The
 * body is parsed against its own schema before it is sent, so this route can
 * never ship a shape the client's parse would reject (AD-14).
 *
 * A Listing the marketplace does not show — `verifying` or `failed` — is
 * answered only to the Creator, and to anyone else with 404 rather than 403, so
 * the route never confirms that an id it refuses to serve exists. That is the
 * same rule `requireWorkflowOwner` applies to a Workflow.
 *
 * `GET /api/listings/<id>/agent.json` next to this one stays signed-out on
 * purpose: it is the `agentURI` an indexer reads.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requireSession()
  if (!guard.ok) return guard.response

  const { id } = await context.params
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
