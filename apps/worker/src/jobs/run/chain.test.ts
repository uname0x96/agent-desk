import { describe, expect, it } from 'vitest'
import { REFUSALS, RUN_DEADLINE_MS } from '@agent-desk/core/run'
import type { AgentType } from '@agent-desk/schemas'
import {
  BALANCE,
  CHAIN_OUTPUTS,
  DATA_OUTPUT,
  START,
  chainHarness,
  chainTxHash,
  endpointFor,
  paidOk,
  pendingCall,
  type Harness,
  type StoredCall,
} from './test-doubles.ts'

/**
 * The five-Node chain: `data → research → risk → execution → notify` at the
 * seed prices of PRD addendum §2, against the same in-memory doubles as
 * `engine.test.ts`.
 *
 * What this file is for, and `engine.test.ts` is not: the *chain* decisions.
 * What each Node is sent (PRD addendum §1), which Nodes are skipped and why
 * (FR-24), the two order guards the engine owns (AD-11), and the terminal
 * `notify` filter that runs on every ending (AD-4, FR-29).
 */

const JOB = { run_id: 'run_1' }

/** The Nodes in the order the engine asked for them. */
function requested(h: Harness): string[] {
  return h.agent.endpointsRequested()
}

function requestTo(h: Harness, nodeType: AgentType): unknown {
  return h.agent.unpaidCalls.find((call) => call.endpoint === endpointFor(nodeType))?.input
}

function callOf(h: Harness, nodeType: AgentType): StoredCall {
  const call = h.store.calls.find((candidate) => candidate.nodeType === nodeType)
  if (!call) throw new Error(`no ${nodeType} call`)
  return call
}

function statuses(h: Harness): Record<string, string> {
  return Object.fromEntries(h.store.calls.map((call) => [call.nodeType, call.status]))
}

/** A Call as a redelivered job would find it: already paid and answered. */
function succeededCall(overrides: Partial<StoredCall>): StoredCall {
  return pendingCall({
    status: 'succeeded',
    attempt: 1,
    hasPaymentPayload: true,
    startedAt: START,
    endedAt: START,
    ...overrides,
  })
}

// ------------------------------------------------------------ the happy path

