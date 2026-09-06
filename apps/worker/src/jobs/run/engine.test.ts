import { beforeEach, describe, expect, it } from 'vitest'
import type { Clock, StoredPaymentPayload } from '@agent-desk/core/ports'
import type { SigningOutcome, SignedPayment } from '@agent-desk/core/signing'
import { RUN_DEADLINE_MS } from '@agent-desk/core/run'
import type { CallStatus, PriceLock, RunStatus, SkipReason } from '@agent-desk/schemas'
import { createRunEngine, type RunEngineDeps } from './engine.ts'
import type {
  AgentClient,
  CallPatch,
  PaidResult,
  PaymentRequiredPayload,
  RunCallRecord,
  RunRecord,
  RunStore,
  UnpaidResult,
} from './ports.ts'

/**
 * The run engine against in-memory doubles of its two ports plus a fake signer,
 * a fake chain and a fake market-data read.
 *
 * Nothing here touches Postgres, a socket or a chain: the point is to pin the
 * *decisions* — which of the seven Call statuses is written, whether a signature
 * happens at all, how many paid attempts go out and with which header, what a
 * lost compare-and-set does — because those are the parts that cannot be checked
 * against testnet until tUSD is deployed and a wallet is funded.
 *
 * `FakeStore` mimics the one thing about the SQL that matters: `endRun` is a
 * compare-and-set from `running` and reports whether it matched.
 */

const ASSET = '0xd0e0851ca8a176d211e2a410f5bcf1fa440fada7'
const PAY_TO = '0x1e4a2f7d3c9b60518a7d3f2c4b8e91d0a6c73f52'
const OTHER = '0x8b21c6d4e70f9a3b52c1d8e46f70a9b3c25d18e4'
const FROM = '0xa71c3d90e5b28f4607c93d1a2b85e04f7d16c982'
const NONCE = `0x${'ab'.repeat(32)}` as const
const TX_HASH = `0x${'3c'.repeat(32)}`
const HEADER = 'eyJzaWduZWQiOiJvbmNlIn0='
const START = new Date('2026-09-06T12:00:00.000Z')

const PRICE_LOCK: PriceLock = {
  nodes: [
    {
      node_index: 0,
      node_type: 'data',
      listing_id: 'lst_ticker',
      provider: 'Binance Ticker',
      price: '10000',
      asset: ASSET,
      network: 'eip155:97',
      pay_to: PAY_TO,
    },
  ],
  total: '10000',
  locked_at: '2026-09-06T12:00:00.000',
}

const DATA_OUTPUT = {
  symbol: 'BNBUSDT',
  price: '612.40',
  change_24h_pct: -1.8,
  volatility_24h_pct: 3.2,
  ts: '2026-09-06T12:00:03Z',
}

function accepts(overrides: Partial<PaymentRequiredPayload['accepts'][number]> = {}) {
  return {
    scheme: 'exact',
    network: 'eip155:97',
    asset: ASSET,
    amount: '10000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 15,
    extra: { name: 'tUSD', version: '1' },
    ...overrides,
  }
}

function paymentRequired(
  entries: PaymentRequiredPayload['accepts'] = [accepts()],
): PaymentRequiredPayload {
  return { x402Version: 2, accepts: entries }
}

// ------------------------------------------------------------------ doubles

interface StoredCall extends RunCallRecord {
  paymentRequired: unknown
  paymentTxHash: string | null
  referencePrice: string | null
  referenceAt: Date | null
  failureReason: string | null
  skipReason: SkipReason | null
  startedAt: Date | null
  endedAt: Date | null
  payload: StoredPaymentPayload | null
}

class FakeStore implements RunStore {
  run: {
    record: Omit<RunRecord, 'calls'>
    endedAt: Date | null
    failureReason: string | null
  }
  calls: StoredCall[]
  /** Set by a test to make the compare-and-set lose, as a second writer would. */
  endedByAnotherWriter: RunStatus | null = null
  endRunAttempts: { status: RunStatus; applied: boolean }[] = []
  skipSweeps: { reason: SkipReason; count: number }[] = []

