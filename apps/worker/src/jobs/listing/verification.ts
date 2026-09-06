import {
  MAX_PAID_ATTEMPTS,
  caseInsensitiveAddressEquals,
  comparePriceLock,
  type AddressEquals,
  type LockTerms,
  type PriceLockMismatch,
} from '@agent-desk/core/run'
import type { ChainReader, Clock, Hex, Logger } from '@agent-desk/core/ports'
import { silentLogger, systemClock } from '@agent-desk/core/ports'
import type { SigningService } from '@agent-desk/core/signing'
import type {
  ListingPipelineRow,
  VerificationCall,
  VerificationOutcome,
} from '@agent-desk/core/listing'
import {
  X402_SCHEME,
  newId,
  samples,
  toDecimalUsdt,
  validateOutput,
  type AgentType,
  type CallStatus,
  type X402Config,
} from '@agent-desk/schemas'
import type { AgentClient, PaidResult, SettlementReceipt } from '../run/ports.ts'
import type { VerificationCallRow, VerificationCallStore } from './verification-ports.ts'

/**
 * Story 3.4 / FR-11 / FR-12 / AD-2: the paid verification Call the platform
 * makes before an identity is minted and before any Stake is locked.
 *
 * This is the Story 1.7 seam filled in. The pipeline in `packages/core/listing`
 * is unchanged: it still calls `VerificationCall.run(listing)` first, still
 * refuses to touch the chain when the answer is not `ok`, and still writes the
 * reason verbatim to `listings.last_error`.
 *
 * The Handshake is the engine's Handshake (AD-6), deliberately down to the
 * imports: the same `AgentClient` from `../run/agent-client.ts`, the same
 * `comparePriceLock` from `packages/core/run`, the same `signPayment` from
 * `core/signing`, the same `validateOutput`. A second implementation of the
 * x402 wire is precisely what AD-6 exists to prevent, and a verification that
 * accepted a 402 the engine would reject would pass an Agent that no Run could
 * then pay.
 *
 * Two things differ from a Run Call, and both are deliberate:
 *
 *   - the payer is the **Platform Wallet**, and the Call is `kind =
 *     'verification'`, so the policy inside the signing lock checks the Platform
 *     Wallet's 24 h verification cap instead of any account's Daily Fee Budget;
 *   - a verification Call is **never scored and never reserves Stake**. That is
 *     not an omission here — `evaluatePaymentPolicy` in `core/signing` returns
 *     after the cap check for this kind, and AD-9 scores `research` and `risk`
 *     Calls of `kind = 'run'` only. A brand-new Listing whose first Call is its
 *     own verification must not be slashable for it.
 *
 * The Call row is inserted before the endpoint is touched and reaches a terminal
 * status on every path, so `GET /api/listings/<id>` can narrate the step and
 * FR-40 counts the payment exactly once.
 */

/** FR-11: the wording the Creator sees when the Platform Wallet is out of budget. */
export const VERIFICATION_CAP_REACHED = 'verification cap reached, try again tomorrow'

export interface VerificationCallDeps {
  store: VerificationCallStore
  /** AD-5: the Platform Wallet signs; the policy checks the cap inside the lock. */
  signing: Pick<SigningService, 'signPayment'>
  /** AD-6: `unused` means the payment never landed, so the Call was not paid. */
  chain: Pick<ChainReader, 'authorizationUsed'>
  agent: AgentClient
  /** AD-6: the one binding, from `buildX402Config`. */
  x402: X402Config
  /**
   * Addendum §1: the `notify` sample is sent with `recipient.address` replaced
   * by the Platform chat id, so verifying a `notify` Agent delivers a real
   * message to the Platform chat rather than to the placeholder in `samples`.
   */
  platformChatId?: string | undefined
  clock?: Clock
  logger?: Logger
  /** AD-13 fixes address comparison to viem's `isAddressEqual`; AD-1 keeps it out of core. */
  sameAddress?: AddressEquals
}