describe('the whole chain', () => {
  it('pays five Agents in order and builds every input from the Node before it', async () => {
    const h = chainHarness()

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toEqual({ outcome: 'ended', runId: 'run_1', status: 'completed' })
    expect(requested(h)).toEqual([
      endpointFor('data'),
      endpointFor('research'),
      endpointFor('risk'),
      endpointFor('execution'),
      endpointFor('notify'),
    ])
    expect(statuses(h)).toEqual({
      data: 'succeeded',
      research: 'succeeded',
      risk: 'succeeded',
      execution: 'succeeded',
      notify: 'succeeded',
    })

    // PRD addendum §1, field by field.
    expect(requestTo(h, 'data')).toEqual({ symbol: 'BNBUSDT' })
    expect(requestTo(h, 'research')).toEqual({ symbol: 'BNBUSDT', market: DATA_OUTPUT })
    expect(requestTo(h, 'risk')).toEqual({
      symbol: 'BNBUSDT',
      signal: 'LONG',
      confidence: 0.72,
      // The Workflow's Order Cap is the proposed size; the balance is the port's.
      proposed_size_usdt: '10',
      balance_usdt: BALANCE,
      market: DATA_OUTPUT,
    })
    expect(requestTo(h, 'execution')).toEqual({
      symbol: 'BNBUSDT',
      // LONG → BUY, and the size is the risk Node's, not the Order Cap.
      side: 'BUY',
      size_usdt: '6',
    })
  })

  it('sends the terminal filter the Run, not the Node before it', async () => {
    const h = chainHarness()

    await h.engine.execute(JOB)

    expect(requestTo(h, 'notify')).toEqual({
      run_id: 'run_1',
      recipient: { channel: 'telegram', address: '123456789' },
      summary: 'LONG BNBUSDT, reduced to 6 USDT, filled at 612.55',
      // AD-13 carve-out: decimal USDT in a Type payload. The notify Call itself
      // is still `pending` when its own message is built, so it is not listed.
      cost_table: [
        { node: 'data', provider: 'Binance Ticker', amount: '0.01', tx_hash: chainTxHash('data') },
        { node: 'research', provider: 'Alpha Research', amount: '0.05', tx_hash: chainTxHash('research') },
        { node: 'risk', provider: 'Guardrail Risk', amount: '0.02', tx_hash: chainTxHash('risk') },
        {
          node: 'execution',
          provider: 'Binance Spot Executor',
          amount: '0.01',
          tx_hash: chainTxHash('execution'),
        },
      ],
      tx_hashes: [
        chainTxHash('data'),
        chainTxHash('research'),
        chainTxHash('risk'),
        chainTxHash('execution'),
      ],
      order: CHAIN_OUTPUTS.execution,
    })
  })

  it('signs each Node at its own locked price', async () => {
    const h = chainHarness()

    await h.engine.execute(JOB)

    expect(h.signPaymentCalls.map((call) => (call as { requirements: { amount: string } }).requirements.amount)).toEqual([
      '10000',
      '50000',
      '20000',
      '10000',
      '5000',
    ])
  })

  it('completes with no order when the executor answers REJECTED', async () => {
    const rejected = {
      status: 'REJECTED',
      reason: 'emergency stop is on',
      ts: '2026-09-06T12:00:07Z',
    }
    const h = chainHarness({
      responses: { execution: paidOk(rejected, chainTxHash('execution')) },
    })

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'completed, no order' })
    expect(callOf(h, 'execution').status).toBe('succeeded')
    expect(requestTo(h, 'notify')).toMatchObject({
      summary: 'LONG BNBUSDT, reduced to 6 USDT, order rejected: emergency stop is on, no order',
      order: rejected,
    })
  })

  it('runs a chain without a notify Node and sends nothing', async () => {
    const nodes = [
      { nodeType: 'data' as const, provider: 'Binance Ticker', price: '10000' },
      { nodeType: 'research' as const, provider: 'Alpha Research', price: '50000' },
    ]
    const h = chainHarness({ nodes, run: { nodeTypes: ['data', 'research'] } })

    expect(await h.engine.execute(JOB)).toMatchObject({ status: 'completed' })
    expect(requested(h)).toEqual([endpointFor('data'), endpointFor('research')])
    expect(h.store.run.failureReason).toBeNull()
  })
})

// ------------------------------------------------------------- the balance

describe('the balance read before risk', () => {
  it('reads it once, after research and before the risk request', async () => {
    const seen: string[][] = []
    const h: Harness = chainHarness({
      balanceUsdt: () => {
        seen.push(requested(h))
        return Promise.resolve(BALANCE)
      },
    })

    await h.engine.execute(JOB)

    expect(h.balanceReads).toHaveLength(1)
    // AD-11: read just before the risk Node, and never cached across Runs.
    expect(seen).toEqual([[endpointFor('data'), endpointFor('research')]])
  })

  it('fails the risk Call before payment when the read throws, and still notifies', async () => {
    const h = chainHarness({
      balanceUsdt: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:4105')),
    })

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'failed at risk' })
    const risk = callOf(h, 'risk')
    expect(risk.status).toBe('payment_failed')
    expect(risk.failureReason).toBe(REFUSALS.balanceUnavailable)
    // Nothing was requested or signed for the risk Node.
    expect(requested(h)).toEqual([
      endpointFor('data'),
      endpointFor('research'),
      endpointFor('notify'),
    ])
    expect(h.signPaymentCalls).toHaveLength(3)
    // The Nodes after it are swept, and the Builder is told.
    expect(callOf(h, 'execution').status).toBe('skipped')
    expect(callOf(h, 'execution').skipReason).toBe('not_reached')
    expect(requestTo(h, 'notify')).toMatchObject({
      summary: `BNBUSDT failed at risk, ${REFUSALS.balanceUnavailable}, no order`,
      cost_table: [
        { node: 'data', provider: 'Binance Ticker', amount: '0.01', tx_hash: chainTxHash('data') },
        { node: 'research', provider: 'Alpha Research', amount: '0.05', tx_hash: chainTxHash('research') },
      ],
    })
    expect(callOf(h, 'notify').status).toBe('succeeded')
  })

  it('refuses the risk Node when the Workflow has no Order Cap', async () => {
    const h = chainHarness({ run: { orderCapUsdt: null } })

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'failed at risk' })
    expect(callOf(h, 'risk').failureReason).toBe(REFUSALS.noOrderCap)
    expect(h.balanceReads).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- the skips