  constructor(options: { calls: StoredCall[]; run?: Partial<RunRecord> }) {
    this.calls = options.calls
    this.run = {
      record: {
        id: 'run_1',
        workflowId: 'wf_1',
        accountId: 'acc_1',
        walletId: 'wal_1',
        status: 'running',
        priceLock: PRICE_LOCK,
        startedAt: null,
        symbol: 'BNBUSDT',
        orderCapUsdt: null,
        telegramChatId: null,
        nodeTypes: ['data'],
        ...options.run,
      },
      endedAt: null,
      failureReason: null,
    }
  }

  load(runId: string): Promise<RunRecord | null> {
    if (runId !== this.run.record.id) return Promise.resolve(null)
    return Promise.resolve({
      ...this.run.record,
      calls: this.calls.map((call) => ({ ...call, hasPaymentPayload: call.payload !== null })),
    })
  }

  markStarted(_runId: string, at: Date): Promise<Date> {
    this.run.record.startedAt ??= at
    return Promise.resolve(this.run.record.startedAt)
  }

  updateCall(callId: string, patch: CallPatch): Promise<void> {
    const call = this.calls.find((candidate) => candidate.callId === callId)
    if (!call) throw new Error(`no call ${callId}`)
    if (patch.status !== undefined) call.status = patch.status
    if (patch.request !== undefined) call.request = patch.request
    if (patch.response !== undefined) call.response = patch.response
    if (patch.paymentRequired !== undefined) call.paymentRequired = patch.paymentRequired
    if (patch.paymentTxHash !== undefined) call.paymentTxHash = patch.paymentTxHash
    if (patch.attempt !== undefined) call.attempt = patch.attempt
    if (patch.referencePrice !== undefined) call.referencePrice = patch.referencePrice
    if (patch.referenceAt !== undefined) call.referenceAt = patch.referenceAt
    if (patch.failureReason !== undefined) call.failureReason = patch.failureReason
    if (patch.endedAt !== undefined) call.endedAt = patch.endedAt
    if (patch.startedAt !== undefined) call.startedAt ??= patch.startedAt
    return Promise.resolve()
  }

  /** AD-4: a compare-and-set from `running`, exactly as the SQL guards it. */
  endRun(
    _runId: string,
    status: RunStatus,
    at: Date,
    failureReason: string | null,
  ): Promise<boolean> {
    if (this.endedByAnotherWriter) {
      this.run.record.status = this.endedByAnotherWriter
    }
    const applied = this.run.record.status === 'running'
    this.endRunAttempts.push({ status, applied })
    if (!applied) return Promise.resolve(false)
    this.run.record.status = status
    this.run.endedAt = at
    this.run.failureReason = failureReason
    return Promise.resolve(true)
  }

  skipPendingCalls(_runId: string, reason: SkipReason, at: Date): Promise<number> {
    let count = 0
    for (const call of this.calls) {
      if (call.status !== 'pending') continue
      call.status = 'skipped'
      call.skipReason = reason
      call.endedAt = at
      count += 1
    }
    this.skipSweeps.push({ reason, count })
    return Promise.resolve(count)
  }

  readPaymentPayload(callId: string): Promise<StoredPaymentPayload | null> {
    return Promise.resolve(this.calls.find((call) => call.callId === callId)?.payload ?? null)
  }
}

class FakeAgent implements AgentClient {
  unpaid: UnpaidResult[] = [{ kind: 'payment_required', payload: paymentRequired() }]
  paid: PaidResult[] = []
  unpaidCalls: { endpoint: string; input: unknown }[] = []
  paidCalls: { endpoint: string; input: unknown; header: string }[] = []

  requestUnpaid(endpoint: string, input: unknown): Promise<UnpaidResult> {
    this.unpaidCalls.push({ endpoint, input })
    const next = this.unpaid.length > 1 ? this.unpaid.shift() : this.unpaid[0]
    return Promise.resolve(next ?? { kind: 'transport', detail: 'no scripted unpaid response' })
  }

