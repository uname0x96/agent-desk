import { eq } from 'drizzle-orm'
import { PLATFORM_SETTINGS_ID, platformSettings, type Database } from '@agent-desk/db'
import type { Clock, Logger } from '@agent-desk/core/ports'
import { silentLogger } from '@agent-desk/core/ports'
import type { PlatformMode } from '@agent-desk/schemas'
import type { PgBoss } from 'pg-boss'
import { createRunPublisher } from './publisher.ts'
import { createRunStore } from './store.ts'
import { sweepTimedOutRuns, type SweepResult } from './sweep.ts'

/**
 * AD-9: the worker's settlement loop, in process.
 *
 * It is a `setTimeout` chain rather than a `setInterval` on purpose. Each
 * iteration re-reads `platform_settings.mode` and sleeps *that* mode's poll
 * interval, so flipping the Operator page from `production` to `demo` speeds the
 * loop from 60 s to 2 s without a restart (AD-10) — and a tick that runs long
 * can never overlap the next one, which an interval would happily allow.
 *
 * In this story the tick does one thing: the AD-4 timeout sweep. Story 4.1
 * extends the same `runSettlementTick` with scoring, which is why the seam is a
 * function with a result rather than an anonymous body inside the timer.
 *
 * The loop is deliberately *not* the heartbeat. `heartbeat.ts` writes
 * `worker_seen_at` every 10 s from its own interval so `pnpm doctor` can tell
 * "the worker is alive" apart from "the settlement loop is running", and so the
 * heartbeat still holds in `production` mode, where this loop sleeps a minute at
 * a time.
 */

export interface SettlementLoopDeps {
  db: Database
  boss: PgBoss
  logger?: Logger
  clock?: Clock
  /** The engine's Run budget. Overridable so a test does not wait 120 s. */
  budgetMs?: number
  graceMs?: number
}

export interface SettlementTickResult {
  /** The mode as it was read *at tick time*; AD-9 says that read governs. */
  mode: PlatformMode
  /** AD-4's sweep. Empty on a targeted tick, which is about one Call. */
  sweep: SweepResult | null
  /** Set when the tick came from `settlement.tick { call_id }`. */
  callId?: string
}

/** The mode to sleep on when `platform_settings` cannot be read at all. */
const FALLBACK_MODE: PlatformMode = 'production'

/** AD-10: read fresh every iteration; nothing caches it. */
export async function readMode(db: Database): Promise<PlatformMode> {
  const [row] = await db
    .select({ mode: platformSettings.mode })
    .from(platformSettings)
    .where(eq(platformSettings.id, PLATFORM_SETTINGS_ID))
    .limit(1)
  return row?.mode ?? FALLBACK_MODE
}

/**
 * AD-9: "the same `runSettlementTick` also serves the targeted pg-boss job
 * `settlement.tick { call_id }` and performs the AD-4 timeout sweep."
 *
 * A targeted tick names one Call and does not sweep: the Call it is about has
 * already ended, and the sweep is about Runs that have not. Scoring the named
 * Call is Epic 4; until then the targeted tick records that it arrived, which
 * is what "a no-op handler is registered now" means for Story 2.9.
 */
export async function runSettlementTick(
  deps: SettlementLoopDeps,
  options: { callId?: string } = {},
): Promise<SettlementTickResult> {
  const logger = deps.logger ?? silentLogger
  const mode = await readMode(deps.db)

  if (options.callId !== undefined) {
    logger.info(
      { call_id: options.callId, mode },
      'settlement tick received; scoring lands in Epic 4',
    )
    return { mode, sweep: null, callId: options.callId }
  }

  const sweep = await sweepTimedOutRuns({
    store: createRunStore(deps.db),
    publisher: createRunPublisher(deps.boss, logger),
    ...(deps.clock ? { clock: deps.clock } : {}),
    logger,
    ...(deps.budgetMs === undefined ? {} : { budgetMs: deps.budgetMs }),
    ...(deps.graceMs === undefined ? {} : { graceMs: deps.graceMs }),
  })

  return { mode, sweep }
}

/**
 * The `setTimeout` chain itself, with the work it drives passed in.
 *
 * It is separate from the settlement tick for one reason: this is the part with
 * no database in it, and the three properties AD-9 depends on are properties of
 * the timer, not of the work — the next sleep is whatever the last tick asked
 * for (so a mode flip is honoured on the next iteration, never cached), two
 * ticks never overlap however long one runs, and a throwing tick does not end
 * the chain, because a worker that stops sweeping after one bad database read
 * is exactly the worker this loop exists to be.
 */
export function startPollingLoop(options: {
  /** Runs one iteration and answers how long to sleep before the next. */
  tick: () => Promise<number>
  /** How long to sleep when a tick throws and cannot say. */
  fallbackSleepMs: number
  onError?: (error: unknown) => void
}): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const run = async (): Promise<void> => {
    if (stopped) return
    let sleepMs = options.fallbackSleepMs
    try {
      sleepMs = await options.tick()
    } catch (error) {
      options.onError?.(error)
    }
    if (stopped) return
    timer = setTimeout(() => void run(), sleepMs)
    timer.unref?.()
  }

  void run()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
  }
}

/**
 * The boot-time loop is not here.
 *
 * AD-9 allows exactly one settlement loop, and `apps/worker/src/jobs/settlement.ts`
 * is it: each of its iterations calls `runSettlementTick` above for the mode read
 * and the AD-4 timeout sweep, then runs its own scoring pass on the mode that
 * came back. So this module deliberately exports the two halves — the tick, and
 * the timer primitive that carries AD-9's three timing properties — and starts
 * nothing itself. A `registerSettlementLoop` here would have to register a
 * second `settlement.tick` handler beside the real one, and pg-boss would hand
 * each delivery to whichever won the race.
 */