describe('the skips', () => {
  it('skips risk and execution on a HOLD signal, requesting and paying neither', async () => {
    const hold = { signal: 'HOLD', confidence: 0.4, reason: 'Range-bound; no edge.' }
    const h = chainHarness({ responses: { research: paidOk(hold, chainTxHash('research')) } })

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'completed, no order' })
    expect(statuses(h)).toEqual({
      data: 'succeeded',
      research: 'succeeded',
      risk: 'skipped',
      execution: 'skipped',
      notify: 'succeeded',
    })
    expect(callOf(h, 'risk').skipReason).toBe('hold')
    expect(callOf(h, 'execution').skipReason).toBe('hold')
    // FR-24: never requested and never paid, so their locked prices leave the
    // AD-3 spend query the moment they stop being `pending`.
    expect(requested(h)).toEqual([
      endpointFor('data'),
      endpointFor('research'),
      endpointFor('notify'),
    ])
    expect(h.balanceReads).toHaveLength(0)
    expect(requestTo(h, 'notify')).toMatchObject({
      summary: 'HOLD BNBUSDT, no order',
      cost_table: [
        { node: 'data', provider: 'Binance Ticker', amount: '0.01', tx_hash: chainTxHash('data') },
        { node: 'research', provider: 'Alpha Research', amount: '0.05', tx_hash: chainTxHash('research') },
      ],
    })
  })

  it('skips execution on a REJECT decision and says why', async () => {
    const reject = { decision: 'REJECT', size_usdt: '0', reason: 'Daily loss limit hit.' }
    const h = chainHarness({ responses: { risk: paidOk(reject, chainTxHash('risk')) } })

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'completed, no order' })
    expect(callOf(h, 'risk').status).toBe('succeeded')
    expect(callOf(h, 'execution').status).toBe('skipped')
    expect(callOf(h, 'execution').skipReason).toBe('reject')
    expect(requested(h)).toContain(endpointFor('risk'))
    expect(requested(h)).not.toContain(endpointFor('execution'))
    expect(requestTo(h, 'notify')).toMatchObject({
      summary: 'LONG BNBUSDT, rejected by risk: Daily loss limit hit., no order',
    })
    // The risk Node was paid; the execution Node was not.
    expect(
      (requestTo(h, 'notify') as { cost_table: { node: string }[] }).cost_table.map((entry) => entry.node),
    ).toEqual(['data', 'research', 'risk'])
  })
})

// --------------------------------------------------------- the order guards