  requestPaid(endpoint: string, input: unknown, header: string): Promise<PaidResult> {
    this.paidCalls.push({ endpoint, input, header })
    const next = this.paid.length > 1 ? this.paid.shift() : this.paid[0]
    return Promise.resolve(next ?? { kind: 'transport', detail: 'no scripted paid response' })
  }
}

function paidOk(body: unknown = DATA_OUTPUT, transaction: string | null = TX_HASH): PaidResult {
  return {
    kind: 'ok',
    status: 200,
    body,
    settlement: transaction === null ? null : { success: true, transaction },
  }
}

function pendingCall(overrides: Partial<StoredCall> = {}): StoredCall {
  return {
    callId: 'call_0',
    nodeIndex: 0,
    nodeType: 'data',
    status: 'pending',
    attempt: 0,
    hasPaymentPayload: false,
    listingId: 'lst_ticker',
    provider: 'Binance Ticker',
    endpoint: 'https://ticker.test/',
    lockedPrice: '10000',
    lockedPayTo: PAY_TO,
    lockedAsset: ASSET,
    lockedNetwork: 'eip155:97',
    request: null,
    response: null,
    paymentRequired: null,
    paymentTxHash: null,
    referencePrice: null,
    referenceAt: null,
    failureReason: null,
    skipReason: null,
    startedAt: null,
    endedAt: null,
    payload: null,
    ...overrides,
  }
}

const STORED_PAYLOAD: StoredPaymentPayload = {
  header: HEADER,
  nonce: NONCE,
  validAfter: '0',
  validBefore: '9999999999',
  from: FROM,
  to: PAY_TO,
  value: '10000',
  signature: `0x${'cd'.repeat(65)}`,
}

interface Harness {
  store: FakeStore
  agent: FakeAgent
  engine: ReturnType<typeof createRunEngine>
  signPaymentCalls: unknown[]
  authorizationChecks: { authorizer: string; nonce: string }[]
  lastPriceCalls: string[]
  now: Date
  advance(ms: number): void
}

function harness(options: {
  calls?: StoredCall[]
  run?: Partial<RunRecord>
  sign?: () => SigningOutcome<SignedPayment>
  authorizationUsed?: boolean | (() => Promise<boolean>)
  lastPrice?: () => Promise<string>
}): Harness {
  const store = new FakeStore({ calls: options.calls ?? [pendingCall()], ...(options.run ? { run: options.run } : {}) })
  const agent = new FakeAgent()
  const signPaymentCalls: unknown[] = []
  const authorizationChecks: { authorizer: string; nonce: string }[] = []
  const lastPriceCalls: string[] = []
  const state = { now: START }

  const clock: Clock = { now: () => state.now }

  const deps: RunEngineDeps = {
    store,
    agent,
    clock,
    signing: {
      signPayment: (walletId, requirements) => {
        signPaymentCalls.push({ walletId, requirements })
        const outcome =
          options.sign?.() ??
          ({ ok: true, header: HEADER, payload: STORED_PAYLOAD, reused: false } as const)
        if (outcome.ok) {
          // AD-5: the authorization and `paid_awaiting_result` land together.
          const call = store.calls.find((c) => c.callId === requirements.call.callId)
          if (call) {
            call.status = 'paid_awaiting_result'
            call.payload = STORED_PAYLOAD
            call.startedAt ??= state.now
          }
        }
        return Promise.resolve(outcome)
      },
    },
    chain: {
      authorizationUsed: (authorizer, nonce) => {
        authorizationChecks.push({ authorizer, nonce })
        const used = options.authorizationUsed ?? false
        return typeof used === 'function' ? used() : Promise.resolve(used)
      },
    },
    marketData: {
      lastPrice: (symbol) => {
        lastPriceCalls.push(symbol)
        return options.lastPrice?.() ?? Promise.resolve('612.40')
      },
    },
  }

  return {
    store,
    agent,
    engine: createRunEngine(deps),
    signPaymentCalls,
    authorizationChecks,
    lastPriceCalls,
    get now() {
      return state.now
    },
    advance(ms: number) {
      state.now = new Date(state.now.getTime() + ms)
    },
  }
}

const JOB = { run_id: 'run_1' }

