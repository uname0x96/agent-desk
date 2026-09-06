import { db } from '@agent-desk/db'
import { jsonOk } from '../../../../lib/route.ts'
import { requireSession } from '../../../../lib/session.ts'
import { readPlatformSettings, toPublicSettings } from '../../../../lib/settings.ts'

/**
 * `GET /api/settings/public` (AD-10, AD-12). `{ mode, emergency_stop }` for
 * every signed-in user, read fresh from `platform_settings` on every request —
 * no cache — and polled every 2 s by the dashboard header, which is what makes
 * an Operator's flip visible without a restart or a reload.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  const guard = await requireSession()
  if (!guard.ok) return guard.response

  return jsonOk(toPublicSettings(await readPlatformSettings(db())), 200)
}
