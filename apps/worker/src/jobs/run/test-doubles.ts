import type { Clock, StoredPaymentPayload } from '@agent-desk/core/ports'
import type { SigningOutcome, SignedPayment } from '@agent-desk/core/signing'
import type { AgentType, PriceLock, RunStatus, SkipReason } from '@agent-desk/schemas'
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
 * The in-memory doubles the engine's unit tests drive: a `RunStore` that
 * behaves like the SQL where it matters, an `AgentClient` with scripted
 * answers, and a `harness` that wires both into a real engine with a fake
 * clock, signer, chain and market-data read.
 *
 * They live in their own file because two suites need them — `engine.test.ts`
 * for one Node and the AD-6 payment paths, `chain.test.ts` for the five-Node
 * chain — and a double that drifts between two copies proves nothing.
 *
 * `FakeStore` mimics the two things about the SQL that matter: `endRun` is a
 * compare-and-set from `running` and reports whether it matched, and `skipCall`
 * is guarded on `pending` so a paid Call can never be rewritten as skipped.
 */

export const ASSET = '0xd0e0851ca8a176d211e2a410f5bcf1fa440fada7'
export const PAY_TO = '0x1e4a2f7d3c9b60518a7d3f2c4b8e91d0a6c73f52'
export const OTHER = '0x8b21c6d4e70f9a3b52c1d8e46f70a9b3c25d18e4'
export const FROM = '0xa71c3d90e5b28f4607c93d1a2b85e04f7d16c982'
export const NONCE = `0x${'ab'.repeat(32)}` as const
export const TX_HASH = `0x${'3c'.repeat(32)}`
export const HEADER = 'eyJzaWduZWQiOiJvbmNlIn0='
export const START = new Date('2026-09-06T12:00:00.000Z')
/** What the stubbed `ExchangeBalance` port answers unless a test says otherwise. */
export const BALANCE = '950.00'

