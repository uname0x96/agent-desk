import { db } from '@agent-desk/db'
import { operatorSettingsRequest } from '@agent-desk/schemas'
import { jsonError, jsonOk, readBody } from '../../../../lib/route.ts'
import { requireOperator } from '../../../../lib/session.ts'
import { isEmptyPatch, toPublicSettings, updatePlatformSettings } from '../../../../lib/settings.ts'

/**
 * `PATCH /api/operator/settings { emergency_stop?, mode?, order_ceiling_usdt? }`
 * (FR-45, AD-10). Operator only: a non-operator gets 403 `forbidden`.
 *
 * The change is persisted to `platform_settings` row 1 and the row is read back
 * and answered as `publicSettings`, so the page can show the new state
 * immediately and its next 2 s poll confirms it from the database. The worker
 * and `GET /api/internal/settings` see it on their next read, which is at most
 * one loop iteration away.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function PATCH(request: Request) {
  const guard = await requireOperator()
  if (!guard.ok) return guard.response

  const body = await readBody(request, operatorSettingsRequest)
  if (!body.ok) return body.response

  const patch = {
    ...(body.data.mode === undefined ? {} : { mode: body.data.mode }),
    ...(body.data.emergency_stop === undefined
      ? {}
      : { emergencyStop: body.data.emergency_stop }),
    ...(body.data.order_ceiling_usdt === undefined
      ? {}
      : { orderCeilingUsdt: body.data.order_ceiling_usdt }),
  }
  if (isEmptyPatch(patch)) {
    return jsonError('validation_failed', 'name at least one setting to change')
  }

  return jsonOk(toPublicSettings(await updatePlatformSettings(db(), patch)), 200)
}
