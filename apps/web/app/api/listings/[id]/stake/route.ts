import { addStakeRequest } from '@agent-desk/schemas'
import { handleManage } from '../../manage-route.ts'
import { readBody } from '../../../../../lib/route.ts'

/**
 * `POST /api/listings/<id>/stake` — FR-7, a top-up of the Listing's Stake.
 *
 * 202 with the `stake:<id>:<n>` intent key; 400 `validation_failed` for a top-up
 * of zero. The Creator wallet's tUSD balance is checked by `listing.write`
 * inside the wallet lock, where the answer is still true when `addStake` is
 * signed (AD-5).
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await readBody(request, addStakeRequest)
  if (!body.ok) return body.response

  const { id } = await context.params
  return handleManage(id, { intent: 'stake', amount: body.data.amount })
}
