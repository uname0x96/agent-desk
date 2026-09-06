import type { CallStatus, PaymentView } from "@agent-desk/schemas"
import type { PaymentRow } from "../api/payments/payments-model.ts"

/**
 * Two Runs' worth of Calls, as `calls` holds them and as `GET /api/payments`
 * projects them. Test-only: nothing under `app/` imports this.
 *
 * The set is chosen to exercise every Story 5.2 branch at once:
 *
 *   Run A, a five-Node Run that failed at `execution` after paying —
 *     `data` succeeded, `research` succeeded and was settled, `risk` succeeded
 *     and is not settled yet, `execution` is `failed_after_payment` (the
 *     "no refund" case), `notify` succeeded.
 *   Run B, refused by the chain —
 *     `data` succeeded, `research` is `payment_failed` with no hash (the
 *     "not settled" case) and one Call is `price_mismatch`, which signed
 *     nothing and therefore is not a payment at all.
 *
 * `callFixtures` carries the two Calls that never reach the page as well, so a
 * test can apply the Story 5.1 `total_cost` rule to the raw Run and compare it
 * with the subtotal this page derives from the projected rows.
 */

export const RUN_A = "run_00000000000000000000PAYA01"
export const RUN_B = "run_00000000000000000000PAYB01"

const WALLET = "0xa71c3d90e5b28f4607c93d1a2b85e04f7d16c982"
const DATA_PAY_TO = "0x1e4a2f7d3c9b60518a7d3f2c4b8e91d0a6c73f52"
const RESEARCH_PAY_TO = "0x8b21c6d4e70f9a3b52c1d8e46f70a9b3c25d18e4"
const RISK_PAY_TO = "0x3f70b9c2d81e46a05b7c93d2e18f4a60c5b72d93"
const EXECUTION_PAY_TO = "0x7609275f0f166d078f59d69d69511d0612e756cb"
const NOTIFY_PAY_TO = "0x25f8c1b2a7d604e39f5b8c10d72a4e6390bf1c47"

function hash(seed: string): string {
  return `0x${seed.repeat(64).slice(0, 64)}`
}

/**
 * A `calls` row as the payments query reads it, plus the two columns the page
 * never sees but Story 5.1's `total_cost` is defined over.
 */
export interface CallFixture extends PaymentRow {
  /** AD-5 writes this in the same transaction that signs; null means unsigned. */
  paymentPayload: Record<string, unknown> | null
}

function call(
  overrides: Partial<CallFixture> &
    Pick<CallFixture, "callId" | "runId" | "nodeIndex" | "nodeType" | "status" | "lockedPrice" | "lockedPayTo" | "provider">,
): CallFixture {
  // AD-5: the payload is written by `signPayment`, so exactly the statuses a
  // Call can only reach *through* the signer carry one.
  const unsigned: readonly CallStatus[] = ["pending", "price_mismatch", "skipped"]
  const signed = !unsigned.includes(overrides.status)
  return {
    paymentTxHash: null,
    startedAt: new Date("2026-09-06T09:00:00.000Z"),
    endedAt: new Date("2026-09-06T09:00:02.000Z"),
    from: WALLET,
    settlementId: null,
    paymentPayload: signed ? { nonce: "0x01", from: WALLET, to: overrides.lockedPayTo } : null,
    ...overrides,
  }
}

/** Run A: five Nodes, paid four, failed at `execution` after paying for it. */
export const runACalls: CallFixture[] = [
  call({
    callId: "call_PAYA0",
    runId: RUN_A,
    nodeIndex: 0,
    nodeType: "data",
    provider: "Binance Ticker",
    status: "succeeded",
    lockedPrice: "10000",
    lockedPayTo: DATA_PAY_TO,
    paymentTxHash: hash("a"),
  }),
  call({
    callId: "call_PAYA1",
    runId: RUN_A,
    nodeIndex: 1,
    nodeType: "research",
    provider: "Alpha Research",
    status: "succeeded",
    lockedPrice: "50000",
    lockedPayTo: RESEARCH_PAY_TO,
    paymentTxHash: hash("b"),
    settlementId: "stl_PAYA1",
  }),
  call({
    callId: "call_PAYA2",
    runId: RUN_A,
    nodeIndex: 2,
    nodeType: "risk",
    provider: "Guardrail Risk",
    status: "succeeded",
    lockedPrice: "20000",
    lockedPayTo: RISK_PAY_TO,
    paymentTxHash: hash("c"),
  }),
  call({
    callId: "call_PAYA3",
    runId: RUN_A,
    nodeIndex: 3,
    nodeType: "execution",
    provider: "Binance Spot Executor",
    status: "failed_after_payment",
    lockedPrice: "10000",
    lockedPayTo: EXECUTION_PAY_TO,
    paymentTxHash: hash("d"),
  }),
  call({
    callId: "call_PAYA4",
    runId: RUN_A,
    nodeIndex: 4,
    nodeType: "notify",
    provider: "Telegram Notifier",
    status: "succeeded",
    lockedPrice: "5000",
    lockedPayTo: NOTIFY_PAY_TO,
    paymentTxHash: hash("e"),
  }),
]

/**
 * Run B: one payment that landed, one authorisation the chain never used, and
 * one Call refused at the 402 before anything was signed.
 */
export const runBCalls: CallFixture[] = [
  call({
    callId: "call_PAYB0",
    runId: RUN_B,
    nodeIndex: 0,
    nodeType: "data",
    provider: "Binance Ticker",
    status: "succeeded",
    lockedPrice: "10000",
    lockedPayTo: DATA_PAY_TO,
    paymentTxHash: hash("f"),
  }),
  call({
    callId: "call_PAYB1",
    runId: RUN_B,
    nodeIndex: 1,
    nodeType: "research",
    provider: "Sloppy Research",
    status: "payment_failed",
    lockedPrice: "30000",
    lockedPayTo: RESEARCH_PAY_TO,
  }),
  call({
    callId: "call_PAYB2",
    runId: RUN_B,
    nodeIndex: 2,
    nodeType: "risk",
    provider: "Guardrail Risk",
    status: "price_mismatch",
    lockedPrice: "20000",
    lockedPayTo: RISK_PAY_TO,
  }),
]

export const callFixtures: CallFixture[] = [...runACalls, ...runBCalls]

/** AD-3: a payment is a `kind = 'run'` Call whose `payment_payload` is not null. */
export function paymentRows(calls: readonly CallFixture[] = callFixtures): PaymentRow[] {
  return calls.filter((row) => row.paymentPayload !== null)
}

/** Story 5.1: `locked_price` over the Calls in the three paid statuses. */
export const PAID_STATUSES: readonly CallStatus[] = [
  "paid_awaiting_result",
  "succeeded",
  "failed_after_payment",
]

/** The `{ items, next }` body, as the client parses it. */
export function paymentsPageFixture(items: PaymentView[], next: string | null = null) {
  return { items, next }
}
