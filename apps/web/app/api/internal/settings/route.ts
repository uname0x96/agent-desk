import { db } from '@agent-desk/db'
import { jsonError, jsonOk } from '../../../../lib/route.ts'
import { bearerTokenMatches } from '../../../../lib/session-policy.ts'
import { readPlatformSettings, toInternalSettings } from '../../../../lib/settings.ts'

/**
 * `GET /api/internal/settings` (AD-10, AD-11).
 *
 * `InternalSettings { emergency_stop, order_ceiling_usdt }` for the
 * platform-operated agents, which read it before *every* order. There is no
 * session here on purpose: the caller is the Spot Executor process, not a
 * browser, and it authenticates with `Authorization: Bearer <INTERNAL_TOKEN>`.
 * A missing or wrong token answers 401 `unauthorized`.
 *
 * The row is read fresh on every request, so an Operator's Emergency Stop
 * reaches the executor on its next call rather than on its next restart.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: Request) {
  // Read here, not at module scope: `next build` imports this route without the
  // runtime environment.
  const expected = process.env.INTERNAL_TOKEN ?? ''
  if (!bearerTokenMatches(request.headers.get('authorization'), expected)) {
    return jsonError('unauthorized', 'a valid internal bearer token is required')
  }

  return jsonOk(toInternalSettings(await readPlatformSettings(db())), 200)
}
