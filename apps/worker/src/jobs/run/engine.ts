import {
  MAX_PAID_ATTEMPTS,
  RUN_DEADLINE_MS,
  TIMED_OUT,
  assertCallTransition,
  assertRunTransition,
  buildNodeInput,
  buildNotifyInput,
  caseInsensitiveAddressEquals,
  comparePriceLock,
  describeMismatch,
  isPastDeadline,
  isScoredNodeType,
  lockTermsFor,
  nextStep,
  skipReasonFor,
  successStatus,
  type AddressEquals,
  type NotifyCallRecord,
  type RunOutcome,
} from '@agent-desk/core/run'
import type { Clock, Logger, MarketData, ChainReader, Hex } from '@agent-desk/core/ports'
import { silentLogger, systemClock } from '@agent-desk/core/ports'
import type { SigningService } from '@agent-desk/core/signing'
import {
  failedAt,
  validateOutput,
  type AgentType,
  type CallStatus,
  type PriceLockNode,
  type RunExecuteJob,
  type RunStatus,
  type SkipReason,
} from '@agent-desk/schemas'
import { noopRunPublisher } from './publisher.ts'
import type {
  AgentClient,
  CallPatch,
  ExchangeBalance,
  PaidResult,
  RunCallRecord,
  RunPublisher,
  RunRecord,
  RunStore,
  SettlementReceipt,
} from './ports.ts'

/**
 * AD-4: the run engine. The only writer of Run and Call state.
 *
 * The shape is the pipes-and-filters one the spine names: a Run is a linear
 * list of Nodes and every Node passes through the same filters in order — skip
 * decision, deadline check, input, 402, lock check, sign, pay, validate,
 * persist — fed by the previous Node's output. `notify` is not in that list: it
 * is the terminal filter, fed from the whole Run and run on *every* Run end,
 * successful or not.
 *
 * The decisions are all in `@agent-desk/core/run`: what a Node is sent (PRD
 * addendum §1), whether it is skipped at all (FR-24), whether the order passes
 * the two AD-11 guards, and what the Builder is told at the end. This file is
 * the I/O that carries them out.
 *
 * Four invariants hold at every line below:
 *
 *   - a Call's outcome is written *before* the Run's, so when the
 *     compare-and-set on the Run loses — zero rows updated, another writer
 *     ended it — the in-flight Call is already recorded and the engine simply
 *     exits (AD-4);
 *   - nothing is signed twice: `signPayment` writes the authorization and moves
 *     the Call to `paid_awaiting_result` in one transaction (AD-5), so a retry
 *     and a redelivered job both find the header on the row and resend it;
 *   - a skipped Node is never requested and never paid, so its `locked_price`
 *     leaves the AD-3 spend query the moment the row stops being `pending`;
 *   - the 120 s budget is checked before each Node and before each paid retry,
 *     and a Run past it ends `timed out` — but the terminal `notify` filter
 *     still runs, because a Builder who is not told is not served.
 */

export interface RunEngineDeps {
  store: RunStore
  signing: Pick<SigningService, 'signPayment'>
  chain: Pick<ChainReader, 'authorizationUsed'>
  marketData: Pick<MarketData, 'lastPrice'>
  agent: AgentClient
  /** AD-11: `GET /internal/balance` on the execution Agent, read before `risk`. */
  exchangeBalance: ExchangeBalance
  /**
   * AD-9 / Story 2.9: where a `settlement.tick` goes when a scored Call fails
   * after payment. Optional because nothing the engine writes depends on the
   * send landing — the settlement loop re-derives the same work from `calls`
   * left of a `settlements` row — so a caller with no queue drops it.
   */
  publisher?: Pick<RunPublisher, 'settlementTick'>
  clock?: Clock
  logger?: Logger
  /**
   * AD-13 fixes address comparison to viem's `isAddressEqual`; AD-1 keeps viem
   * out of core. The worker passes it in; the default agrees with it for every
   * address the database accepts.
   */
  sameAddress?: AddressEquals
  deadlineMs?: number
  /** AD-9: the reference price is only a reference price within five seconds. */
  referenceTimeoutMs?: number
}