export function createVerificationCall(deps: VerificationCallDeps): VerificationCall {
  const clock = deps.clock ?? systemClock
  const logger = deps.logger ?? silentLogger
  const sameAddress = deps.sameAddress ?? caseInsensitiveAddressEquals

  return {
    async run(listing: ListingPipelineRow): Promise<VerificationOutcome> {
      const existing = await deps.store.findForListing(listing.id)

      // A redelivery that already has its answer. `succeeded` is the whole job
      // done; a terminal failure is terminal for this Listing — FR-12's "fix and
      // resubmit" opens the form pre-filled and creates a new one — so neither
      // pays a second time.
      if (existing && isTerminal(existing.status)) {
        if (existing.status === 'succeeded') {
          logger.info(
            { listing_id: listing.id, call_id: existing.id },
            'verification Call already succeeded; not paying twice',
          )
          return { ok: true, callId: existing.id }
        }
        return {
          ok: false,
          reason: existing.failureReason ?? 'the verification Call failed',
        }
      }

      // FR-11: the cap, before the endpoint is touched. The authoritative check
      // is `checkVerificationCap` inside the signing lock (AD-5) and it runs
      // again below; this one only spares a doomed listing an HTTP round trip
      // and gives it the same sentence either way.
      const usage = await deps.store.capUsage(clock.now())
      const price = BigInt(listing.declaredPrice)
      if (usage.spent + price > usage.cap) {
        logger.warn(
          {
            listing_id: listing.id,
            spent: usage.spent.toString(),
            cap: usage.cap.toString(),
            price: listing.declaredPrice,
          },
          'verification refused: the Platform Wallet cap is exhausted',
        )
        return { ok: false, reason: VERIFICATION_CAP_REACHED }
      }

      const call = existing ?? (await insertCall(listing))

      // AD-4's resume rule, applied to this one Call: an authorization that was
      // signed but whose result never arrived is resent with the stored header,
      // never re-signed (AD-5, FR-25).
      if (call.status === 'paid_awaiting_result') {
        return resumePaid(listing, call)
      }
      return startCall(listing, call)
    },
  }

  // ------------------------------------------------------------- the Call

  async function insertCall(listing: ListingPipelineRow): Promise<VerificationCallRow> {
    const id = newId('call')
    const request = verificationInput(listing.type, deps.platformChatId)
    await deps.store.insert({
      id,
      listingId: listing.id,
      nodeType: listing.type,
      // AD-3: the declared price and the declared payout wallet are the terms
      // the 402 has to restate; nothing is read back from the Listing later.
      lockedPrice: listing.declaredPrice,
      lockedPayTo: listing.payoutWallet.toLowerCase(),
      lockedAsset: deps.x402.asset.toLowerCase(),
      lockedNetwork: deps.x402.network,
      request,
      startedAt: clock.now(),
    })
    logger.info(
      { listing_id: listing.id, call_id: id, endpoint: listing.endpoint },
      'verification Call opened',
    )
    return {
      id,
      status: 'pending',
      attempt: 0,
      request,
      failureReason: null,
      paymentTxHash: null,
      hasPaymentPayload: false,
    }
  }

  /** Unpaid POST, compare, sign, pay — the engine's order, filter for filter. */
  async function startCall(
    listing: ListingPipelineRow,
    call: VerificationCallRow,
  ): Promise<VerificationOutcome> {
    const input = call.request

    const unpaid = await deps.agent.requestUnpaid(listing.endpoint, input)
    if (unpaid.kind !== 'payment_required') {
      const reason =
        unpaid.kind === 'timeout'
          ? NO_RESPONSE
          : unpaid.kind === 'transport'
            ? `the endpoint could not be reached: ${unpaid.detail}`
            : `endpoint answered ${unpaid.status} instead of 402`
      return fail(call, 'payment_failed', reason)
    }

    // AD-3: every 402 payload received is recorded, matching or not.
    await deps.store.update(call.id, { paymentRequired: unpaid.payload })

    const comparison = comparePriceLock(lockTerms(listing), unpaid.payload.accepts, sameAddress)
    if (!comparison.ok) {
      return fail(call, 'price_mismatch', describeVerificationMismatch(comparison.mismatch, listing))
    }

    // AD-5: this write moves the Call to `paid_awaiting_result` in the same
    // transaction as the authorization, so nothing below can sign twice.
    const walletId = await deps.store.platformWalletId()
    const signed = await deps.signing.signPayment(walletId, {
      scheme: comparison.entry.scheme,
      network: comparison.entry.network,
      asset: comparison.entry.asset as `0x${string}`,
      amount: comparison.entry.amount,
      payTo: comparison.entry.payTo as `0x${string}`,
      maxTimeoutSeconds: comparison.entry.maxTimeoutSeconds,
      extra: comparison.extra,
      call: {
        callId: call.id,
        kind: 'verification',
        // AD-3: no account — the Platform Wallet pays, against its own cap.
        accountId: null,
        listingId: listing.id,
        nodeType: listing.type,
      },
    })
    if (!signed.ok) {
      return fail(call, 'payment_failed', signed.refusal.message)
    }

    return pay(listing, { ...call, status: 'paid_awaiting_result' }, input, signed.header)
  }

  /** A Call whose authorization exists but whose result never arrived. */
  async function resumePaid(
    listing: ListingPipelineRow,
    call: VerificationCallRow,
  ): Promise<VerificationOutcome> {
    const payload = await deps.store.readPaymentPayload(call.id)
    if (!payload) {
      // `paid_awaiting_result` without a payload is a torn row, not a path.
      return resolveUnsettled(call, 'the Call carries no payment authorization')
    }
    if (call.attempt >= MAX_PAID_ATTEMPTS) {
      return resolveUnsettled(call, `both paid attempts (${call.attempt}) ended without a result`)
    }
    return pay(listing, call, call.request, payload.header)
  }

  /**
   * AD-6: at most two paid attempts with the same header, the second only after
   * a timeout. Anything else ends the attempts — a 5xx from the middleware means
   * the handler failed and nothing was settled.
   */
  async function pay(
    listing: ListingPipelineRow,
    call: VerificationCallRow,
    input: unknown,
    header: string,
  ): Promise<VerificationOutcome> {
    let attempt = call.attempt
    let result: PaidResult | null = null

    while (attempt < MAX_PAID_ATTEMPTS) {
      attempt += 1
      await deps.store.update(call.id, { attempt })
      result = await deps.agent.requestPaid(listing.endpoint, input, header)
      logger.info(
        { listing_id: listing.id, call_id: call.id, attempt, outcome: result.kind },
        'verification paid request attempted',
      )
      if (result.kind !== 'timeout') break
    }

    const attempted: VerificationCallRow = { ...call, attempt }
    if (result?.kind === 'ok' && result.settlement) {
      return settle(listing, attempted, input, result.body, result.settlement)
    }
    return resolveUnsettled(attempted, describePaidFailure(result, attempt))
  }

  /** A settled 200: the Type's own output schema is the last gate (AD-7, FR-15). */
  async function settle(
    listing: ListingPipelineRow,
    call: VerificationCallRow,
    input: unknown,
    body: unknown,
    settlement: SettlementReceipt,
  ): Promise<VerificationOutcome> {
    const txHash = normaliseTxHash(settlement.transaction)
    const checked = validateOutput(listing.type, input, body)

    if (!checked.ok) {
      // Paid, settled, and the answer is not the Type's. The payment is real, so
      // the hash stays on the row; the Listing is refused all the same.
      await deps.store.update(call.id, {
        status: 'failed_after_payment',
        response: body,
        paymentTxHash: txHash,
        attempt: call.attempt,
        failureReason: schemaFailure(listing.type, checked.error, checked.path),
        endedAt: clock.now(),
      })
      return { ok: false, reason: schemaFailure(listing.type, checked.error, checked.path) }
    }

    await deps.store.update(call.id, {
      status: 'succeeded',
      response: checked.value,
      paymentTxHash: txHash,
      attempt: call.attempt,
      failureReason: null,
      endedAt: clock.now(),
    })
    logger.info(
      { listing_id: listing.id, call_id: call.id, tx_hash: txHash },
      'verification Call succeeded and was paid',
    )
    return { ok: true, callId: call.id }
  }

  /**
   * AD-6: both paid attempts ended without a `PAYMENT-RESPONSE`. Whether the
   * transfer landed is a question only the token can answer, so it is asked:
   * `unused` is `payment_failed`, `used` is `failed_after_payment` with a null
   * hash. Guessing here would either invent a payment or hide a real one.
   */
  async function resolveUnsettled(
    call: VerificationCallRow,
    reason: string,
  ): Promise<VerificationOutcome> {
    const payload = await deps.store.readPaymentPayload(call.id)
    let status: CallStatus = 'payment_failed'
    if (payload) {
      try {
        const used = await deps.chain.authorizationUsed(payload.from, payload.nonce as Hex)
        status = used ? 'failed_after_payment' : 'payment_failed'
      } catch (error) {
        // An RPC that will not answer must not turn into a claim about money.
        logger.warn(
          { call_id: call.id, error: message(error) },
          'could not read authorizationState; recording the Call as payment_failed',
        )
      }
    }
    return fail(call, status, reason)
  }

  async function fail(
    call: VerificationCallRow,
    status: CallStatus,
    reason: string,
  ): Promise<VerificationOutcome> {
    await deps.store.update(call.id, {
      status,
      failureReason: reason,
      attempt: call.attempt,
      endedAt: clock.now(),
    })
    logger.warn({ call_id: call.id, status, reason }, 'verification Call failed')
    return { ok: false, reason }
  }

  /** AD-6: the terms the 402 has to restate, from the declared values. */
  function lockTerms(listing: ListingPipelineRow): LockTerms {
    return {
      scheme: X402_SCHEME,
      network: deps.x402.network,
      asset: deps.x402.asset,
      amount: listing.declaredPrice,
      payTo: listing.payoutWallet,
      maxTimeoutSeconds: deps.x402.maxTimeoutSeconds,
    }
  }
}

