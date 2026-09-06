import { NextResponse } from 'next/server'
import { apiError, listingsResponse } from '@agent-desk/schemas'
import { parsePageSize, toListingsPage } from './listings-view.ts'
import { selectMarketplaceListings } from './query.ts'

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
