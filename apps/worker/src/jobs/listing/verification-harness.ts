import { buildX402Config, type CallStatus } from '@agent-desk/schemas'
import type { ListingPipelineRow } from '@agent-desk/core/listing'
import type { StoredPaymentPayload } from '@agent-desk/core/ports'
import type { PolicyRefusal, SigningService } from '@agent-desk/core/signing'
import type { AgentClient, PaidResult, UnpaidResult } from '../run/ports.ts'
import type {
  NewVerificationCall,
  VerificationCallPatch,
  VerificationCallRow,
  VerificationCallStore,
} from './verification-ports.ts'

/**
 * The doubles `verification.test.ts` drives the paid Handshake through.
 *
 * Only three things are faked, and each is a boundary the Handshake has no
 * opinion about: the `calls` table, the Agent's socket, and the wallet lock.
 * The comparison, the ordering, the retry rule and every sentence written to
 * `listings.last_error` are the real code.
 */

export const PLATFORM_WALLET_ID = 'wal_PLATFORM'
export const PAYOUT_WALLET = '0x00000000000000000000000000000000000000b2'
export const PLATFORM_ADDRESS = '0x00000000000000000000000000000000000000f1'
export const FACILITATOR_URL = 'http://facilitator.test'

export const X402 = buildX402Config({ facilitatorUrl: FACILITATOR_URL, chainId: 97 })

/** 0.01 tUSD a call, the seed Listing's price. */
export const PRICE = '10000'

export function listingRow(overrides: Partial<ListingPipelineRow> = {}): ListingPipelineRow {
  return {
    id: 'lst_VERIFY',
    creatorAccountId: 'acc_CREATOR',
    name: 'Sloppy Research',
    description: null,
    type: 'research',
    endpoint: 'http://agent-sloppy-research:4103/',
    declaredPrice: PRICE,
    declaredStake: '100000',
    payoutWallet: PAYOUT_WALLET,
    status: 'verifying',
    skipVerification: false,
    agentId: null,
    registryListingId: null,
    ...overrides,
  }
}

/** A 402 that restates the declared terms exactly, as a conforming Agent's does. */
export function conforming402(
  overrides: Partial<{
    scheme: string
    network: string
    asset: string
    amount: string
    payTo: string
    maxTimeoutSeconds: number
    extra: unknown
  }> = {},
): UnpaidResult {
  return {
    kind: 'payment_required',
    payload: {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: X402.network,
          asset: X402.asset,
          amount: PRICE,
          payTo: PAYOUT_WALLET,
          maxTimeoutSeconds: 15,
          extra: X402.extra,
          ...overrides,
        },
      ],
    },
  }
}

export const RESEARCH_OUTPUT = {
  signal: 'LONG',
  confidence: 0.72,
  reason: 'Price reclaimed the 24h midpoint on rising volume.',
}

export const SETTLEMENT_TX = `0x${'ab'.repeat(32)}`

export function settled200(body: unknown = RESEARCH_OUTPUT): PaidResult {
  return {
    kind: 'ok',
    status: 200,
    body,
    settlement: { success: true, transaction: SETTLEMENT_TX },
  }
}

// ------------------------------------------------------------------ the store

export class FakeCallTable implements VerificationCallStore {
  readonly rows = new Map<string, VerificationCallRow & { listingId: string }>()
  readonly patches: { callId: string; patch: VerificationCallPatch }[] = []
  readonly payloads = new Map<string, StoredPaymentPayload>()
  spent = 0n
  cap = 5_000_000n
  /** Every `capUsage` call, so a test can prove the cap is read before the socket. */
  capReads = 0

  async findForListing(listingId: string): Promise<VerificationCallRow | null> {
    const rows = [...this.rows.values()].filter((row) => row.listingId === listingId)
    return rows.at(-1) ?? null
  }

  async insert(call: NewVerificationCall): Promise<void> {
    this.rows.set(call.id, {
      id: call.id,
      listingId: call.listingId,
      status: 'pending',
      attempt: 0,
      request: call.request,
      failureReason: null,
      paymentTxHash: null,
      hasPaymentPayload: false,
    })
    this.inserted.push(call)
  }

  readonly inserted: NewVerificationCall[] = []

