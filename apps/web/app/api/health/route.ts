import { NextResponse } from 'next/server'
import { db } from '@agent-desk/db'
import { apiError, healthResponse } from '@agent-desk/schemas'

/**
 * Public, signed-out. Answers 200 once the database has actually been reached
 * and 503 otherwise, so compose and `pnpm doctor` can wait on it.
 *
 * The ping reads the single `platform_settings` row, which also carries the
 * worker heartbeat, so one round trip answers both questions.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE = { 'cache-control': 'no-store' } as const

type Ping = { reached: true; workerSeenAt: Date | null } | { reached: false }

async function pingDatabase(): Promise<Ping> {
  try {
    const settings = await db().query.platformSettings.findFirst()
    return { reached: true, workerSeenAt: settings?.workerSeenAt ?? null }
  } catch {
    return { reached: false }
  }
}

export async function GET() {
  const ping = await pingDatabase()

  if (!ping.reached) {
    return NextResponse.json(
      { ok: false, database: false, worker_seen_at: null },
      { status: 503, headers: NO_STORE },
    )
  }

  const body = healthResponse.safeParse({
    ok: true,
    database: true,
    worker_seen_at: ping.workerSeenAt === null ? null : ping.workerSeenAt.toISOString(),
  })
  if (!body.success) {
    return NextResponse.json(apiError('internal_error', 'health body did not match its schema'), {
      status: 500,
      headers: NO_STORE,
    })
  }

  return NextResponse.json(body.data, { status: 200, headers: NO_STORE })
}