// -------------------------------------------------------------------- tests

describe('the happy path', () => {
  it('pays one data Node and records the receipt', async () => {
    const h = harness({})
    h.agent.paid = [paidOk()]

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toEqual({ outcome: 'ended', runId: 'run_1', status: 'completed' })
    const call = h.store.calls[0]!
    expect(call.status).toBe('succeeded')
    expect(call.request).toEqual({ symbol: 'BNBUSDT' })
    expect(call.response).toEqual(DATA_OUTPUT)
    expect(call.paymentTxHash).toBe(TX_HASH)
    expect(call.attempt).toBe(1)
    expect(call.referencePrice).toBe('612.40')
    expect(call.referenceAt).toEqual(START)
    expect(call.startedAt).toEqual(START)
    expect(call.endedAt).toEqual(START)
    expect(call.failureReason).toBeNull()
    expect(h.store.run.record.startedAt).toEqual(START)
    expect(h.lastPriceCalls).toEqual(['BNBUSDT'])
  })

  it('stores every 402 payload it receives, matching or not', async () => {
    const h = harness({})
    h.agent.paid = [paidOk()]
    await h.engine.execute(JOB)
    expect(h.store.calls[0]!.paymentRequired).toEqual(paymentRequired())
  })

  it('signs exactly once, for the entry it matched, and sends that header', async () => {
    const h = harness({})
    h.agent.paid = [paidOk()]
    await h.engine.execute(JOB)

    expect(h.signPaymentCalls).toHaveLength(1)
    expect(h.signPaymentCalls[0]).toEqual({
      walletId: 'wal_1',
      requirements: {
        scheme: 'exact',
        network: 'eip155:97',
        asset: ASSET,
        amount: '10000',
        payTo: PAY_TO,
        maxTimeoutSeconds: 15,
        extra: { name: 'tUSD', version: '1' },
        call: {
          callId: 'call_0',
          kind: 'run',
          accountId: 'acc_1',
          listingId: 'lst_ticker',
          nodeType: 'data',
        },
      },
    })
    expect(h.agent.paidCalls).toEqual([
      { endpoint: 'https://ticker.test/', input: { symbol: 'BNBUSDT' }, header: HEADER },
    ])
  })

  it('leaves the reference price null when the market-data read fails', async () => {
    const h = harness({ lastPrice: () => Promise.reject(new Error('binance is down')) })
    h.agent.paid = [paidOk()]
    await h.engine.execute(JOB)
    const call = h.store.calls[0]!
    expect(call.status).toBe('succeeded')
    expect(call.referencePrice).toBeNull()
    expect(call.referenceAt).toBeNull()
  })
})

