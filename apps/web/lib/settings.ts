import {
  PLATFORM_SETTINGS_ID,
  platformSettings,
  type Database,
  type PlatformSettingsRow,
} from '@agent-desk/db'
import {
  internalSettings,
  platformModeSchema,
  publicSettings,
  type InternalSettings,
  type PlatformMode,
  type PublicSettings,
} from '@agent-desk/schemas'

/**
 * AD-10: `platform_settings` is one row, `id = 1`, and it is read **fresh on
 * every API request**. There is deliberately no cache in this module — not a
 * module-level variable, not a `unstable_cache`, not a React `cache()` — because
 * the whole point of the Operator page is that flipping Emergency Stop or the
 * mode steers a running demo without a restart. Every route that reads settings
 * calls `readPlatformSettings` again, and every one of them is
 * `dynamic = 'force-dynamic'`.
 */

export async function readPlatformSettings(db: Database): Promise<PlatformSettingsRow> {
  const row = await db.query.platformSettings.findFirst()
  if (!row) {
    // The migration inserts row 1; its absence is a broken database, not a 404.
    throw new Error(`platform_settings row ${PLATFORM_SETTINGS_ID} is missing`)
  }
  return row
}

/** `GET /api/settings/public`: what every signed-in page may know (AD-10). */
export function toPublicSettings(row: PlatformSettingsRow): PublicSettings {
  return publicSettings.parse({ mode: row.mode, emergency_stop: row.emergencyStop })
}

/** `GET /api/internal/settings`: what a platform-operated agent reads (AD-11). */
export function toInternalSettings(row: PlatformSettingsRow): InternalSettings {
  return internalSettings.parse({
    emergency_stop: row.emergencyStop,
    order_ceiling_usdt: row.orderCeilingUsdt,
  })
}

export interface SettingsPatch {
  mode?: PlatformMode
  emergencyStop?: boolean
  /** Decimal USDT (AD-13); the executor's global order ceiling. */
  orderCeilingUsdt?: string
}

/** True when the patch would change nothing, so the route can skip the write. */
export function isEmptyPatch(patch: SettingsPatch): boolean {
  return (
    patch.mode === undefined &&
    patch.emergencyStop === undefined &&
    patch.orderCeilingUsdt === undefined
  )
}

/**
 * `PATCH /api/operator/settings`. The single-row check constraint
 * (`platform_settings_single_row`) makes a `where` clause unnecessary, which is
 * what lets this update stay a fully parameterised Drizzle statement: `apps/web`
 * depends on `@agent-desk/db` but not on `drizzle-orm`, so it has no `eq` to
 * build one with.
 */
export async function updatePlatformSettings(
  db: Database,
  patch: SettingsPatch,
  now: Date = new Date(),
): Promise<PlatformSettingsRow> {
  if (!isEmptyPatch(patch)) {
    await db
      .update(platformSettings)
      .set({
        ...(patch.mode === undefined ? {} : { mode: platformModeSchema.parse(patch.mode) }),
        ...(patch.emergencyStop === undefined ? {} : { emergencyStop: patch.emergencyStop }),
        ...(patch.orderCeilingUsdt === undefined
          ? {}
          : { orderCeilingUsdt: patch.orderCeilingUsdt }),
        updatedAt: now,
      })
  }
  // Read back rather than trust the patch: the row is the record, and the
  // caller is about to show it to an Operator who just changed it.
  return readPlatformSettings(db)
}