describe('the order guards', () => {
  it('refuses below the exchange minimum notional before paying the executor', async () => {
    // A legitimate REDUCE the exchange would reject: 3 ≤ the 10 Order Cap and
    // ≤ the balance, so it passes the risk Type's own cross-field rules.
    const small = { decision: 'REDUCE', size_usdt: '3', reason: 'Volatility above 5%.' }
    const h = chainHarness({ responses: { risk: paidOk(small, chainTxHash('risk')) } })

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'failed at execution' })
    const execution = callOf(h, 'execution')
    expect(execution.status).toBe('payment_failed')
    expect(execution.failureReason).toBe(REFUSALS.belowMinimumNotional)
    expect(requested(h)).not.toContain(endpointFor('execution'))
    // AD-4: notify still runs.
    expect(callOf(h, 'notify').status).toBe('succeeded')
    expect(requestTo(h, 'notify')).toMatchObject({
      summary: `BNBUSDT failed at execution, ${REFUSALS.belowMinimumNotional}, no order`,
    })
    expect(requestTo(h, 'notify')).not.toHaveProperty('order')
  })

  it('refuses a size above the Order Cap before paying the executor', async () => {
    // The risk Type's own rules already cap `size_usdt` at `proposed_size_usdt`,
    // so this state is only reachable from a stored row — a redelivered job over
    // a Run whose risk output was written before the Cap was what it is now.
    // The guard is the engine's, so the engine is where it is tested.
    const h = chainHarness({
      calls: [
        succeededCall({
          callId: 'call_data',
          nodeIndex: 0,
          nodeType: 'data',
          listingId: 'lst_data',
          provider: 'Binance Ticker',
          endpoint: endpointFor('data'),
          lockedPrice: '10000',
          response: CHAIN_OUTPUTS.data,
        }),
        succeededCall({
          callId: 'call_research',
          nodeIndex: 1,
          nodeType: 'research',
          listingId: 'lst_research',
          provider: 'Alpha Research',
          endpoint: endpointFor('research'),
          lockedPrice: '50000',
          response: CHAIN_OUTPUTS.research,
        }),
        succeededCall({
          callId: 'call_risk',
          nodeIndex: 2,
          nodeType: 'risk',
          listingId: 'lst_risk',
          provider: 'Guardrail Risk',
          endpoint: endpointFor('risk'),
          lockedPrice: '20000',
          response: { decision: 'APPROVE', size_usdt: '12', reason: 'Cleared.' },
        }),
        pendingCall({
          callId: 'call_execution',
          nodeIndex: 3,
          nodeType: 'execution',
          listingId: 'lst_execution',
          provider: 'Binance Spot Executor',
          endpoint: endpointFor('execution'),
          lockedPrice: '10000',
        }),
        pendingCall({
          callId: 'call_notify',
          nodeIndex: 4,
          nodeType: 'notify',
          listingId: 'lst_notify',
          provider: 'Telegram Notifier',
          endpoint: endpointFor('notify'),
          lockedPrice: '5000',
        }),
      ],
    })

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'failed at execution' })
    const execution = callOf(h, 'execution')
    expect(execution.status).toBe('payment_failed')
    expect(execution.failureReason).toBe(REFUSALS.orderCapExceeded)
    expect(requested(h)).toEqual([endpointFor('notify')])
    expect(requestTo(h, 'notify')).toMatchObject({
      summary: `BNBUSDT failed at execution, ${REFUSALS.orderCapExceeded}, no order`,
    })
  })
})

// ------------------------------------------------------- the terminal filter

