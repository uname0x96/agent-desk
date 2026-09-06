import { NextResponse } from 'next/server'
import { apiError, createListingRequest, listingsResponse } from '@agent-desk/schemas'
import { createListingDeps } from './context.ts'
import { createListing } from './create-listing.ts'
import { parsePageSize, toListingsPage } from './listings-view.ts'
import { selectMarketplaceListings } from './query.ts'
import { jsonError, jsonOk, readBody } from '../../../lib/route.ts'
import { requireSession } from '../../../lib/session.ts'

/**
 * `GET /api/listings` — the marketplace read model (AD-2, FR-13).
 *
 * Answers `{ items, next }` with `active` and `paused` Listings only, amounts as
 * base-unit strings and addresses lower-case (AD-13). The body is parsed against
 * `listingsResponse` before it is sent, so this route can never ship a shape the
 * client's own parse would reject (AD-14).
 *
 * `?cursor=<listing id>&limit=<n>`. Story 3.5 adds `type` and `sort`.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE = { 'cache-control': 'no-store' } as const

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const limit = parsePageSize(params.get('limit'))
  const cursor = params.get('cursor')

  const rows = await selectMarketplaceListings(limit, cursor)
  const body = listingsResponse.safeParse(toListingsPage(rows, limit))
  if (!body.success) {
    return NextResponse.json(
      apiError('internal_error', 'the listings body did not match its schema', {
        issues: body.error.issues,
      }),
      { status: 500, headers: NO_STORE },
    )
  }

  return NextResponse.json(body.data, { status: 200, headers: NO_STORE })
}

/**
 * `POST /api/listings` — the listing form (Story 3.3, FR-10, FR-14).
 *
 * The decision is `createListing`: it validates every field, refuses an
 * `execution` Type from anyone but the Platform Account, refuses a Creator whose
 * System Wallet is not ready, inserts the row `verifying`, and publishes
 * `listing.verify` with `listing_id` as its singleton key. This handler only
 * translates that into HTTP and answers 201 with the id the Creator is about to
 * watch at `/listings/<id>`.
 */
export async function POST(request: Request) {
  const guard = await requireSession()
  if (!guard.ok) return guard.response

  const body = await readBody(request, createListingRequest)
  if (!body.ok) return body.response

  const result = await createListing(createListingDeps(), guard.session.account_id, body.data)
  if (!result.ok) {
    const { code, message, details } = result.refusal
    return jsonError(code, message, details)
  }

  return jsonOk({ listing_id: result.listingId }, 201)
}
