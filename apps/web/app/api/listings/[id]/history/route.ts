import { agentHistoryResponse } from '@agent-desk/schemas'
import { readListingHistory } from './read.ts'
import { agentRecordAccess, toAgentHistory } from '../../listing-history.ts'
import { jsonError, jsonOk } from '../../../../../lib/route.ts'
import { requireSession } from '../../../../../lib/session.ts'

/**
 * `GET /api/listings/<id>/history` — an Agent's on-chain record (Story 4.4,
 * extended by Story 5.4, FR-9, FR-42, AD-2, AD-8).
 *
 * The ordered `list:`, `price:`, `stake:`, `pause:`, `slash:` and `reputation:`
 * rows of `chain_tx` with the `before` and `after` AD-8 captured at enqueue,
 * their tx hashes and `confirmed_at`, plus the Listing's `kind = 'verification'`
 * Call. AD-2 makes those rows *are* the price, Stake, pause and Reputation
 * history — there is no history table to keep in step with them, and this route
 * never reads the chain.
 *
 * The body is parsed against its own schema before it is sent, so this route can
 * never ship a shape the client's parse would reject (AD-14).
 *
 * A Listing the marketplace does not show — `verifying` or `failed` — is
 * answered only to its Creator, and to anyone else with 404 rather than 403, so
 * the route never confirms that an id it refuses to serve exists. That is the
 * rule `GET /api/listings/<id>` next door applies, and an unknown id gets the
 * same 404 `not_found`.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requireSession()
  if (!guard.ok) return guard.response

  const { id } = await context.params
  const source = await readListingHistory(id)
  if (source === null || agentRecordAccess(source, guard.session.account_id) === 'not_found') {
    return jsonError('not_found', `no listing ${id}`)
  }

  const body = agentHistoryResponse.safeParse(toAgentHistory(source))
  if (!body.success) {
    return jsonError('internal_error', 'the agent history did not match its schema', {
      issues: body.error.issues,
    })
  }
  return jsonOk(body.data)
}
