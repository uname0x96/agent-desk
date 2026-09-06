import { setPriceRequest } from '@agent-desk/schemas'
import { handleManage } from '../../manage-route.ts'
import { readBody } from '../../../../../lib/route.ts'

/**
 * `POST /api/listings/<id>/price` — FR-9, the Creator's new price per call.
 *
 * 202 with the `price:<id>:<n>` intent key; 400 `validation_failed` for a price
 * of zero or above 1 tUSD; 409 `refused_stake` with `details.shortfall` when ten
 * times the new price is above the Stake the Registry holds, which is the
 * condition `setPrice` itself reverts on.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await readBody(request, setPriceRequest)
  if (!body.ok) return body.response

  const { id } = await context.params
  return handleManage(id, { intent: 'price', price: body.data.price })
}