  async update(callId: string, patch: VerificationCallPatch): Promise<void> {
    this.patches.push({ callId, patch })
    const row = this.rows.get(callId)
    if (!row) throw new Error(`no call ${callId}`)
    this.rows.set(callId, {
      ...row,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.attempt === undefined ? {} : { attempt: patch.attempt }),
      ...(patch.failureReason === undefined ? {} : { failureReason: patch.failureReason }),
      ...(patch.paymentTxHash === undefined ? {} : { paymentTxHash: patch.paymentTxHash }),
    })
  }

  async readPaymentPayload(callId: string): Promise<StoredPaymentPayload | null> {
    return this.payloads.get(callId) ?? null
  }

  async capUsage(): Promise<{ spent: bigint; cap: bigint }> {
    this.capReads += 1
    return { spent: this.spent, cap: this.cap }
  }

  async platformWalletId(): Promise<string> {
    return PLATFORM_WALLET_ID
  }

  /** The row as the last write left it, for an assertion about the Call itself. */
  status(callId: string): CallStatus {
    const row = this.rows.get(callId)
    if (!row) throw new Error(`no call ${callId}`)
    return row.status
  }

  only(): VerificationCallRow & { listingId: string } {
    const rows = [...this.rows.values()]
    if (rows.length !== 1) throw new Error(`expected one Call, found ${rows.length}`)
    return rows[0]!
  }
}

// ------------------------------------------------------------------ the wire

export class FakeAgent implements AgentClient {
  readonly unpaid: { endpoint: string; input: unknown }[] = []
  readonly paid: { endpoint: string; input: unknown; header: string }[] = []
  private readonly unpaidQueue: UnpaidResult[] = []
  private readonly paidQueue: PaidResult[] = []

  expectUnpaid(...results: UnpaidResult[]): this {
    this.unpaidQueue.push(...results)
    return this
  }

  expectPaid(...results: PaidResult[]): this {
    this.paidQueue.push(...results)
    return this
  }

  async requestUnpaid(endpoint: string, input: unknown): Promise<UnpaidResult> {
    this.unpaid.push({ endpoint, input })
    const next = this.unpaidQueue.shift()
    if (!next) throw new Error('no unpaid result queued')
    return next
  }

  async requestPaid(endpoint: string, input: unknown, header: string): Promise<PaidResult> {
    this.paid.push({ endpoint, input, header })
    const next = this.paidQueue.shift()
    if (!next) throw new Error('no paid result queued')
    return next
  }
}

// -------------------------------------------------------------- the wallet

/**
 * `signPayment` as the AD-5 service behaves from the caller's side: it writes
 * the authorization and moves the Call to `paid_awaiting_result` before the
 * header is returned, and it hands the same header back the second time.
 */
export class FakeSigning implements Pick<SigningService, 'signPayment'> {
  readonly requests: Parameters<SigningService['signPayment']>[] = []
  refusal: PolicyRefusal | null = null

  private readonly table: FakeCallTable

  constructor(table: FakeCallTable) {
    this.table = table
  }

  async signPayment(
    walletId: string,
    requirements: Parameters<SigningService['signPayment']>[1],
  ): Promise<Awaited<ReturnType<SigningService['signPayment']>>> {
    this.requests.push([walletId, requirements])
    if (this.refusal) return { ok: false, refusal: this.refusal }

    const callId = requirements.call.callId
    const existing = this.table.payloads.get(callId)
    if (existing) return { ok: true, header: existing.header, payload: existing, reused: true }

    const payload: StoredPaymentPayload = {
      header: `header-${callId}`,
      nonce: `0x${'11'.repeat(32)}`,
      validAfter: '0',
      validBefore: '1793000000',
      from: PLATFORM_ADDRESS,
      to: requirements.payTo,
      value: requirements.amount,
      signature: `0x${'22'.repeat(65)}`,
    }
    this.table.payloads.set(callId, payload)
    await this.table.update(callId, { status: 'paid_awaiting_result' })
    return { ok: true, header: payload.header, payload, reused: false }
  }
}

/** AD-6: the token's answer to "did this authorization land?". */
export class FakeAuthorizations {
  used = false
  throws = false
  reads = 0

  async authorizationUsed(): Promise<boolean> {
    this.reads += 1
    if (this.throws) throw new Error('rpc unavailable')
    return this.used
  }
}