describe('the Price Lock comparison', () => {
  const cases: { name: string; payload: PaymentRequiredPayload; reason: RegExp }[] = [
    {
      name: 'a different network',
      payload: paymentRequired([accepts({ network: 'eip155:56' })]),
      reason: /accepts/,
    },
    {
      name: 'a different scheme',
      payload: paymentRequired([accepts({ scheme: 'permit2-exact' })]),
      reason: /accepts/,
    },
    {
      name: 'a different asset',
      payload: paymentRequired([accepts({ asset: OTHER })]),
      reason: /accepts/,
    },
    {
      name: 'a different payTo',
      payload: paymentRequired([accepts({ payTo: OTHER })]),
      reason: /pay_to/,
    },
    {
      name: 'a different amount',
      payload: paymentRequired([accepts({ amount: '10001' })]),
      reason: /amount: expected 10000, got 10001/,
    },
    {
      name: 'a maxTimeoutSeconds above 15',
      payload: paymentRequired([accepts({ maxTimeoutSeconds: 16 })]),
      reason: /max_timeout_seconds/,
    },
    {
      name: 'no EIP-712 domain',
      payload: paymentRequired([accepts({ extra: undefined })]),
      reason: /extra/,
    },
    { name: 'an empty accepts array', payload: paymentRequired([]), reason: /no accepts entry/ },
  ]

  for (const testCase of cases) {
    it(`refuses ${testCase.name}, pays nothing, and ends the Run failed at data`, async () => {
      const h = harness({})
      h.agent.unpaid = [{ kind: 'payment_required', payload: testCase.payload }]

      const outcome = await h.engine.execute(JOB)

      expect(outcome).toEqual({ outcome: 'ended', runId: 'run_1', status: 'failed at data' })
      const call = h.store.calls[0]!
      expect(call.status).toBe('price_mismatch')
      expect(call.failureReason).toMatch(testCase.reason)
      expect(call.endedAt).toEqual(START)
      // Both values, as FR-26 requires.
      expect(call.failureReason).toMatch(/expected .+, got .+/)
      expect(call.paymentRequired).toEqual(testCase.payload)
      expect(h.signPaymentCalls).toHaveLength(0)
      expect(h.agent.paidCalls).toHaveLength(0)
      expect(h.store.run.failureReason).toBe(call.failureReason)
    })
  }

  it('matches the first entry that carries the locked scheme, network and asset', async () => {
    const h = harness({})
    h.agent.unpaid = [
      {
        kind: 'payment_required',
        payload: paymentRequired([
          accepts({ network: 'eip155:56', amount: '1' }),
          accepts({ asset: OTHER, amount: '2' }),
          accepts(),
        ]),
      },
    ]
    h.agent.paid = [paidOk()]

    const outcome = await h.engine.execute(JOB)
    expect(outcome).toMatchObject({ status: 'completed' })
    expect(h.signPaymentCalls).toHaveLength(1)
  })
})

describe('failures before any payment', () => {
  it('fails the Call when the unpaid request times out', async () => {
    const h = harness({})
    h.agent.unpaid = [{ kind: 'timeout' }]

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'failed at data' })
    expect(h.store.calls[0]!.status).toBe('payment_failed')
    expect(h.store.calls[0]!.failureReason).toMatch(/unpaid request timed out after 15 s/)
    expect(h.signPaymentCalls).toHaveLength(0)
  })

  it('fails the Call when the Agent answers something other than 402', async () => {
    const h = harness({})
    h.agent.unpaid = [{ kind: 'unexpected', status: 500, detail: 'boom' }]

    await h.engine.execute(JOB)

    expect(h.store.calls[0]!.status).toBe('payment_failed')
    expect(h.store.calls[0]!.failureReason).toMatch(/answered 500 instead of 402/)
    expect(h.agent.paidCalls).toHaveLength(0)
  })

  it('records a signing-policy refusal as payment_failed with its reason', async () => {
    const h = harness({
      sign: () => ({
        ok: false,
        refusal: {
          code: 'refused_budget',
          check: 'daily_fee_budget',
          message: 'refused: budget. 0.01 tUSD over the remaining Daily Fee Budget.',
          details: {},
        },
      }),
    })

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'failed at data' })
    expect(h.store.calls[0]!.status).toBe('payment_failed')
    expect(h.store.calls[0]!.failureReason).toMatch(/refused: budget/)
    expect(h.agent.paidCalls).toHaveLength(0)
  })

  it('refuses a Node whose input the engine cannot build, before paying', async () => {
    const h = harness({
      calls: [pendingCall({ nodeType: 'research' })],
      run: { nodeTypes: ['research'] },
    })

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'failed at research' })
    expect(h.store.calls[0]!.status).toBe('payment_failed')
    expect(h.agent.unpaidCalls).toHaveLength(0)
    expect(h.signPaymentCalls).toHaveLength(0)
  })
})

describe('the paid request, retried once', () => {
  it('resends the same header after a timeout and succeeds on the second attempt', async () => {
    const h = harness({})
    h.agent.paid = [{ kind: 'timeout' }, paidOk()]

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'completed' })
    expect(h.agent.paidCalls).toHaveLength(2)
    expect(h.agent.paidCalls.map((call) => call.header)).toEqual([HEADER, HEADER])
    expect(h.signPaymentCalls).toHaveLength(1)
    expect(h.store.calls[0]!.attempt).toBe(2)
    expect(h.store.calls[0]!.status).toBe('succeeded')
  })

  it('never sends a third attempt', async () => {
    const h = harness({})
    h.agent.paid = [{ kind: 'timeout' }]

    await h.engine.execute(JOB)

    expect(h.agent.paidCalls).toHaveLength(2)
    expect(h.store.calls[0]!.attempt).toBe(2)
  })

  it('does not retry a 5xx, because a failed handler is never settled', async () => {
    const h = harness({})
    h.agent.paid = [{ kind: 'error', status: 500, detail: 'handler failed', settlement: null }]

    await h.engine.execute(JOB)

    expect(h.agent.paidCalls).toHaveLength(1)
    expect(h.store.calls[0]!.failureReason).toMatch(/answered 500/)
  })
})