export const PRICE_LOCK: PriceLock = {
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

export const DATA_OUTPUT = {
  symbol: 'BNBUSDT',
  price: '612.40',
  change_24h_pct: -1.8,
  volatility_24h_pct: 3.2,
  ts: '2026-09-06T12:00:03Z',
}

export function accepts(overrides: Partial<PaymentRequiredPayload['accepts'][number]> = {}) {
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

export function paymentRequired(
  entries: PaymentRequiredPayload['accepts'] = [accepts()],
): PaymentRequiredPayload {
  return { x402Version: 2, accepts: entries }
}

// ------------------------------------------------------------------ doubles

export interface StoredCall extends RunCallRecord {
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

export class FakeStore implements RunStore {
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
  skippedCalls: { callId: string; reason: SkipReason }[] = []

  constructor(options: { calls: StoredCall[]; run?: Partial<RunRecord> }) {
    this.calls = options.calls
    this.run = {
      record: {
        id: 'run_1',
        workflowId: 'wf_1',
        accountId: 'acc_1',
        walletId: 'wal_1',
        status: 'running',
        failureReason: null,
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
    this.run.record.failureReason = failureReason
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

  skipCall(callId: string, reason: SkipReason, at: Date): Promise<void> {
    const call = this.calls.find((candidate) => candidate.callId === callId)
    if (!call) throw new Error(`no call ${callId}`)
    // The SQL is guarded on `pending`; the double is too.
    if (call.status !== 'pending') return Promise.resolve()
    call.status = 'skipped'
    call.skipReason = reason
    call.endedAt = at
    this.skippedCalls.push({ callId, reason })
    return Promise.resolve()
  }

  readPaymentPayload(callId: string): Promise<StoredPaymentPayload | null> {
    return Promise.resolve(this.calls.find((call) => call.callId === callId)?.payload ?? null)
  }
}

export class FakeAgent implements AgentClient {
  unpaid: UnpaidResult[] = [{ kind: 'payment_required', payload: paymentRequired() }]
  paid: PaidResult[] = []
  /** Per-endpoint answers, for a chain whose Nodes are five different Agents. */
  unpaidFor = new Map<string, UnpaidResult>()
  paidFor = new Map<string, PaidResult>()
  /** A queue per endpoint, for one Node whose two paid attempts differ. */
  paidQueueFor = new Map<string, PaidResult[]>()
  unpaidCalls: { endpoint: string; input: unknown }[] = []
  paidCalls: { endpoint: string; input: unknown; header: string }[] = []

  requestUnpaid(endpoint: string, input: unknown): Promise<UnpaidResult> {
    this.unpaidCalls.push({ endpoint, input })
    const routed = this.unpaidFor.get(endpoint)
    if (routed) return Promise.resolve(routed)
    const next = this.unpaid.length > 1 ? this.unpaid.shift() : this.unpaid[0]
    return Promise.resolve(next ?? { kind: 'transport', detail: 'no scripted unpaid response' })
  }

  requestPaid(endpoint: string, input: unknown, header: string): Promise<PaidResult> {
    this.paidCalls.push({ endpoint, input, header })
    const queued = this.paidQueueFor.get(endpoint)
    if (queued && queued.length > 0) {
      return Promise.resolve(queued.length > 1 ? queued.shift()! : queued[0]!)
    }
    const routed = this.paidFor.get(endpoint)
    if (routed) return Promise.resolve(routed)
    const next = this.paid.length > 1 ? this.paid.shift() : this.paid[0]
    return Promise.resolve(next ?? { kind: 'transport', detail: 'no scripted paid response' })
  }

  /** Every paid request to one endpoint, for a Node with two attempts. */
  paidCallsTo(endpoint: string): { input: unknown; header: string }[] {
    return this.paidCalls.filter((call) => call.endpoint === endpoint)
  }

  /** Every endpoint this Agent client was asked for, in order. */
  endpointsRequested(): string[] {
    return this.unpaidCalls.map((call) => call.endpoint)
  }
}

export function paidOk(body: unknown = DATA_OUTPUT, transaction: string | null = TX_HASH): PaidResult {
  return {
    kind: 'ok',
    status: 200,
    body,
    settlement: transaction === null ? null : { success: true, transaction },
  }
}

export function pendingCall(overrides: Partial<StoredCall> = {}): StoredCall {
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

export const STORED_PAYLOAD: StoredPaymentPayload = {
  header: HEADER,
  nonce: NONCE,
  validAfter: '0',
  validBefore: '9999999999',
  from: FROM,
  to: PAY_TO,
  value: '10000',
  signature: `0x${'cd'.repeat(65)}`,
}

export interface Harness {
  store: FakeStore
  agent: FakeAgent
  engine: ReturnType<typeof createRunEngine>
  signPaymentCalls: unknown[]
  authorizationChecks: { authorizer: string; nonce: string }[]
  lastPriceCalls: string[]
  balanceReads: number[]
  now: Date
  advance(ms: number): void
}

export function harness(options: {
  calls?: StoredCall[]
  run?: Partial<RunRecord>
  sign?: () => SigningOutcome<SignedPayment>
  authorizationUsed?: boolean | (() => Promise<boolean>)
  lastPrice?: () => Promise<string>
  balanceUsdt?: () => Promise<string>
}): Harness {
  const store = new FakeStore({ calls: options.calls ?? [pendingCall()], ...(options.run ? { run: options.run } : {}) })
  const agent = new FakeAgent()
  const signPaymentCalls: unknown[] = []
  const authorizationChecks: { authorizer: string; nonce: string }[] = []
  const lastPriceCalls: string[] = []
  const balanceReads: number[] = []
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
    exchangeBalance: {
      balanceUsdt: () => {
        balanceReads.push(1)
        return options.balanceUsdt?.() ?? Promise.resolve(BALANCE)
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
    balanceReads,
    get now() {
      return state.now
    },
    advance(ms: number) {
      state.now = new Date(state.now.getTime() + ms)
    },
  }
}


// -------------------------------------------------------------- the chain

/**
 * The five-Node chain of PRD addendum §2 at its real prices, so a cost table
 * built from these Calls carries the figures the demo quotes: 0.01, 0.05, 0.02,
 * 0.01 and 0.005 tUSD, 0.095 in total.
 */
export const CHAIN_NODES = [
  { nodeType: 'data', provider: 'Binance Ticker', price: '10000' },
  { nodeType: 'research', provider: 'Alpha Research', price: '50000' },
  { nodeType: 'risk', provider: 'Guardrail Risk', price: '20000' },
  { nodeType: 'execution', provider: 'Binance Spot Executor', price: '10000' },
  { nodeType: 'notify', provider: 'Telegram Notifier', price: '5000' },
] as const satisfies readonly { nodeType: AgentType; provider: string; price: string }[]

export interface ChainNode {
  nodeType: AgentType
  provider: string
  /** Base units, AD-13. */
  price: string
}

export const CHAIN_OUTPUTS = {
  data: DATA_OUTPUT,
  research: { signal: 'LONG', confidence: 0.72, reason: 'Reclaimed the 24h midpoint.' },
  risk: { decision: 'REDUCE', size_usdt: '6', reason: '24h volatility above 3%.' },
  execution: {
    status: 'FILLED',
    order_id: '123456789',
    filled_price: '612.55',
    filled_qty: '0.0097',
    ts: '2026-09-06T12:00:07Z',
  },
  notify: { delivered: true, channel: 'telegram', message_ref: '4521' },
} as const

export function endpointFor(nodeType: AgentType): string {
  return `https://${nodeType}.test/`
}

/** A distinct settlement hash per Node, so a cost table can be told apart. */
const CHAIN_TX_SEEDS: Record<AgentType, string> = {
  data: '1a',
  research: '2b',
  risk: '3c',
  execution: '4d',
  notify: '5e',
}

export function chainTxHash(nodeType: AgentType): string {
  return `0x${CHAIN_TX_SEEDS[nodeType].repeat(32)}`
}

export function chainPriceLock(nodes: readonly ChainNode[] = CHAIN_NODES): PriceLock {
  return {
    nodes: nodes.map((node, index) => ({
      node_index: index,
      node_type: node.nodeType,
      listing_id: `lst_${node.nodeType}`,
      provider: node.provider,
      price: node.price,
      asset: ASSET,
      network: 'eip155:97',
      pay_to: PAY_TO,
    })),
    total: nodes.reduce((total, node) => total + BigInt(node.price), 0n).toString(),
    locked_at: '2026-09-06T12:00:00.000',
  }
}

export function chainCalls(nodes: readonly ChainNode[] = CHAIN_NODES): StoredCall[] {
  return nodes.map((node, index) =>
    pendingCall({
      callId: `call_${node.nodeType}`,
      nodeIndex: index,
      nodeType: node.nodeType,
      listingId: `lst_${node.nodeType}`,
      provider: node.provider,
      endpoint: endpointFor(node.nodeType),
      lockedPrice: node.price,
    }),
  )
}

export interface ChainHarnessOptions {
  nodes?: readonly ChainNode[]
  /** The Agent's paid answer per Type; the defaults are `CHAIN_OUTPUTS`. */
  responses?: Partial<Record<AgentType, PaidResult>>
  run?: Partial<RunRecord>
  calls?: StoredCall[]
  sign?: () => SigningOutcome<SignedPayment>
  balanceUsdt?: () => Promise<string>
  lastPrice?: () => Promise<string>
}

/**
 * A Run of the whole chain with each Node answered by its own endpoint, so a
 * test can change one Agent's answer — a HOLD, a REJECT, an over-cap size —
 * and assert what the engine does with the Nodes after it.
 */
export function chainHarness(options: ChainHarnessOptions = {}): Harness {
  const nodes = options.nodes ?? CHAIN_NODES
  const calls = options.calls ?? chainCalls(nodes)
  const h = harness({
    calls,
    run: {
      priceLock: chainPriceLock(nodes),
      nodeTypes: nodes.map((node) => node.nodeType),
      orderCapUsdt: '10',
      telegramChatId: '123456789',
      ...options.run,
    },
    ...(options.sign ? { sign: options.sign } : {}),
    ...(options.balanceUsdt ? { balanceUsdt: options.balanceUsdt } : {}),
    ...(options.lastPrice ? { lastPrice: options.lastPrice } : {}),
  })

  for (const node of nodes) {
    const endpoint = endpointFor(node.nodeType)
    h.agent.unpaidFor.set(endpoint, {
      kind: 'payment_required',
      payload: paymentRequired([accepts({ amount: node.price })]),
    })
    h.agent.paidFor.set(
      endpoint,
      options.responses?.[node.nodeType] ??
        paidOk(CHAIN_OUTPUTS[node.nodeType], chainTxHash(node.nodeType)),
    )
  }
  return h
}
