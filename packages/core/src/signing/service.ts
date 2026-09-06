import type {
  Address,
  ChainReader,
  Clock,
  Hex,
  Logger,
  PaymentCallContext,
  PaymentRequirementsSnapshot,
  Signer,
  SigningStore,
  StoredPaymentPayload,
  X402PaymentSigner,
} from '../ports/index.ts'
import { systemClock, silentLogger } from '../ports/index.ts'
import { KeyedMutex } from './mutex.ts'
import {
  checkCreatorStakeMinimum,
  checkDailyFeeBudget,
  checkGasFloor,
  checkStakeReservation,
  checkVerificationCap,
  type PolicyRefusal,
} from './policy.ts'

/**
 * AD-5: signing policy in core, keys behind the `Signer` port, wired only in
 * the worker and `scripts/`.
 *
 * Everything below happens inside one wallet's mutex:
 *
 *   1. the idempotence check — a Call that already carries a signed
 *      authorization gets its stored header back and is never signed twice;
 *   2. the policy checks, in the AD-5 order, all of them before any signature;
 *   3. the signature itself, through a port;
 *   4. the persistence, which for a payment is one database transaction that
 *      writes `calls.payment_payload` and moves the Call to
 *      `paid_awaiting_result` before the header is returned.
 *
 * Step 4 before the return is the whole reason a crashed engine can resume: the
 * row says "this Call has been paid for" from the moment the header exists, so
 * a redelivered `run.execute` resends the stored header (AD-4) instead of
 * signing a second authorization for the same Call (FR-25).
 */

export type SigningOutcome<T> = ({ ok: true } & T) | { ok: false; refusal: PolicyRefusal }

/** The second argument of `signPayment(walletId, requirements)`. */
export interface PaymentSigningRequest extends PaymentRequirementsSnapshot {
  /** The Call this payment settles; the policy reads its kind, account and Listing. */
  call: PaymentCallContext
}

export interface SignedPayment {
  /** The `PAYMENT-SIGNATURE` header value. */
  header: string
  payload: StoredPaymentPayload
  /** True when the header came from `calls.payment_payload`, not from a new signature. */
  reused: boolean
}

/** The second argument of `sendTx(walletId, intent)`. */
export interface ChainIntent {
  /** One of the AD-8 keys. Carried for logging; `chainWrite` owns the row. */
  intentKey: string
  to: Address
  data: Hex
  /** Wei. */
  value?: bigint
  gas?: bigint
  /**
   * The BNB floor this intent's signer is held to. Defaults to the service's
   * `gasFloorWei`, which the worker sets from `CREATOR_WALLET_BNB_FLOOR`.
   */
  gasFloorWei?: bigint
  /**
   * FR-7 / FR-9: present when the intent changes a Listing's price or stake, so
   * the ten-times minimum is checked before the Creator pays gas for a revert.
   * Both amounts are base units and describe the state *after* the write.
   */
  stakeCheck?: { price: bigint; stake: bigint }
}

export interface SentTx {
  txHash: Hex
}

export interface SigningServiceDeps {
  signer: Signer
  payments: X402PaymentSigner
  store: SigningStore
  chain: ChainReader
  clock?: Clock
  logger?: Logger
  /** Default BNB floor for `sendTx`, in wei. */
  gasFloorWei: bigint
}

export interface SigningService {
  /** AD-5 / FR-25: one x402 payment authorization per Call, ever. */
  signPayment(walletId: string, requirements: PaymentSigningRequest): Promise<SigningOutcome<SignedPayment>>
  /** AD-5 / AD-8: one chain transaction, serialised on the wallet. */
  sendTx(walletId: string, intent: ChainIntent): Promise<SigningOutcome<SentTx>>
  /** FR-2: a fresh encrypted key. Not policy-checked; nothing is signed. */
  generateKey(): Promise<{ address: Address; encryptedKey: string }>
  /** Diagnostics: how many wallets this process has ever locked. */
  readonly lockCount: number
}