describe('AD-6 resolution when no PAYMENT-RESPONSE arrives', () => {
  it('records payment_failed when the tUSD authorization is unused', async () => {
    const h = harness({ authorizationUsed: false })
    h.agent.paid = [{ kind: 'timeout' }]

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'failed at data' })
    expect(h.authorizationChecks).toEqual([{ authorizer: FROM, nonce: NONCE }])
    const call = h.store.calls[0]!
    expect(call.status).toBe('payment_failed')
    expect(call.paymentTxHash).toBeNull()
    expect(call.failureReason).toMatch(/authorization is unused, so nothing was paid/)
  })

  it('records failed_after_payment with a null hash when the authorization is used', async () => {
    const h = harness({ authorizationUsed: true })
    h.agent.paid = [{ kind: 'timeout' }]

    await h.engine.execute(JOB)

    const call = h.store.calls[0]!
    expect(call.status).toBe('failed_after_payment')
    expect(call.paymentTxHash).toBeNull()
    expect(call.failureReason).toMatch(/authorization is used/)
  })

  it('resolves a 200 that carried no PAYMENT-RESPONSE the same way', async () => {
    const h = harness({ authorizationUsed: true })
    h.agent.paid = [paidOk(DATA_OUTPUT, null)]

    await h.engine.execute(JOB)

    expect(h.authorizationChecks).toHaveLength(1)
    expect(h.store.calls[0]!.status).toBe('failed_after_payment')
    expect(h.store.calls[0]!.failureReason).toMatch(/no PAYMENT-RESPONSE header/)
  })

  it('lets a failed chain read fail the job rather than guess', async () => {
    const h = harness({ authorizationUsed: () => Promise.reject(new Error('rpc unreachable')) })
    h.agent.paid = [{ kind: 'timeout' }]

    await expect(h.engine.execute(JOB)).rejects.toThrow(/rpc unreachable/)
    // The Call is left `paid_awaiting_result`, so the redelivered job resolves it.
    expect(h.store.calls[0]!.status).toBe('paid_awaiting_result')
    expect(h.store.run.record.status).toBe('running')
  })
})

describe('failure after payment', () => {
  it('marks a settled 200 with an invalid output failed_after_payment and keeps the hash', async () => {
    const h = harness({})
    h.agent.paid = [paidOk({ ...DATA_OUTPUT, price: 'not a number' })]

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'failed at data' })
    const call = h.store.calls[0]!
    expect(call.status).toBe('failed_after_payment')
    expect(call.paymentTxHash).toBe(TX_HASH)
    expect(call.failureReason).toMatch(/failed output validation/)
    expect(h.authorizationChecks).toHaveLength(0)
  })

  it('rejects an output missing a required field', async () => {
    const h = harness({})
    const { volatility_24h_pct: _dropped, ...withoutVolatility } = DATA_OUTPUT
    h.agent.paid = [paidOk(withoutVolatility)]

    await h.engine.execute(JOB)

    expect(h.store.calls[0]!.status).toBe('failed_after_payment')
  })
})

