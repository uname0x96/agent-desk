import {
  isScoredResult,
  planSettlement,
  reputationBps,
  REPUTATION_WINDOW,
  settleWithMarketData,
  type MarketDataNeed,
  type MarketObservation,
  type SettlementContext,
  type SettlementRowPlan,
  type SettlementStep,
} from '@agent-desk/core/settlement'
import type { Clock, Kline, Logger, MarketData } from '@agent-desk/core/ports'
import { silentLogger, systemClock } from '@agent-desk/core/ports'
import type { PlatformMode } from '@agent-desk/schemas'
import type {
  SettlementChain,
  SettlementRecord,
  SettlementStore,
  SettlementWork,
} from './ports.ts'

/**
 * AD-9: the tick that settles each Call once, then slashes and rewrites
 * Reputation for it.
 *
 * Every decision it makes is `packages/core/settlement`'s; this file only
 * carries them: it selects the Calls, performs the one `MarketData` read the
 * plan asked for, inserts the row, and then walks the row's two chain writes.
 * That is why the order below is a sequence of small steps with an early
 * return at each — the interesting behaviour is *what happens when a step does
 * not finish*, and every one of those cases has to leave the row in a state the
 * next tick can pick up.
 *
 * Three rules run through all of it:
 *
 *   - a Call is scored at most once (`settlements.call_id` is unique, and a
 *     losing insert reads the winner's row instead of writing a second);
 *   - a market-data failure scores nothing: the Call stays unscored and the
 *     next tick tries again (Story 4.1);
 *   - a chain write is `chainWrite` on its AD-8 intent key, so a retried tick
 *     re-checks the receipt and never sends a second transaction.
 */

export interface SettlementTickDeps {
  store: SettlementStore
  marketData: MarketData
  chain: SettlementChain
  logger?: Logger
  clock?: Clock
  /** How many Calls one tick will look at. Keeps a backlog from starving the loop. */
  batchSize?: number
}

export const DEFAULT_BATCH_SIZE = 25

export interface SettlementTickOutcome {
  /** The mode read at tick time; AD-9 says that read governs every row written. */
  mode: PlatformMode
  /** Calls looked at, including rows that only needed a chain follow-up. */
  scanned: number
  written: number
  deferred: number
  slashes: number
  reputationWrites: number
  errors: number
}

export interface SettlementTick {
  /** The periodic pass of the loop: everything due, plus every unfinished row. */
  run(options?: { mode?: PlatformMode }): Promise<SettlementTickOutcome>
  /** `settlement.tick { call_id }`: the same code path, aimed at one Call. */
  runForCall(callId: string, options?: { mode?: PlatformMode }): Promise<SettlementTickOutcome>
}