export function createSigningService(deps: SigningServiceDeps): SigningService {
  const clock = deps.clock ?? systemClock
  const logger = deps.logger ?? silentLogger
  const locks = new KeyedMutex()

  async function signPayment(
    walletId: string,
    requirements: PaymentSigningRequest,
  ): Promise<SigningOutcome<SignedPayment>> {
    return locks.run(walletId, async () => {
      const { call } = requirements
      const amount = BigInt(requirements.amount)

      // 1. Idempotence. A redelivered job, or a paid retry after a timeout,
      //    finds the header that was stored the first time round.
      const stored = await deps.store.readPaymentPayload(call.callId)
      if (stored) {
        logger.debug({ call_id: call.callId, wallet_id: walletId }, 'reusing the stored payment header')
        return { ok: true as const, header: stored.header, payload: stored, reused: true }
      }

      const wallet = await mustLoadWallet(walletId)
      const now = clock.now()

      // 2. Policy, in the AD-5 order, all of it before anything is signed.
      const refusal = await evaluatePaymentPolicy(call, amount, now)
      if (refusal) {
        logger.warn(
          { call_id: call.callId, wallet_id: walletId, check: refusal.check, code: refusal.code },
          'payment refused before signing',
        )
        return { ok: false as const, refusal }
      }

      // 3. The signature. The key never leaves the Signer port.
      const signed = await deps.payments.signPaymentAuthorization({
        wallet: { address: wallet.address, encryptedKey: wallet.encryptedKey },
        requirements,
      })

      const payload: StoredPaymentPayload = {
        header: signed.header,
        nonce: signed.authorization.nonce,
        validAfter: signed.authorization.validAfter,
        validBefore: signed.authorization.validBefore,
        from: signed.authorization.from.toLowerCase(),
        to: signed.authorization.to.toLowerCase(),
        value: signed.authorization.value,
        signature: signed.signature,
      }

      // 4. One transaction: the payload and `paid_awaiting_result` together.
      await deps.store.recordPaymentAuthorization({ callId: call.callId, payload, startedAt: now })

      logger.info(
        { call_id: call.callId, wallet_id: walletId, listing_id: call.listingId, amount: requirements.amount },
        'payment authorization signed and recorded',
      )
      return { ok: true as const, header: payload.header, payload, reused: false }
    })
  }

  /**
   * The three checks that apply to a payment. The Creator ten-times minimum and
   * the gas floor belong to `sendTx`: an x402 payment is relayed by the
   * facilitator (AD-6), so the paying wallet spends no BNB.
   */
  async function evaluatePaymentPolicy(
    call: PaymentCallContext,
    amount: bigint,
    now: Date,
  ): Promise<PolicyRefusal | null> {
    if (call.kind === 'verification') {
      // FR-11: the Platform Wallet's own cap, and no Stake reservation — a
      // verification Call is never scored, so it can never be slashed.
      return checkVerificationCap(await deps.store.verificationUsage(call.callId, now), amount)
    }

    if (!call.accountId) {
      throw new Error(`call ${call.callId} has kind 'run' but no account id`)
    }
    const budget = checkDailyFeeBudget(
      await deps.store.budgetUsage(call.accountId, call.callId, now),
      amount,
    )
    if (budget) return budget

    return checkStakeReservation(
      call.nodeType,
      await deps.store.stakeUsage(call.listingId, call.callId),
      amount,
    )
  }

  async function sendTx(walletId: string, intent: ChainIntent): Promise<SigningOutcome<SentTx>> {
    return locks.run(walletId, async () => {
      const wallet = await mustLoadWallet(walletId)

      if (intent.stakeCheck) {
        const refusal = checkCreatorStakeMinimum(intent.stakeCheck.price, intent.stakeCheck.stake)
        if (refusal) {
          logger.warn({ wallet_id: walletId, intent_key: intent.intentKey, check: refusal.check }, 'chain write refused')
          return { ok: false as const, refusal }
        }
      }

      const floor = intent.gasFloorWei ?? deps.gasFloorWei
      const balance = await deps.chain.nativeBalance(wallet.address)
      const refusal = checkGasFloor(balance, floor)
      if (refusal) {
        logger.warn({ wallet_id: walletId, intent_key: intent.intentKey, check: refusal.check }, 'chain write refused')
        return { ok: false as const, refusal }
      }

      const txHash = await deps.signer.sendRawTx({
        encryptedKey: wallet.encryptedKey,
        to: intent.to,
        data: intent.data,
        ...(intent.value === undefined ? {} : { value: intent.value }),
        ...(intent.gas === undefined ? {} : { gas: intent.gas }),
      })
      logger.info({ wallet_id: walletId, intent_key: intent.intentKey, tx_hash: txHash }, 'transaction broadcast')
      return { ok: true as const, txHash }
    })
  }

  async function mustLoadWallet(walletId: string) {
    const wallet = await deps.store.getWallet(walletId)
    if (!wallet) throw new Error(`no wallet ${walletId}`)
    return wallet
  }

  return {
    signPayment,
    sendTx,
    generateKey: () => deps.signer.generateKey(),
    get lockCount() {
      return locks.size
    },
  }
}