describe('resuming after a crash', () => {
  it('resends the stored header for a paid Call with attempts left, signing nothing', async () => {
    const h = harness({
      calls: [
        pendingCall({
          status: 'paid_awaiting_result',
          attempt: 1,
          payload: STORED_PAYLOAD,
          request: { symbol: 'BNBUSDT' },
          startedAt: START,
        }),
      ],
    })
    h.agent.paid = [paidOk()]

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'completed' })
    expect(h.signPaymentCalls).toHaveLength(0)
    expect(h.agent.unpaidCalls).toHaveLength(0)
    expect(h.agent.paidCalls).toEqual([
      { endpoint: 'https://ticker.test/', input: { symbol: 'BNBUSDT' }, header: HEADER },
    ])
    expect(h.store.calls[0]!.attempt).toBe(2)
  })

  it('resolves a paid Call whose two attempts are already spent', async () => {
    const h = harness({
      authorizationUsed: true,
      calls: [
        pendingCall({
          status: 'paid_awaiting_result',
          attempt: 2,
          payload: STORED_PAYLOAD,
          request: { symbol: 'BNBUSDT' },
          startedAt: START,
        }),
      ],
    })

    await h.engine.execute(JOB)

    expect(h.agent.paidCalls).toHaveLength(0)
    expect(h.authorizationChecks).toHaveLength(1)
    expect(h.store.calls[0]!.status).toBe('failed_after_payment')
  })

  it('continues from the first non-terminal Call, leaving finished ones alone', async () => {
    const h = harness({
      run: { nodeTypes: ['data', 'data'] },
      calls: [
        pendingCall({
          callId: 'call_0',
          status: 'succeeded',
          response: DATA_OUTPUT,
          attempt: 1,
          paymentTxHash: TX_HASH,
        }),
        pendingCall({ callId: 'call_1', nodeIndex: 1 }),
      ],
    })
    h.store.run.record.priceLock = {
      ...PRICE_LOCK,
      nodes: [
        PRICE_LOCK.nodes[0]!,
        { ...PRICE_LOCK.nodes[0]!, node_index: 1 },
      ],
      total: '20000',
    }
    h.agent.paid = [paidOk()]

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'completed' })
    expect(h.store.calls[0]!.paymentTxHash).toBe(TX_HASH)
    expect(h.store.calls[0]!.attempt).toBe(1)
    expect(h.store.calls[1]!.status).toBe('succeeded')
    expect(h.signPaymentCalls).toHaveLength(1)
  })

  it('does nothing for a Run that is already terminal', async () => {
    const h = harness({ run: { status: 'completed' } })

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toEqual({ outcome: 'not_running', runId: 'run_1', status: 'completed' })
    expect(h.agent.unpaidCalls).toHaveLength(0)
  })

  it('reports a Run that does not exist', async () => {
    const h = harness({})
    expect(await h.engine.execute({ run_id: 'run_missing' })).toEqual({
      outcome: 'not_found',
      runId: 'run_missing',
    })
  })
})

describe('the 120 s budget', () => {
  it('ends the Run timed out before a Node and skips its pending Calls', async () => {
    const h = harness({
      run: { nodeTypes: ['data', 'data'] },
      calls: [pendingCall({ callId: 'call_0' }), pendingCall({ callId: 'call_1', nodeIndex: 1 })],
    })
    h.store.run.record.startedAt = START
    h.advance(RUN_DEADLINE_MS)

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'timed out' })
    expect(h.agent.unpaidCalls).toHaveLength(0)
    expect(h.store.calls.map((call) => call.status)).toEqual(['skipped', 'skipped'])
    expect(h.store.calls.map((call) => call.skipReason)).toEqual(['not_reached', 'not_reached'])
    expect(h.store.skipSweeps).toEqual([{ reason: 'not_reached', count: 2 }])
  })

  it('ends the Run timed out before the paid retry, resolving the in-flight Call', async () => {
    const h = harness({ authorizationUsed: false })
    h.store.run.record.startedAt = START
    h.agent.paid = [{ kind: 'timeout' }]
    h.agent.requestPaid = (endpoint, input, header) => {
      h.agent.paidCalls.push({ endpoint, input, header })
      h.advance(RUN_DEADLINE_MS)
      return Promise.resolve({ kind: 'timeout' })
    }

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'timed out' })
    // One attempt went out; the budget stopped the second.
    expect(h.agent.paidCalls).toHaveLength(1)
    expect(h.store.calls[0]!.status).toBe('payment_failed')
    expect(h.store.calls[0]!.failureReason).toMatch(/budget expired before the paid retry/)
    expect(h.store.run.record.status).toBe('timed out')
  })

  it('runs a Node that is inside the budget by a millisecond', async () => {
    const h = harness({})
    h.store.run.record.startedAt = START
    h.advance(RUN_DEADLINE_MS - 1)
    h.agent.paid = [paidOk()]

    expect(await h.engine.execute(JOB)).toMatchObject({ status: 'completed' })
  })
})