export function createSettlementTick(deps: SettlementTickDeps): SettlementTick {
  const logger = deps.logger ?? silentLogger
  const clock = deps.clock ?? systemClock
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE

  async function run(options: { mode?: PlatformMode } = {}): Promise<SettlementTickOutcome> {
    const mode = options.mode ?? (await deps.store.mode())
    const outcome = empty(mode)
    const handled = new Set<string>()

    for (const work of await deps.store.due(batchSize)) {
      await settle(work, mode, outcome, handled)
    }

    // Rows already written whose slash or reputation has not landed — the case
    // Story 4.3 calls "the tick retries it on the next iteration through the
    // same key". A row this pass has already worked on is skipped: retrying a
    // write that just refused, in the same second, is not a retry.
    for (const followUp of await deps.store.unfinished(batchSize)) {
      if (handled.has(followUp.record.id)) continue
      outcome.scanned += 1
      await finish(followUp.record, followUp.work, mode, outcome, handled)
    }

    return outcome
  }

  async function runForCall(
    callId: string,
    options: { mode?: PlatformMode } = {},
  ): Promise<SettlementTickOutcome> {
    const mode = options.mode ?? (await deps.store.mode())
    const outcome = empty(mode)
    const work = await deps.store.workFor(callId)
    if (!work) {
      logger.warn({ call_id: callId }, 'settlement tick names a Call that is not scorable')
      return outcome
    }
    await settle(work, mode, outcome, new Set())
    return outcome
  }

  /** One candidate, from selection to the two chain writes. */
  async function settle(
    work: SettlementWork,
    mode: PlatformMode,
    outcome: SettlementTickOutcome,
    handled: Set<string>,
  ): Promise<void> {
    outcome.scanned += 1
    const callId = work.candidate.callId

    // Story 4.2: "a redelivered job for the same `call_id` finds the row and
    // does nothing" — nothing *new*, that is. The row's unfinished chain writes
    // are still this tick's business.
    const existing = await deps.store.find(callId)
    if (existing) {
      await finish(existing, work, mode, outcome, handled)
      return
    }

    const context: SettlementContext = { mode, now: clock.now() }
    let step: SettlementStep
    try {
      step = planSettlement(work.candidate, context)
      if (step.kind === 'score') step = await score(work, context, step.need)
    } catch (error) {
      outcome.errors += 1
      logger.error({ call_id: callId, error: message(error) }, 'settlement planning failed')
      return
    }

    if (step.kind !== 'write') {
      outcome.deferred += 1
      logger.debug({ call_id: callId, reason: step.kind === 'defer' ? step.reason : step.kind }, 'call not settled this tick')
      return
    }

    const { record, inserted } = await deps.store.insert(step.row)
    if (inserted) {
      outcome.written += 1
      logger.info(logFields(step.row), 'settlement written')
    } else {
      // Two ticks raced on the same Call. The unique index decided; this one
      // now works on the row that won, which is the same row it would have
      // written.
      logger.info({ call_id: callId, settlement_id: record.id }, 'settlement already existed; not written twice')
    }

    await finish(record, work, mode, outcome, handled)
  }

  /**
   * The one `MarketData` read the plan asked for. A failure returns a `defer`,
   * so the Call keeps its place in the next tick's selection with no row
   * written — Story 4.1's "a market-data failure leaves the Call unscored for
   * the next tick".
   */
  async function score(
    work: SettlementWork,
    context: SettlementContext,
    need: MarketDataNeed,
  ): Promise<SettlementStep> {
    let observation: MarketObservation
    try {
      observation = await read(need)
    } catch (error) {
      logger.warn(
        { call_id: work.candidate.callId, rule: need.rule, error: message(error) },
        'market data read failed; the Call stays unscored for the next tick',
      )
      return { kind: 'defer', reason: 'window_open' }
    }
    return settleWithMarketData(work.candidate, context, need, observation)
  }

  async function read(need: MarketDataNeed): Promise<MarketObservation> {
    if (need.rule === 'window price move') {
      return { rule: 'window price move', endPrice: await deps.marketData.lastPrice(need.symbol) }
    }
    if (need.rule === '24h trend') {
      const ticker = await deps.marketData.ticker24h(need.symbol)
      return { rule: '24h trend', change24hPct: ticker.change24hPct }
    }
    const klines = await deps.marketData.klines({
      symbol: need.symbol,
      interval: need.interval,
      startTime: need.startTime,
      endTime: need.endTime,
      limit: KLINE_LIMIT,
    })
    return { rule: 'drawdown', windowMin: lowestLow(klines), windowMax: highestHigh(klines) }
  }

  /**
   * Story 4.3 then Story 4.4, in that order: the slash first, because the
   * Refund is what the Builder is owed, and the Reputation write second,
   * because it is the summary of a row that has already been paid out.
   */
  async function finish(
    record: SettlementRecord,
    work: SettlementWork,
    mode: PlatformMode,
    outcome: SettlementTickOutcome,
    handled: Set<string>,
  ): Promise<void> {
    handled.add(record.id)
    const slashSettled = await maybeSlash(record, work, outcome)
    if (!slashSettled) return
    await maybeWriteReputation(record, work, mode, outcome)
  }

  /**
   * Returns false only while a slash is still in flight, which is the one case
   * where the Reputation write should wait: AD-9 puts it "after the slash".
   * A slash that reverted is settled as far as this tick is concerned — the
   * score is still real and still belongs on chain.
   */
  async function maybeSlash(
    record: SettlementRecord,
    work: SettlementWork,
    outcome: SettlementTickOutcome,
  ): Promise<boolean> {
    if (record.result !== 'failed' || record.slashTxHash !== null) return true

    const problem = missingSlashInput(work)
    if (problem) {
      outcome.errors += 1
      logger.error({ settlement_id: record.id, call_id: record.callId, reason: problem }, 'cannot slash')
      return true
    }

    const result = await deps.chain.slash({
      settlementId: record.id,
      callId: record.callId,
      listingId: record.listingId,
      registryListingId: work.registryListingId as string,
      amount: work.lockedPrice,
      to: work.refundTo as string,
    })

    if (result.status === 'confirmed') {
      // AD-9: the contract clamps to the remaining stake, so what the row
      // records is what `Slashed` said, never what was asked for.
      const slashAmount = result.amount ?? work.lockedPrice
      await deps.store.recordSlash(record.id, {
        slashAmount,
        slashTxHash: result.txHash,
        refundTo: work.refundTo as string,
      })
      record.slashAmount = slashAmount
      record.slashTxHash = result.txHash
      record.refundTo = work.refundTo as string
      outcome.slashes += 1
      logger.info(
        {
          settlement_id: record.id,
          call_id: record.callId,
          listing_id: record.listingId,
          tx_hash: result.txHash,
          slash_amount: slashAmount,
          refund_to: work.refundTo,
        },
        'slash confirmed and refunded',
      )
      return true
    }

    if (result.status === 'pending') {
      logger.info({ settlement_id: record.id, tx_hash: result.txHash }, 'slash sent; awaiting the receipt')
      return false
    }

    outcome.errors += 1
    logger.error(
      {
        settlement_id: record.id,
        call_id: record.callId,
        listing_id: record.listingId,
        reason: result.reason,
        ...(result.status === 'failed' ? { tx_hash: result.txHash } : {}),
      },
      'slash did not land',
    )
    // A refusal leaves the `chain_tx` row `pending`, so the same intent key is
    // retried on the next tick; a revert is terminal for the key and the reason
    // is on the Listing (AD-8). Either way the score itself still stands.
    return result.status === 'refused' ? false : true
  }

  async function maybeWriteReputation(
    record: SettlementRecord,
    work: SettlementWork,
    mode: PlatformMode,
    outcome: SettlementTickOutcome,
  ): Promise<void> {
    // AD-9: only a `passed` or `failed` row triggers a reputation write.
    if (!isScoredResult(record.result) || record.reputationTxHash !== null) return
    if (!work.registryListingId) {
      outcome.errors += 1
      logger.error({ settlement_id: record.id, listing_id: record.listingId }, 'cannot write reputation without a Registry listing id')
      return
    }

    const results = await deps.store.recentResults(record.listingId, REPUTATION_WINDOW)
    const bps = reputationBps(results)
    if (bps === null) {
      // Unreachable in practice: the row that got here is itself scored. Kept
      // as the "no score yet" guard AD-9 names rather than a thrown error.
      logger.warn({ settlement_id: record.id, listing_id: record.listingId }, 'no scored rows; reputation not written')
      return
    }

    const beforeBps = await deps.store.reputationOf(record.listingId)
    const result = await deps.chain.setReputation({
      settlementId: record.id,
      listingId: record.listingId,
      registryListingId: work.registryListingId,
      bps,
      beforeBps,
    })

    if (result.status === 'confirmed') {
      await deps.store.recordReputation(record.id, result.txHash)
      record.reputationTxHash = result.txHash
      outcome.reputationWrites += 1
      logger.info(
        {
          settlement_id: record.id,
          listing_id: record.listingId,
          tx_hash: result.txHash,
          before_bps: beforeBps,
          after_bps: bps,
          scored_calls: results.filter(isScoredResult).length,
          mode,
        },
        'reputation written on chain',
      )
      return
    }

    if (result.status === 'pending') {
      logger.info({ settlement_id: record.id, tx_hash: result.txHash }, 'reputation write sent; awaiting the receipt')
      return
    }

    outcome.errors += 1
    logger.error(
      { settlement_id: record.id, listing_id: record.listingId, reason: result.reason },
      'reputation write did not land',
    )
  }

  return { run, runForCall }
}