// ------------------------------------------------------------------ wording

/**
 * FR-12: `listings.last_error` is shown to the Creator verbatim, so each of
 * these names one thing to change. The three that quote a number quote both,
 * because "your price is wrong" without the two prices is not actionable.
 */
export const NO_RESPONSE = 'no response within 15 s'

export function describeVerificationMismatch(
  mismatch: PriceLockMismatch,
  listing: Pick<ListingPipelineRow, 'declaredPrice' | 'payoutWallet'>,
): string {
  switch (mismatch.field) {
    case 'amount':
      return (
        `402 amount ${usdt(mismatch.actual)} differs from declared ` +
        `${usdt(listing.declaredPrice)}`
      )
    case 'pay_to':
      return (
        `402 payTo ${mismatch.actual} differs from declared payout wallet ` +
        `${listing.payoutWallet}`
      )
    case 'max_timeout_seconds':
      return `402 maxTimeoutSeconds ${mismatch.actual} is above the ${mismatch.expected.replace('at most ', '')} s the platform allows`
    case 'accepts':
    case 'extra':
      return '402 asset or network differs from the platform binding'
  }
}

export function schemaFailure(type: AgentType, error: string, path?: string): string {
  const where = path === undefined || path === '' ? error : path
  return `response failed the ${type} output schema at ${where}`
}

