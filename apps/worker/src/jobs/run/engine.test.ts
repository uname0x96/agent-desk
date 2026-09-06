import { beforeEach, describe, expect, it } from 'vitest'
import type { StoredPaymentPayload } from '@agent-desk/core/ports'
import { RUN_DEADLINE_MS } from '@agent-desk/core/run'
import type { CallStatus, RunStatus } from '@agent-desk/schemas'
import type { PaymentRequiredPayload, RunRecord } from './ports.ts'
import {
  ASSET,
  DATA_OUTPUT,
  FROM,
  HEADER,
  NONCE,
  OTHER,
  PAY_TO,
  PRICE_LOCK,
  START,
  STORED_PAYLOAD,
  TX_HASH,
  accepts,
  harness,
  paidOk,
  paymentRequired,
  pendingCall,
  type Harness,
} from './test-doubles.ts'

/**
 * The run engine over one Node, against the in-memory doubles of `test-doubles.ts`.
 *
 * Nothing here touches Postgres, a socket or a chain: the point is to pin the
 * *decisions* — which of the seven Call statuses is written, whether a signature
 * happens at all, how many paid attempts go out and with which header, what a
 * lost compare-and-set does. The five-Node chain, the skips, the order guards
 * and the terminal `notify` filter are in `chain.test.ts`; the real handshake
 * against a real chain is in the two integration files.
 */

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