describe('the terminal notify filter', () => {
  it('fails the Run at notify when the Builder has no chat id linked', async () => {
    const h = chainHarness({ run: { telegramChatId: null } })

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'failed at notify' })
    expect(h.store.run.failureReason).toBe(REFUSALS.noTelegramChatId)
    const notify = callOf(h, 'notify')
    expect(notify.status).toBe('payment_failed')
    expect(notify.failureReason).toBe(REFUSALS.noTelegramChatId)
    // The chain itself succeeded and was paid for; only the message failed.
    expect(requested(h)).not.toContain(endpointFor('notify'))
    expect(callOf(h, 'execution').status).toBe('succeeded')
  })

  it('runs on a timed-out Run and says so', async () => {
    const h = chainHarness()
    h.store.run.record.startedAt = START
    h.advance(RUN_DEADLINE_MS)

    const outcome = await h.engine.execute(JOB)

    expect(outcome).toMatchObject({ status: 'timed out' })
    // Not one chain Node was requested; the message still went out.
    expect(requested(h)).toEqual([endpointFor('notify')])
    expect(callOf(h, 'notify').status).toBe('succeeded')
    expect(requestTo(h, 'notify')).toMatchObject({
      summary: 'BNBUSDT timed out, the Run exceeded its 120 s budget, no order',
      cost_table: [],
      tx_hashes: [],
    })
    expect(statuses(h)).toMatchObject({ data: 'skipped', execution: 'skipped' })
  })

  it('retries its own paid attempt past the Run budget', async () => {
    const h = chainHarness()
    h.store.run.record.startedAt = START
    h.advance(RUN_DEADLINE_MS)
    h.agent.paidQueueFor.set(endpointFor('notify'), [
      { kind: 'timeout' },
      paidOk(CHAIN_OUTPUTS.notify, chainTxHash('notify')),
    ])

    expect(await h.engine.execute(JOB)).toMatchObject({ status: 'timed out' })
    // AD-4: the filter runs *because* the budget is gone, so its own retry
    // cannot be refused on that budget.
    expect(h.agent.paidCallsTo(endpointFor('notify'))).toHaveLength(2)
    expect(callOf(h, 'notify').status).toBe('succeeded')
  })

  it('keeps the failing Node in the Run status when notify also fails', async () => {
    const h = chainHarness({
      balanceUsdt: () => Promise.reject(new Error('no executor')),
      responses: { notify: { kind: 'error', status: 500, detail: 'bot API down', settlement: null } },
    })

    const outcome = await h.engine.execute(JOB)

    // The Run failed at risk; a notify failure does not overwrite that.
    expect(outcome).toMatchObject({ status: 'failed at risk' })
    expect(h.store.run.failureReason).toBe(REFUSALS.balanceUnavailable)
    expect(callOf(h, 'notify').status).toBe('payment_failed')
  })
})

// ------------------------------------------------------------ the finalize

describe('a finalize delivery', () => {
  it('runs only the terminal filter and never rewrites the Run status', async () => {
    const h = chainHarness({
      run: { status: 'timed out', failureReason: 'the Run exceeded its 120 s budget' },
      calls: [
        succeededCall({
          callId: 'call_data',
          nodeIndex: 0,
          nodeType: 'data',
          endpoint: endpointFor('data'),
          lockedPrice: '10000',
          provider: 'Binance Ticker',
          paymentTxHash: chainTxHash('data'),
          response: CHAIN_OUTPUTS.data,
        }),
        pendingCall({
          callId: 'call_notify',
          nodeIndex: 4,
          nodeType: 'notify',
          listingId: 'lst_notify',
          provider: 'Telegram Notifier',
          endpoint: endpointFor('notify'),
          lockedPrice: '5000',
        }),
      ],
    })

    const outcome = await h.engine.execute({ run_id: 'run_1', finalize: true })

    expect(outcome).toEqual({ outcome: 'finalized', runId: 'run_1', status: 'timed out' })
    expect(h.store.endRunAttempts).toHaveLength(0)
    expect(h.store.run.record.status).toBe('timed out')
    expect(callOf(h, 'notify').status).toBe('succeeded')
    expect(requestTo(h, 'notify')).toMatchObject({
      summary: 'BNBUSDT timed out, the Run exceeded its 120 s budget',
      cost_table: [
        { node: 'data', provider: 'Binance Ticker', amount: '0.01', tx_hash: chainTxHash('data') },
      ],
    })
  })

  it('sends nothing a second time when the filter already ran', async () => {
    const h = chainHarness()

    await h.engine.execute(JOB)
    const before = h.agent.paidCallsTo(endpointFor('notify')).length
    const outcome = await h.engine.execute({ run_id: 'run_1', finalize: true })

    expect(before).toBe(1)
    expect(outcome).toEqual({ outcome: 'finalized', runId: 'run_1', status: 'completed' })
    expect(h.agent.paidCallsTo(endpointFor('notify'))).toHaveLength(1)
  })
})