// ---------------------------------------------------------------- helpers

/** Binance caps a klines page at 1 000, which covers both modes' windows. */
export const KLINE_LIMIT = 1_000

export function lowestLow(klines: readonly Kline[]): string | null {
  return extreme(klines.map((kline) => kline.low), -1)
}

export function highestHigh(klines: readonly Kline[]): string | null {
  return extreme(klines.map((kline) => kline.high), 1)
}

/**
 * The extreme of a set of decimal strings, compared as scaled integers so a
 * price with more than six decimal places is neither rounded nor floated.
 */
function extreme(values: readonly string[], direction: 1 | -1): string | null {
  let best: string | null = null
  let bestScaled = 0n
  let width = 0
  for (const value of values) {
    const fraction = value.split('.')[1] ?? ''
    width = Math.max(width, fraction.length)
  }
  for (const value of values) {
    const [whole = '0', fraction = ''] = value.split('.')
    const scaled = BigInt(whole + fraction.padEnd(width, '0'))
    if (best === null || (direction === 1 ? scaled > bestScaled : scaled < bestScaled)) {
      best = value
      bestScaled = scaled
    }
  }
  return best
}

function missingSlashInput(work: SettlementWork): string | null {
  if (!work.registryListingId) return 'the Listing has no registry_listing_id'
  if (!work.refundTo) return 'the Run has no Builder System Wallet to refund'
  return null
}

function empty(mode: PlatformMode): SettlementTickOutcome {
  return { mode, scanned: 0, written: 0, deferred: 0, slashes: 0, reputationWrites: 0, errors: 0 }
}

function logFields(row: SettlementRowPlan): Record<string, unknown> {
  return {
    call_id: row.callId,
    listing_id: row.listingId,
    result: row.result,
    not_scored_reason: row.notScoredReason,
    mode: row.mode,
    rule_label: row.ruleLabel,
    start_price: row.startPrice,
    end_price: row.endPrice,
    change_24h_pct: row.change24hPct,
    p_fill: row.pFill,
    window_min: row.windowMin,
    window_max: row.windowMax,
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
