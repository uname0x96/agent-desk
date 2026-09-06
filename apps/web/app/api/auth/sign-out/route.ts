import { NextResponse } from 'next/server'
import { NO_STORE } from '../../../../lib/route.ts'
import { destroySession } from '../../../../lib/session.ts'

/**
 * `POST /api/auth/sign-out` (Story 2.1). Clears the cookie and answers 204, so
 * there is no body to define a schema for. Signing out while already signed out
 * is not an error, so this route has no failure path.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST() {
  await destroySession()
  return new NextResponse(null, { status: 204, headers: NO_STORE })
}
