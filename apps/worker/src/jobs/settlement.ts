import type { PgBoss } from 'pg-boss'
import type { Logger as PinoLogger } from 'pino'
import type { Database } from '@agent-desk/db'
import type { Engine } from '@agent-desk/scripts/wiring'
import {
  createContractCalls,
  createPublicChainClient,
  createReceiptSource,
} from '@agent-desk/adapters/chain'
import { createMarketData } from '@agent-desk/adapters/market-data'
import { MODE_CONSTANTS, modeConstants } from '@agent-desk/core/mode'
import type { Logger } from '@agent-desk/core/ports'
import { bnbToWei } from '@agent-desk/core/signing'
import { QUEUES, settlementTickJob, type PlatformMode, type SettlementTickJob } from '@agent-desk/schemas'
import { env } from '../env.ts'
import { runSettlementTick as sweepTick } from './run/settlement-loop.ts'
import { createSettlementChain } from './settlement/chain.ts'
import { createSettlementStore } from './settlement/store.ts'
import { createSettlementTick, type SettlementTick, type SettlementTickOutcome } from './settlement/tick.ts'

/**
 * AD-9: "the worker runs the settlement loop in-process as a `setTimeout` chain
 * that re-reads `platform_settings.mode` each iteration and sleeps the mode's
 * poll interval from the mode constants in `packages/core`; the same
 * `runSettlementTick` also serves the targeted pg-boss job `settlement.tick
 * { call_id }` and performs the AD-4 timeout sweep."
 *
 * There is one loop, and this is it. Story 2.9 built the sweep half in
 * `run/settlement-loop.ts` and left the seam open for scoring; rather than run
 * a second timer beside it, each iteration here calls that function for the
 * mode read and the timeout sweep, then runs the scoring pass on the mode it
 * returned. So the AD-4 sweep still happens exactly once per iteration, on the
 * same clock, and `apps/worker/src/index.ts` starts one thing instead of two.
 *
 * It stays independent of `heartbeat.ts`, which keeps its own 10 s interval so
 * `pnpm doctor` can tell "the worker is alive" apart from "settlement is
 * running" — and so the heartbeat still holds in `production` mode, where this
 * loop sleeps a minute at a time.
 */

export interface SettlementJobDeps {
  db: Database
  boss: PgBoss
  /** The composition root that owns `chainWrite` and the Registry addresses. */
  engine: Engine
  logger: PinoLogger
  /** AD-9: the wallet that signs every slash and every reputation write. */
  platformWalletId: string
}

export interface SettlementLoopHandle {
  stop: () => void
  /** Exposed so a test, or a future operator route, can force one pass. */
  tick: SettlementTick
}

/**
 * Builds the tick from the live database, the Binance market-data adapter, and
 * the engine's chain writer. Split from the registration below so an
 * integration test can drive one pass without owning a timer or a queue.
 */
export function buildSettlementTick(deps: SettlementJobDeps): SettlementTick {
  const publicClient = createPublicChainClient({ chainId: env.CHAIN_ID, rpcUrls: env.RPC_URLS })
  const store = createSettlementStore(deps.db)
  const logger = adaptLogger(deps.logger)

  return createSettlementTick({
    store,
    // AD-9 / addendum §4: Binance *production* public market data is the only
    // price source a Settlement may name — never the paid `data` Agent, whose
    // answer is the very thing being judged, and never the Spot Testnet book.
    marketData: createMarketData(),
    chain: createSettlementChain({
      chain: deps.engine.chain,
      calls: createContractCalls(deps.engine.addresses),
      receipts: createReceiptSource(publicClient),
      addresses: deps.engine.addresses,
      platformWalletId: deps.platformWalletId,
      gasFloorWei: bnbToWei(env.PLATFORM_WALLET_BNB_FLOOR),
      store,
      logger,
    }),
    logger,
  })
}

/**
 * Registers `settlement.tick` and starts the loop. The first pass runs
 * immediately, so a worker that boots after a crash settles whatever the dead
 * one left before it waits on anything.
 */
export async function registerSettlementJobs(deps: SettlementJobDeps): Promise<SettlementLoopHandle> {
  const logger = adaptLogger(deps.logger)
  const tick = buildSettlementTick(deps)

  // Story 4.2: the engine publishes `settlement.tick { call_id }` the moment it
  // marks a `research` or `risk` Call `failed_after_payment`, and this is the
  // handler. It runs the same code path as the periodic pass, aimed at one
  // Call, so a redelivery finds the row and writes nothing new.
  await deps.boss.work<SettlementTickJob>(QUEUES.settlementTick, async (jobs) => {
    for (const job of jobs) {
      const callId = settlementTickJob.parse(job.data).call_id
      const outcome = await tick.runForCall(callId)
      logger.info({ call_id: callId, ...counts(outcome) }, 'targeted settlement tick finished')
    }
  })

  const stop = startSettlementLoop(deps, tick)
  logger.info({ queue: QUEUES.settlementTick }, 'settlement loop, scoring and timeout sweep started')
  return { stop, tick }
}

/** The `setTimeout` chain. Exported so a test can start and stop one. */
export function startSettlementLoop(deps: SettlementJobDeps, tick: SettlementTick): () => void {
  const logger = adaptLogger(deps.logger)
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const iterate = async (): Promise<void> => {
    if (stopped) return
    // A failed pass must never stop the chain: Postgres may be restarting, an
    // RPC may be down, and the whole point of the loop is that it is still
    // there afterwards.
    let mode: PlatformMode = FALLBACK_MODE
    try {
      // Story 2.9's half: the mode read and the AD-4 timeout sweep.
      mode = (await sweepTick({ db: deps.db, boss: deps.boss, logger })).mode
    } catch (error) {
      logger.error({ error: messageOf(error) }, 'settlement sweep failed')
    }
    try {
      const outcome = await tick.run({ mode })
      if (outcome.scanned > 0) logger.info(counts(outcome), 'settlement pass finished')
    } catch (error) {
      logger.error({ mode, error: messageOf(error) }, 'settlement scoring pass failed')
    }
    if (stopped) return
    timer = setTimeout(() => void iterate(), modeConstants(mode).settlementPollMs)
    timer.unref?.()
  }

  void iterate()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
  }
}

/** The mode to sleep on when `platform_settings` cannot be read at all. */
const FALLBACK_MODE: PlatformMode = 'production'

/** Kept so a log line names the constant table it slept on. */
export const FALLBACK_POLL_MS = MODE_CONSTANTS[FALLBACK_MODE].settlementPollMs

function counts(outcome: SettlementTickOutcome): Record<string, unknown> {
  return {
    mode: outcome.mode,
    scanned: outcome.scanned,
    written: outcome.written,
    deferred: outcome.deferred,
    slashes: outcome.slashes,
    reputation_writes: outcome.reputationWrites,
    errors: outcome.errors,
  }
}

/** Pino satisfies the port already; this narrows it to the four levels it names. */
function adaptLogger(logger: PinoLogger): Logger {
  return {
    debug: (fields, message) => logger.debug(fields, message),
    info: (fields, message) => logger.info(fields, message),
    warn: (fields, message) => logger.warn(fields, message),
    error: (fields, message) => logger.error(fields, message),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
