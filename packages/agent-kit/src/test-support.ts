import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import type { FacilitatorClient } from '@x402/core/server'
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from '@x402/core/types'
import { X402_HEADERS, X402_VERSION } from '@agent-desk/schemas'

/**
 * Test doubles for the paid path. The real thing needs a running facilitator,
 * a deployed tUSD, and a funded account, none of which exist before Stories
 * 1.2 and 1.3 land; `scripts/paid-request.ts` covers that end. Everything the
 * kit itself owns — the 402 body, validation, the budget, the replay cache,
 * the internal guard — is exercised here against a stub facilitator.
 */

export interface StubSettleOutcome {
  success: boolean
  transaction: string
  errorReason?: string
  errorMessage?: string
}

export interface StubFacilitatorOptions {
  network?: string
  /** Per-call verify outcome; defaults to valid. */
  verify?: (call: number) => { isValid: boolean; invalidReason?: string }
  /** Per-call settle outcome; defaults to a confirmed transaction. */
  settle?: (call: number) => StubSettleOutcome
}

export const STUB_TX_HASH = `0x${'ab'.repeat(32)}`
export const STUB_PAYER = '0x1111111111111111111111111111111111111111'

export class StubFacilitator implements FacilitatorClient {
  verifyCalls = 0
  settleCalls = 0
  readonly network: Network
  private readonly verifyOutcome: NonNullable<StubFacilitatorOptions['verify']>
  private readonly settleOutcome: NonNullable<StubFacilitatorOptions['settle']>

  constructor(options: StubFacilitatorOptions = {}) {
    this.network = (options.network ?? 'eip155:97') as Network
    this.verifyOutcome = options.verify ?? (() => ({ isValid: true }))
    this.settleOutcome =
      options.settle ?? (() => ({ success: true, transaction: STUB_TX_HASH }))
  }

  verify(_payload: PaymentPayload, _requirements: PaymentRequirements) {
    this.verifyCalls += 1
    const outcome = this.verifyOutcome(this.verifyCalls)
    return Promise.resolve({ ...outcome, payer: STUB_PAYER })
  }

  settle(_payload: PaymentPayload, _requirements: PaymentRequirements) {
    this.settleCalls += 1
    const outcome = this.settleOutcome(this.settleCalls)
    return Promise.resolve({ ...outcome, network: this.network, payer: STUB_PAYER })
  }

  getSupported() {
    return Promise.resolve({
      kinds: [{ x402Version: X402_VERSION, scheme: 'exact', network: this.network }],
      extensions: [],
      signers: {},
    })
  }
}

export interface UnpaidResponse {
  status: number
  headers: Headers
  body: unknown
  paymentRequired: PaymentRequired
}

/** POST without a payment header and decode the `PAYMENT-REQUIRED` declaration. */
export async function requestUnpaid(baseUrl: string, body: unknown): Promise<UnpaidResponse> {
  const response = await fetch(`${baseUrl}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const header = response.headers.get(X402_HEADERS.required)
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
    paymentRequired: header ? decodePaymentRequiredHeader(header) : ({} as PaymentRequired),
  }
}

let nonceCounter = 0

/**
 * A well-formed v2 payload for the accepted requirements. The stub facilitator
 * is the only thing that inspects it, so the EIP-3009 authorization carries
 * plausible values rather than a real signature.
 */
export function buildPaymentSignatureHeader(accepted: PaymentRequirements): string {
  nonceCounter += 1
  const nonce = `0x${nonceCounter.toString(16).padStart(64, '0')}`
  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    accepted,
    payload: {
      signature: `0x${'cd'.repeat(65)}`,
      authorization: {
        from: STUB_PAYER,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + accepted.maxTimeoutSeconds),
        nonce,
      },
    },
  }
  return encodePaymentSignatureHeader(payload)
}

export interface PaidResponse {
  status: number
  headers: Headers
  body: unknown
  signature: string
}

/** POST with a payment header; reuse `signature` to replay one payment. */
export async function requestPaid(
  baseUrl: string,
  body: unknown,
  signature: string,
): Promise<PaidResponse> {
  const response = await fetch(`${baseUrl}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [X402_HEADERS.signature]: signature,
    },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
    signature,
  }
}