export type RunExecuteOutcome =
  | { outcome: 'not_found'; runId: string }
  /** The Run was already terminal when the job arrived, or ended under us. */
  | { outcome: 'not_running'; runId: string; status: string }
  | { outcome: 'ended'; runId: string; status: RunStatus }
  /** AD-4: the compare-and-set updated zero rows; another writer owns the end. */
  | { outcome: 'lost'; runId: string; status: RunStatus }
  /** A `finalize: true` delivery: only the terminal `notify` filter ran. */
  | { outcome: 'finalized'; runId: string; status: string }

export interface RunEngine {
  execute(job: RunExecuteJob): Promise<RunExecuteOutcome>
}

/** AD-9 / addendum §4: `lastPrice` within five seconds of the Call's success. */
export const REFERENCE_PRICE_TIMEOUT_MS = 5_000

const HEX_TX = /^0x[0-9a-f]{64}$/

/** AD-13: hashes are stored lower-case, and only if they are hashes. */
function normalizeTxHash(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null
  const lower = value.toLowerCase()
  return HEX_TX.test(lower) ? lower : null
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** What one Node did, as the driver has to branch on it. */
type CallResult =
  | { kind: 'succeeded' }
  | { kind: 'failed'; reason: string }
  | { kind: 'timed_out'; reason: string }

export function createRunEngine(deps: RunEngineDeps): RunEngine {
  const clock = deps.clock ?? systemClock
  const logger = deps.logger ?? silentLogger
  const sameAddress = deps.sameAddress ?? caseInsensitiveAddressEquals
  const publisher = deps.publisher ?? noopRunPublisher(logger)
  const deadlineMs = deps.deadlineMs ?? RUN_DEADLINE_MS
  const referenceTimeoutMs = deps.referenceTimeoutMs ?? REFERENCE_PRICE_TIMEOUT_MS

  // ------------------------------------------------------------ Call writes

  /** Every Call write goes through the machine's transition table first. */
  async function writeCall(call: RunCallRecord, status: CallStatus, patch: CallPatch): Promise<void> {
    assertCallTransition(call.status, status)
    await deps.store.updateCall(call.callId, { ...patch, status })
  }

  /**
   * Story 2.9 / AD-9: a `research` or `risk` Call that ended `failed_after_payment`
   * is scored immediately, with no window — the Builder paid for an answer that
   * was never usable, and Epic 4 does not have to wait 60 minutes to say so.
   *
   * The send is best-effort by design and by AD-9: the settlement loop selects
   * the same Calls from `calls` left of a `settlements` row on every tick, so a
   * dropped tick costs latency, never a missing Settlement. A failing publish
   * must therefore never turn a recorded Call outcome into a failed job.
   */
  async function publishSettlementTick(call: RunCallRecord): Promise<void> {
    if (!isScoredNodeType(call.nodeType)) return
    try {
      await publisher.settlementTick(call.callId)
    } catch (error) {
      logger.warn(
        { call_id: call.callId, node_type: call.nodeType, error: (error as Error).message },
        'settlement tick publish failed; the settlement loop will recover this Call',
      )
    }
  }

  /** A refusal before anything is signed: the Call is `payment_failed`, unpaid. */
  async function refuseCall(call: RunCallRecord, reason: string): Promise<CallResult> {
    const at = clock.now()
    await writeCall(call, 'payment_failed', { failureReason: reason, startedAt: at, endedAt: at })
    logger.warn(
      { call_id: call.callId, node_type: call.nodeType, reason },
      'call refused before payment',
    )
    return { kind: 'failed', reason }
  }

  // ------------------------------------------------------------- Run writes

  /**
   * AD-4: compare-and-set from `running`. The caller has already written the
   * Call, so a lost write needs nothing but a log line and an exit.
   */
  async function endRun(
    run: RunRecord,
    status: RunStatus,
    failureReason: string | null,
  ): Promise<RunExecuteOutcome> {
    assertRunTransition('running', status)
    const at = clock.now()
    const applied = await deps.store.endRun(run.id, status, at, failureReason)
    if (!applied) {
      logger.warn({ run_id: run.id, status }, 'run status write lost; another writer ended the Run')
      return { outcome: 'lost', runId: run.id, status }
    }
    // AD-4: at Run end every still-`pending` Call becomes `skipped`. The winner
    // of the compare-and-set is the one that owns the sweep.
    const skipped = await deps.store.skipPendingCalls(run.id, 'not_reached', at)
    logger.info({ run_id: run.id, status, skipped }, 'run ended')
    return { outcome: 'ended', runId: run.id, status }
  }

  // ------------------------------------------------------------- reference

  /** AD-9: null on any failure, and null when the read outran its five seconds. */
  async function readReferencePrice(symbol: string): Promise<{ price: string; at: Date } | null> {
    const startedAt = clock.now()
    try {
      const price = await withTimeout(deps.marketData.lastPrice(symbol), referenceTimeoutMs)
      const at = clock.now()
      if (at.getTime() - startedAt.getTime() > referenceTimeoutMs) return null
      return { price, at }
    } catch (error) {
      logger.warn({ symbol, error: (error as Error).message }, 'reference price read failed')
      return null
    }
  }

  // --------------------------------------------------------------- helpers

  function lockNodeFor(run: RunRecord, call: RunCallRecord): PriceLockNode | undefined {
    return run.priceLock.nodes.find((node) => node.node_index === call.nodeIndex)
  }

  /** Outputs of the Nodes already `succeeded`, for the addendum §1 mapping. */
  function outputsOf(run: RunRecord): Partial<Record<AgentType, unknown>> {
    const outputs: Partial<Record<AgentType, unknown>> = {}
    for (const call of run.calls) {
      if (call.status === 'succeeded') outputs[call.nodeType] = call.response
    }
    return outputs
  }

  /** The Run's Calls as the terminal filter reads them. */
  function notifyCallsOf(run: RunRecord): NotifyCallRecord[] {
    return run.calls.map((call) => ({
      nodeIndex: call.nodeIndex,
      nodeType: call.nodeType,
      provider: call.provider,
      lockedPrice: call.lockedPrice,
      status: call.status,
      paymentTxHash: call.paymentTxHash,
      skipReason: call.skipReason,
      response: call.response,
    }))
  }

  /**
   * AD-11: `balance_usdt` comes from the execution Agent's `GET /internal/balance`,
   * read just before the `risk` Node and never cached. A failed read is not a
   * reason to guess a balance the risk Agent would size against, so it becomes
   * the refusal the criteria name.
   */
  async function readBalance(run: RunRecord): Promise<string | null> {
    try {
      const balance = await deps.exchangeBalance.balanceUsdt()
      logger.debug({ run_id: run.id, balance_usdt: balance }, 'exchange balance read')
      return balance
    } catch (error) {
      logger.warn(
        { run_id: run.id, error: (error as Error).message },
        'exchange balance read failed',
      )
      return null
    }
  }

  // --------------------------------------------------------------- the Node

  /** FR-24: a Node the chain no longer needs. Never requested, never paid. */
  async function skipCall(call: RunCallRecord, reason: SkipReason): Promise<void> {
    assertCallTransition(call.status, 'skipped')
    await deps.store.skipCall(call.callId, reason, clock.now())
    logger.info(
      { call_id: call.callId, node_type: call.nodeType, skip_reason: reason },
      'node skipped; nothing requested and nothing paid',
    )
  }

  /**
   * A `pending` Call with its input already built: the 402, the Price Lock
   * comparison, the signature, and the paid request. Used by both the chain
   * Nodes and the terminal `notify` filter, so there is one payment path.
   */
  async function startNode(
    run: RunRecord,
    call: RunCallRecord,
    input: unknown,
    options: { enforceDeadline: boolean },
  ): Promise<CallResult> {
    const lockNode = lockNodeFor(run, call)
    if (!lockNode) {
      return refuseCall(call, `the Price Lock has no entry for node ${call.nodeIndex}`)
    }

    await deps.store.updateCall(call.callId, { request: input, startedAt: clock.now() })

    // 1. The unpaid request. 15 s; the 402 is the answer we expect.
    const unpaid = await deps.agent.requestUnpaid(call.endpoint, input)
    if (unpaid.kind !== 'payment_required') {
      const reason =
        unpaid.kind === 'timeout'
          ? 'the unpaid request timed out after 15 s'
          : unpaid.kind === 'transport'
            ? `the unpaid request failed: ${unpaid.detail}`
            : `the Agent answered ${unpaid.status} instead of 402: ${unpaid.detail}`
      await writeCall(call, 'payment_failed', { failureReason: reason, endedAt: clock.now() })
      return { kind: 'failed', reason }
    }

    // AD-3: every 402 payload received is recorded, matching or not.
    await deps.store.updateCall(call.callId, { paymentRequired: unpaid.payload })

    // 2. The Price Lock comparison. Nothing is signed until it passes.
    const comparison = comparePriceLock(lockTermsFor(lockNode), unpaid.payload.accepts, sameAddress)
    if (!comparison.ok) {
      const reason = describeMismatch(comparison.mismatch)
      logger.warn(
        { run_id: run.id, call_id: call.callId, field: comparison.mismatch.field },
        'price lock mismatch; paying nothing',
      )
      await writeCall(call, 'price_mismatch', { failureReason: reason, endedAt: clock.now() })
      return { kind: 'failed', reason }
    }

    // 3. The signature, through the AD-5 policy. This is the write that moves
    //    the Call to `paid_awaiting_result`, in one transaction with the payload.
    const signed = await deps.signing.signPayment(run.walletId, {
      scheme: comparison.entry.scheme,
      network: comparison.entry.network,
      asset: comparison.entry.asset,
      amount: comparison.entry.amount,
      payTo: comparison.entry.payTo,
      maxTimeoutSeconds: comparison.entry.maxTimeoutSeconds,
      extra: comparison.extra,
      call: {
        callId: call.callId,
        kind: 'run',
        accountId: run.accountId,
        listingId: call.listingId,
        nodeType: call.nodeType,
      },
    })
    if (!signed.ok) {
      const reason = signed.refusal.message
      await writeCall(call, 'payment_failed', { failureReason: reason, endedAt: clock.now() })
      return { kind: 'failed', reason }
    }

    // The row is `paid_awaiting_result` now, so the paid attempts run against a
    // freshly read Call: the same state a redelivered job would find.
    return payNode(
      run,
      { ...call, status: 'paid_awaiting_result', hasPaymentPayload: true },
      input,
      signed.header,
      options,
    )
  }

  /**
   * A Call that is `paid_awaiting_result` with attempts left. Reached both from
   * `startNode` and from a `run.execute` redelivered after a crash; the stored
   * header and the stored request are the same in either case (AD-4, AD-6).
   */
  async function resendNode(run: RunRecord, call: RunCallRecord): Promise<CallResult> {
    const payload = await deps.store.readPaymentPayload(call.callId)
    if (!payload) {
      // `nextStep` only chooses `resend` when the row says it has a payload, so
      // this is a torn row rather than a normal path; AD-6 resolves it.
      const resolved = await resolveCall(call, 'the Call carries no payment authorization')
      return { kind: 'failed', reason: resolved.reason }
    }
    return payNode(run, call, call.request, payload.header, { enforceDeadline: true })
  }

  /**
   * AD-6: at most two paid attempts with the same header, the second only after
   * a timeout. Anything else ends the attempts, because a 5xx from the
   * middleware means the handler failed and nothing was settled.
   */
  async function payNode(
    run: RunRecord,
    call: RunCallRecord,
    input: unknown,
    header: string,
    options: { enforceDeadline: boolean },
  ): Promise<CallResult> {
    let attempt = call.attempt
    let result: PaidResult | null = null

    while (attempt < MAX_PAID_ATTEMPTS) {
      // AD-4: the deadline is checked before each paid retry as well as before
      // each Node, so a Run cannot spend a second 15 s window past its budget.
      // The terminal `notify` filter is exempt: it runs *because* the Run has
      // ended, so its own retry cannot be refused on the Run's budget.
      if (options.enforceDeadline && attempt > 0 && isPastDeadline(run.startedAt, clock.now(), deadlineMs)) {
        // The first attempt timed out, so whether the transfer landed is exactly
        // the question AD-6 answers from the chain. Resolve the Call truthfully,
        // then end the Run on the budget rather than on the Node.
        await resolveCall({ ...call, attempt }, 'the Run budget expired before the paid retry')
        return { kind: 'timed_out', reason: timeoutReason() }
      }
      attempt += 1
      await deps.store.updateCall(call.callId, { attempt })
      result = await deps.agent.requestPaid(call.endpoint, input, header)
      logger.info(
        { run_id: run.id, call_id: call.callId, attempt, outcome: result.kind },
        'paid request attempted',
      )
      if (result.kind !== 'timeout') break
    }

    const attempted: RunCallRecord = { ...call, attempt }

    if (result?.kind === 'ok' && result.settlement) {
      return settleNode(run, attempted, input, result.body, result.settlement)
    }

    // AD-6: no `PAYMENT-RESPONSE` from either attempt. The chain decides which
    // of the two failure statuses is the truthful one.
    const resolved = await resolveCall(attempted, describePaidFailure(result, attempt))
    return { kind: 'failed', reason: resolved.reason }
  }

  function timeoutReason(): string {
    return `the Run exceeded its ${deadlineMs / 1000} s budget`
  }

  function describePaidFailure(result: PaidResult | null, attempt: number): string {
    const attempts = attempt === 1 ? 'the paid attempt' : `both paid attempts (${attempt})`
    if (!result) return 'no paid attempt was made'
    switch (result.kind) {
      case 'timeout':
        return `${attempts} timed out after 15 s`
      case 'transport':
        return `the paid request failed: ${result.detail}`
      case 'error':
        return `the Agent answered ${result.status}: ${result.detail}`
      case 'ok':
        return `the Agent answered ${result.status} with no PAYMENT-RESPONSE header`
    }
  }

  /** A settled 200: validate, record the receipt, and take a reference price. */
  async function settleNode(
    run: RunRecord,
    call: RunCallRecord,
    input: unknown,
    body: unknown,
    settlement: SettlementReceipt,
  ): Promise<CallResult> {
    const txHash = normalizeTxHash(settlement.transaction)
    const checked = validateOutput(call.nodeType, input, body)

    if (!checked.ok) {
      // FR-27: paid, settled, and the output is not the Type's. The payment is
      // real, so the hash stays on the row for Epic 4 to slash against.
      const reason = `the paid response failed output validation: ${checked.error}${
        checked.path ? ` at ${checked.path}` : ''
      }`
      await writeCall(call, 'failed_after_payment', {
        response: body,
        paymentTxHash: txHash,
        attempt: call.attempt,
        failureReason: reason,
        endedAt: clock.now(),
      })
      await publishSettlementTick(call)
      return { kind: 'failed', reason }
    }

    const reference = await readReferencePrice(run.symbol)
    await writeCall(call, 'succeeded', {
      response: checked.value,
      paymentTxHash: txHash,
      attempt: call.attempt,
      referencePrice: reference?.price ?? null,
      referenceAt: reference?.at ?? null,
      failureReason: null,
      endedAt: clock.now(),
    })
    logger.info(
      { run_id: run.id, call_id: call.callId, tx_hash: txHash, attempt: call.attempt },
      'call succeeded',
    )
    return { kind: 'succeeded' }
  }

  /**
   * AD-6: when the paid attempts end without a `PAYMENT-RESPONSE`, read
   * `tUSD.authorizationState(from, nonce)` from the stored payload. Unused means
   * nothing was ever spent (`payment_failed`); used means the transfer landed
   * and only its hash is unknown (`failed_after_payment`, hash null).
   *
   * This writes the Call and nothing else: the caller decides whether the Run
   * ends `failed at <Node>` or `timed out`, because the same Call outcome can be
   * reached by either route.
   */
  async function resolveCall(
    call: RunCallRecord,
    detail: string,
  ): Promise<{ status: CallStatus; reason: string }> {
    const payload = await deps.store.readPaymentPayload(call.callId)
    if (!payload) {
      const reason = `${detail}; no payment authorization was recorded for this Call`
      await writeCall(call, 'payment_failed', {
        attempt: call.attempt,
        failureReason: reason,
        endedAt: clock.now(),
      })
      return { status: 'payment_failed', reason }
    }

    // A failed read must not be guessed at in either direction: recording an
    // unused authorization as paid would hold budget for nothing, and recording
    // a used one as unpaid would lose a real payment. Letting it throw fails the
    // job, so pg-boss redelivers it and the resume path reads the chain again.
    const used = await deps.chain.authorizationUsed(payload.from, payload.nonce as Hex)

    if (used) {
      const reason = `${detail}; the tUSD authorization is used, so the payment landed with an unknown hash`
      await writeCall(call, 'failed_after_payment', {
        paymentTxHash: null,
        attempt: call.attempt,
        failureReason: reason,
        endedAt: clock.now(),
      })
      await publishSettlementTick(call)
      return { status: 'failed_after_payment', reason }
    }

    const reason = `${detail}; the tUSD authorization is unused, so nothing was paid`
    await writeCall(call, 'payment_failed', {
      attempt: call.attempt,
      failureReason: reason,
      endedAt: clock.now(),
    })
    return { status: 'payment_failed', reason }
  }

  // ------------------------------------------------------ the chain filters

  /** One chain Node: skip decision, then input, then payment. */
  async function runChainNode(run: RunRecord, call: RunCallRecord): Promise<CallResult> {
    const outputs = outputsOf(run)

    const skip = skipReasonFor(call.nodeType, outputs)
    if (skip) {
      await skipCall(call, skip)
      return { kind: 'succeeded' }
    }

    // AD-11: read just before the `risk` Node, and only for it.
    const balanceUsdt = call.nodeType === 'risk' ? await readBalance(run) : null

    const built = buildNodeInput({
      nodeType: call.nodeType,
      symbol: run.symbol,
      outputs,
      orderCapUsdt: run.orderCapUsdt,
      balanceUsdt,
    })
    if (!built.ok) return refuseCall(call, built.reason)

    return startNode(run, call, built.input, { enforceDeadline: true })
  }

  // ----------------------------------------------------- the terminal filter

  /**
   * AD-4: `notify` runs on every Run end. It is deliberately outside the chain
   * loop — a failed, timed-out or skipped-to-the-end Run reaches it just the
   * same, and it is paid at its locked price like any other Node.
   *
   * Returns the reason the filter failed, or null when it delivered or when the
   * Workflow has no `notify` Node.
   */
  async function runNotifyFilter(
    run: RunRecord,
    outcome: RunOutcome,
  ): Promise<{ reason: string } | null> {
    const call = run.calls.find((candidate) => candidate.nodeType === 'notify')
    if (!call) return null
    if (call.status !== 'pending') {
      // A redelivered job, or the sweep's `finalize`, arriving after the filter
      // already ran. One Run, one message.
      logger.info(
        { run_id: run.id, call_id: call.callId, status: call.status },
        'notify filter already ran for this Run',
      )
      return null
    }

    const built = buildNotifyInput({
      runId: run.id,
      symbol: run.symbol,
      telegramChatId: run.telegramChatId,
      calls: notifyCallsOf(run),
      outcome,
    })
    if (!built.ok) {
      await refuseCall(call, built.reason)
      return { reason: built.reason }
    }

    const result = await startNode(run, call, built.input, { enforceDeadline: false })
    if (result.kind === 'succeeded') return null
    return { reason: result.reason }
  }

  /**
   * The one place a Run ends: reload so the terminal filter sees every Call as
   * it finished, notify, then compare-and-set the Run status.
   *
   * AD-4: a `notify` failure ends a still-running Run `failed at notify`, while
   * a Run that already failed or timed out keeps its status and the Call
   * carries the failure.
   */
  async function finish(run: RunRecord, outcome: RunOutcome): Promise<RunExecuteOutcome> {
    const fresh = (await deps.store.load(run.id)) ?? run
    const notifyFailure = await runNotifyFilter(fresh, outcome)

    if (outcome.kind === 'failed') {
      return endRun(fresh, failedAt(outcome.node), outcome.reason)
    }
    if (outcome.kind === 'timed_out') {
      return endRun(fresh, TIMED_OUT, outcome.reason)
    }
    if (notifyFailure) {
      return endRun(fresh, failedAt('notify'), notifyFailure.reason)
    }
    return endRun(
      fresh,
      successStatus({
        hasExecutionNode: fresh.nodeTypes.includes('execution'),
        executionFilled: isExecutionFilled(fresh),
      }),
      null,
    )
  }

  /**
   * AD-4: the sweep ends the Run itself and then publishes
   * `run.execute { finalize: true }`, on which the engine runs only the
   * terminal filter. The Run status is already terminal and is never rewritten.
   */
  async function finalize(run: RunRecord): Promise<RunExecuteOutcome> {
    const outcome = outcomeOfStatus(run.status, run.failureReason)
    await runNotifyFilter(run, outcome)
    await deps.store.skipPendingCalls(run.id, 'not_reached', clock.now())
    return { outcome: 'finalized', runId: run.id, status: run.status }
  }

  // ------------------------------------------------------------- the driver

  async function execute(job: RunExecuteJob): Promise<RunExecuteOutcome> {
    const loaded = await deps.store.load(job.run_id)
    if (!loaded) {
      logger.warn({ run_id: job.run_id }, 'run.execute for a Run that does not exist')
      return { outcome: 'not_found', runId: job.run_id }
    }
    if (job.finalize === true) return finalize(loaded)
    if (loaded.status !== 'running') {
      logger.info({ run_id: loaded.id, status: loaded.status }, 'run.execute for a Run already ended')
      return { outcome: 'not_running', runId: loaded.id, status: loaded.status }
    }

    // AD-4: the worker sets `started_at` at pickup, and only if it is still null,
    // so a redelivery never restarts the 120 s budget.
    const startedAt = await deps.store.markStarted(loaded.id, clock.now())
    let run: RunRecord = { ...loaded, startedAt }

    // Every iteration either moves a Call to a new status or ends the Run, so
    // this bound can only be reached by a bug; reaching it must not spin.
    const maxIterations = run.calls.length * (MAX_PAID_ATTEMPTS + 2) + 4
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      // The terminal filter is not part of the chain: it runs from `finish`.
      const chain = run.calls.filter((call) => call.nodeType !== 'notify')
      const step = nextStep({ calls: chain })

      if (step.kind === 'finish') return finish(run, { kind: 'success' })

      // AD-4: before each Node.
      if (isPastDeadline(run.startedAt, clock.now(), deadlineMs)) {
        return finish(run, { kind: 'timed_out', reason: timeoutReason() })
      }

      const call = run.calls.find((candidate) => candidate.callId === step.call.callId)
      if (!call) throw new Error(`run ${run.id} lost call ${step.call.callId} between steps`)

      const result =
        step.kind === 'call'
          ? await runChainNode(run, call)
          : step.kind === 'resend'
            ? await resendNode(run, call)
            : await resolveStep(call)

      if (result.kind === 'failed') {
        return finish(run, { kind: 'failed', node: call.nodeType, reason: result.reason })
      }
      if (result.kind === 'timed_out') {
        return finish(run, { kind: 'timed_out', reason: result.reason })
      }

      const reloaded = await deps.store.load(run.id)
      if (!reloaded) return { outcome: 'not_found', runId: run.id }
      if (reloaded.status !== 'running') {
        // Another writer — the timeout sweep, most likely — ended the Run while
        // this Node was in flight. The Call is already recorded, and the sweep's
        // own `finalize` delivery owns the terminal filter; exit.
        logger.warn(
          { run_id: run.id, status: reloaded.status },
          'the Run ended under the engine; the in-flight Call is recorded',
        )
        return { outcome: 'not_running', runId: run.id, status: reloaded.status }
      }
      run = reloaded
    }

    throw new Error(`run ${run.id} did not settle within ${maxIterations} engine steps`)
  }

  /** The `resolve` step of the machine: record the Call, then stop the chain. */
  async function resolveStep(call: RunCallRecord): Promise<CallResult> {
    const resolved = await resolveCall(call, 'the paid attempts ended without a PAYMENT-RESPONSE')
    return { kind: 'failed', reason: resolved.reason }
  }

  return { execute }
}

/** AD-4: a Run completes only when its `execution` Call came back `FILLED`. */
function isExecutionFilled(run: RunRecord): boolean {
  const execution = run.calls.find((call) => call.nodeType === 'execution')
  if (!execution || execution.status !== 'succeeded') return false
  const status = (execution.response as { status?: unknown } | null)?.status
  return status === 'FILLED'
}

/** The terminal status of a Run, read back as the outcome the summary needs. */
function outcomeOfStatus(status: string, failureReason: string | null): RunOutcome {
  if (status === TIMED_OUT) {
    return { kind: 'timed_out', reason: failureReason ?? 'the Run timed out' }
  }
  if (status.startsWith('failed at ')) {
    return {
      kind: 'failed',
      node: status.slice('failed at '.length),
      reason: failureReason ?? 'the Run failed',
    }
  }
  return { kind: 'success' }
}