describe('the compare-and-set on the Run', () => {
  it('records the in-flight Call and exits when a second writer already ended the Run', async () => {
    const h = harness({})
    h.agent.paid = [paidOk()]
    h.store.endedByAnotherWriter = 'timed out'

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toEqual({ outcome: 'lost', runId: 'run_1', status: 'completed' })
    expect(h.store.endRunAttempts).toEqual([{ status: 'completed', applied: false }])
    // The Call is fully recorded even though the Run write lost.
    const call = h.store.calls[0]!
    expect(call.status).toBe('succeeded')
    expect(call.paymentTxHash).toBe(TX_HASH)
    // The winner owns the skip sweep; the loser must not run one.
    expect(h.store.skipSweeps).toHaveLength(0)
    expect(h.store.run.record.status).toBe('timed out')
  })

  it('records the failed Call and exits when the losing write is a failure', async () => {
    const h = harness({})
    h.agent.unpaid = [{ kind: 'payment_required', payload: paymentRequired([accepts({ amount: '1' })]) }]
    h.store.endedByAnotherWriter = 'timed out'

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ outcome: 'lost', status: 'failed at data' })
    expect(h.store.calls[0]!.status).toBe('price_mismatch')
    expect(h.store.run.record.status).toBe('timed out')
  })

  it('stops mid-Run when another writer ends the Run between two Nodes', async () => {
    const h = harness({
      run: { nodeTypes: ['data', 'data'] },
      calls: [pendingCall({ callId: 'call_0' }), pendingCall({ callId: 'call_1', nodeIndex: 1 })],
    })
    h.store.run.record.priceLock = {
      ...PRICE_LOCK,
      nodes: [PRICE_LOCK.nodes[0]!, { ...PRICE_LOCK.nodes[0]!, node_index: 1 }],
      total: '20000',
    }
    h.agent.paid = [paidOk()]
    const load = h.store.load.bind(h.store)
    let loads = 0
    h.store.load = (runId: string) => {
      loads += 1
      // The sweep lands after the first Node has been paid and recorded.
      if (loads === 2) h.store.run.record.status = 'timed out'
      return load(runId)
    }

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toEqual({ outcome: 'not_running', runId: 'run_1', status: 'timed out' })
    expect(h.store.calls[0]!.status).toBe('succeeded')
    expect(h.store.calls[1]!.status).toBe('pending')
    expect(h.store.endRunAttempts).toHaveLength(0)
  })
})

describe('the Run status the engine writes', () => {
  let h: Harness
  beforeEach(() => {
    h = harness({})
  })

  it('completes a Workflow with no execution Node', async () => {
    h.agent.paid = [paidOk()]
    await h.engine.execute(JOB)
    expect(h.store.run.record.status).toBe('completed')
    expect(h.store.run.failureReason).toBeNull()
    expect(h.store.run.endedAt).toEqual(START)
  })

  it('only ever writes a status the PRD enum allows', async () => {
    h.agent.paid = [paidOk()]
    await h.engine.execute(JOB)
    const written: (RunStatus | CallStatus)[] = [
      ...h.store.endRunAttempts.map((attempt) => attempt.status),
      ...h.store.calls.map((call) => call.status),
    ]
    for (const status of written) {
      expect(
        ['running', 'completed', 'completed, no order', 'timed out'].includes(status) ||
          status.startsWith('failed at ') ||
          [
            'pending',
            'price_mismatch',
            'payment_failed',
            'paid_awaiting_result',
            'succeeded',
            'failed_after_payment',
            'skipped',
          ].includes(status),
      ).toBe(true)
    }
  })
})