function describePaidFailure(result: PaidResult | null, attempt: number): string {
  if (!result) return 'no paid attempt was made'
  switch (result.kind) {
    case 'timeout':
      return NO_RESPONSE
    case 'transport':
      return `the paid request failed: ${result.detail}`
    case 'error':
      return `the paid request answered ${result.status}: ${result.detail}`
    case 'ok':
      return `the endpoint answered ${result.status} on attempt ${attempt} with no PAYMENT-RESPONSE header, so nothing settled`
  }
}

// ------------------------------------------------------------------- inputs

/**
 * AD-14 / addendum §1: the shared `samples` are the verification input, so the
 * body the platform sends is the body the schema page prints. `notify` is the
 * one substitution the spine names — `recipient.address` becomes the Platform
 * chat id and `run_id` stays null — because a verification Call to a `notify`
 * Agent delivers a real message and it has to arrive somewhere real.
 */
export function verificationInput(type: AgentType, platformChatId?: string | undefined): unknown {
  const sample = samples[type]
  if (type !== 'notify') return sample

  const notify = sample as typeof samples.notify
  return {
    ...notify,
    run_id: null,
    recipient: {
      ...notify.recipient,
      ...(platformChatId ? { address: platformChatId } : {}),
    },
  }
}

// -------------------------------------------------------------------- utils

const TERMINAL: readonly CallStatus[] = [
  'succeeded',
  'failed_after_payment',
  'payment_failed',
  'price_mismatch',
  'skipped',
]

function isTerminal(status: CallStatus): boolean {
  return TERMINAL.includes(status)
}

const HEX_TX = /^0x[0-9a-f]{64}$/

/** AD-13: hashes are stored lower-case, and only if they are hashes. */
function normaliseTxHash(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const lower = value.toLowerCase()
  return HEX_TX.test(lower) ? lower : null
}

/** Base units in, decimal tUSD out; anything else is passed through unchanged. */
function usdt(value: string): string {
  try {
    return `${toDecimalUsdt(value)} tUSD`
  } catch {
    return value
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
