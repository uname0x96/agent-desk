import type { NextResponse } from 'next/server'
import { intentAccepted } from '@agent-desk/schemas'
import { createManageDeps } from './context.ts'
import { requestListingWrite, type ManageRequest } from './manage-listing.ts'
import { jsonError, jsonOk } from '../../../lib/route.ts'
import { requireSession } from '../../../lib/session.ts'

/**
 * The HTTP half of `/api/listings/<id>/price`, `/stake` and `/pause`.
 *
 * The three routes differ in one thing — the body schema and the field it
 * carries — so everything after that lives here: the session, the ownership and
 * on-chain checks in `requestListingWrite`, and the 202 that hands the Creator
 * the intent key of the transaction they just asked for (AD-8).
 */
export async function handleManage(
  listingId: string,
  request: ManageRequest,
): Promise<NextResponse> {
  const guard = await requireSession()
  if (!guard.ok) return guard.response

  const result = await requestListingWrite(
    createManageDeps(),
    guard.session.account_id,
    listingId,
    request,
  )
  if (!result.ok) {
    const { code, message, details } = result.refusal
    return jsonError(code, message, details)
  }

  // Parsed before it is sent, so this route can never ship a shape the client's
  // own parse would reject (AD-14).
  return jsonOk(intentAccepted.parse({ intent_key: result.intentKey }), 202)
}
