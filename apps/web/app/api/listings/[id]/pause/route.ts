import { setPausedRequest } from '@agent-desk/schemas'
import { handleManage } from '../../manage-route.ts'
import { readBody } from '../../../../../lib/route.ts'

/**
 * `POST /api/listings/<id>/pause` — FR-8, the Creator's own pause switch.
 *
 * 202 with the `pause:<id>:<n>` intent key. This toggles `pausedByCreator` and
 * nothing else: `pausedByStake` is the contract's, set when a slash empties the
 * Stake and cleared by a top-up, so a Resume that would change nothing is
 * refused here with the sentence that says what actually would.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await readBody(request, setPausedRequest)
  if (!body.ok) return body.response

  const { id } = await context.params
  return handleManage(id, { intent: 'pause', paused: body.data.paused })
}
