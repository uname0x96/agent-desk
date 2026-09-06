import type { AgentType, CallStatus, PriceLock, RunStatus, SkipReason } from '@agent-desk/schemas'
import type { CallState } from '@agent-desk/core/run'
import type { StoredPaymentPayload } from '@agent-desk/core/ports'

/**
 * What the run engine needs from Postgres and from an Agent's HTTP endpoint.
 *
 * These three ports are the whole reason the engine is testable without a
 * database, without a chain and without a network: `store.ts` is the Postgres
 * implementation of the first, `agent-client.ts` the fetch implementation of
 * the second, `exchange-balance.ts` the fetch implementation of the third, and
 * `engine.test.ts` drives the engine through in-memory doubles of all of them.
 */

// ------------------------------------------------------------------- store

export interface RunCallRecord extends CallState {
  listingId: string
  /** `listings.name`, shown as Provider (FR-28). */
  provider: string
  /** `listings.endpoint`, the chain-owned cache (AD-2). */
  endpoint: string
  /** Base units, from the Price Lock; never re-read from the Listing. */
  lockedPrice: string
  lockedPayTo: string
  lockedAsset: string
  lockedNetwork: string
  /** The body already sent, so a resumed `resend` never rebuilds it. */
  request: unknown
  /** The Type output of a `succeeded` Call, fed to the next Node (addendum §1). */
  response: unknown
  /** AD-6: the settlement hash, for the notify cost table. Null until settled. */
  paymentTxHash: string | null
  /** FR-24: why a Call was skipped, for the notify summary and the Run view. */
  skipReason: SkipReason | null
}

export interface RunRecord {
  id: string
  workflowId: string
  accountId: string
  /** The Builder System Wallet that pays every Call of this Run. */
  walletId: string
  status: string
  /** `runs.failure_reason`; read back by a `finalize` delivery (AD-4). */
  failureReason: string | null
  priceLock: PriceLock
  startedAt: Date | null
  /** `workflows.symbol`, the input of the `data` Node. */
  symbol: string
  /** FR-4, decimal USDT, or null. */
  orderCapUsdt: string | null
  /** `accounts.telegram_chat_id`, for the terminal `notify` filter. */
  telegramChatId: string | null
  /** Every Type the Workflow declares, in `node_index` order. */
  nodeTypes: readonly AgentType[]
  calls: readonly RunCallRecord[]
}

/** Exactly the AD-3 columns the engine writes, and no others. */
export interface CallPatch {
  status?: CallStatus
  request?: unknown
  response?: unknown
  paymentRequired?: unknown
  paymentTxHash?: string | null
  attempt?: number
  referencePrice?: string | null
  referenceAt?: Date | null
  failureReason?: string | null
  startedAt?: Date
  endedAt?: Date
}

export interface RunStore {
  load(runId: string): Promise<RunRecord | null>
  /** AD-4: set at pickup, and only if it is still null. Returns the effective value. */
  markStarted(runId: string, at: Date): Promise<Date>
  updateCall(callId: string, patch: CallPatch): Promise<void>
  /**
   * AD-4: a compare-and-set from `running`. `false` means zero rows were
   * updated, so another writer ended the Run and the engine must exit.
   */
  endRun(runId: string, status: RunStatus, at: Date, failureReason: string | null): Promise<boolean>
  /** AD-4: at Run end every still-`pending` Call becomes `skipped`. */
  skipPendingCalls(runId: string, reason: SkipReason, at: Date): Promise<number>
  /** FR-24: one Node the chain no longer needs. Never requested, never paid. */
  skipCall(callId: string, reason: SkipReason, at: Date): Promise<void>
  /** AD-5: the authorization signed for this Call, so a retry finds its header. */
  readPaymentPayload(callId: string): Promise<StoredPaymentPayload | null>
}

// ------------------------------------------------------------ agent client

/** The 402 body as x402 v2 states it; only the fields the engine compares. */
export interface PaymentRequiredPayload {
  x402Version?: number
  error?: string
  accepts: {
    scheme: string
    network: string
    asset: string
    amount: string
    payTo: string
    maxTimeoutSeconds: number
    extra?: unknown
  }[]
  [key: string]: unknown
}

/** The `PAYMENT-RESPONSE` header, decoded. `transaction` is the settlement hash. */
export interface SettlementReceipt {
  success: boolean
  transaction: string
  network?: string
  errorReason?: string
}

export type UnpaidResult =
  | { kind: 'payment_required'; payload: PaymentRequiredPayload }
  /** Any status other than 402, including a 200 the engine never asked to be free. */
  | { kind: 'unexpected'; status: number; detail: string }
  | { kind: 'timeout' }
  | { kind: 'transport'; detail: string }

export type PaidResult =
  /** 2xx. `settlement` is null when the response carried no `PAYMENT-RESPONSE`. */
  | { kind: 'ok'; status: number; body: unknown; settlement: SettlementReceipt | null }
  | { kind: 'error'; status: number; detail: string; settlement: SettlementReceipt | null }
  | { kind: 'timeout' }
  | { kind: 'transport'; detail: string }

export interface AgentClient {
  /** 15 s (AD-6). The 402 is the expected answer. */
  requestUnpaid(endpoint: string, input: unknown): Promise<UnpaidResult>
  /** 15 s (AD-6), with the stored `PAYMENT-SIGNATURE` header. */
  requestPaid(endpoint: string, input: unknown, header: string): Promise<PaidResult>
}

// -------------------------------------------------------- exchange balance

/**
 * AD-11: the exchange lives only inside the execution Agent, so the engine
 * reads `balance_usdt` for the `risk` Node over that Agent's
 * `GET /internal/balance` and never touches an exchange client itself.
 *
 * The port is one method because that is the whole of what the engine is
 * allowed to know about an exchange. A failed read throws; the engine turns
 * that into the pre-payment refusal the criteria name.
 */
export interface ExchangeBalance {
  /** Decimal USDT (`InternalBalance`, AD-14). Throws on any failure. */
  balanceUsdt(): Promise<string>
}

export type { StoredPaymentPayload }
