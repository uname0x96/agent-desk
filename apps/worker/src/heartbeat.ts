import { eq } from 'drizzle-orm'
import { platformSettings, type Database } from '@agent-desk/db'

export const HEARTBEAT_INTERVAL_MS = 10_000

/**
 * Story 1.10: the worker heartbeat runs from its own interval, started at boot.
 *
 * It is deliberately independent of the settlement loop of Story 2.9 and of the
 * mode's poll interval, so `pnpm doctor` can tell "the worker is alive" apart
 * from "the settlement loop is running" — and so the heartbeat still holds in
 * `production` mode on day one, before settlement exists.
 */
export function startHeartbeat(
  db: Database,
  onError: (error: unknown) => void,
  intervalMs = HEARTBEAT_INTERVAL_MS,
): () => void {
  const beat = async () => {
    await db
      .update(platformSettings)
      .set({ workerSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(platformSettings.id, 1))
  }

  void beat().catch(onError)
  const timer = setInterval(() => void beat().catch(onError), intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
