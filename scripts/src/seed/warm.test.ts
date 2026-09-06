import { describe, expect, it } from 'vitest'
import type { AgentType, CallStatus, NotScoredReason, SettlementResult } from '@agent-desk/schemas'
import {
  WARM_RUNS,
  describeResult,
  describeRunEnd,
  formatWarmSecretGaps,
  missingWarmSecrets,
  pollUntil,
  riskCallAcceptable,
  settlementExpected,
  warmVerdict,
  type WarmCall,
  type WarmRunRecord,
} from './warm.ts'

/**
 * Story 4.6's two decisions, tested without a database, a chain or a worker: the
 * exit condition and the timeout. Both are the reason the warm-up can be trusted
 * to end — one says whether it worked, the other says it cannot hang.
 */

function call(over: Partial<WarmCall> = {}): WarmCall {
  return {
    callId: 'call_0000000000000000000000001',
    listingId: 'lst_0000000000000000SEEDAPHA01',
    nodeType: 'research' as AgentType,
    status: 'succeeded' as CallStatus,
    skipReason: null,
    result: 'passed' as SettlementResult,
    notScoredReason: null,
    ruleLabel: 'demo settlement rule: 24h trend',
    reputationTxHash: `0x${'a'.repeat(64)}`,
    ...over,
  }
}

/** One good-chain Run: research passed, risk not scored because nothing filled. */
function goodRun(index: number, over: Partial<WarmCall> = {}): WarmRunRecord {
  return {
    runId: `run_000000000000000000000000${index}`,
    status: 'completed',
    failureReason: null,
    scoredCalls: [
      call({ callId: `call_research_${index}` }),
      call({
        callId: `call_risk_${index}`,
        nodeType: 'risk',
        listingId: 'lst_0000000000000000000SEEDRSK01',
        result: 'not_scored',
        notScoredReason: 'no_fill' as NotScoredReason,
        ruleLabel: 'risk rule: 2% drawdown in window',
        reputationTxHash: null,
        ...over,
      }),
    ],
  }
}

const PERFECT = { bps: 10_000, scoredCallCount: WARM_RUNS }

describe('warmVerdict', () => {
  it('passes on three Runs with Alpha at 100 % and every risk Call not_scored (no_fill)', () => {
    const verdict = warmVerdict({
      runs: [goodRun(1), goodRun(2), goodRun(3)],
      alphaResearch: PERFECT,
    })
    expect(verdict).toEqual({ ok: true, failures: [] })
  })

  it('passes when the risk Calls were scored and passed instead', () => {
    const runs = [1, 2, 3].map((index) =>
      goodRun(index, { result: 'passed', notScoredReason: null }),
    )
    expect(warmVerdict({ runs, alphaResearch: PERFECT }).ok).toBe(true)
  })

  it('fails when Alpha Research is not at 100 percent', () => {
    const verdict = warmVerdict({
      runs: [goodRun(1), goodRun(2), goodRun(3)],
      alphaResearch: { bps: 6_667, scoredCallCount: 3 },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toContain('Alpha Research reads 66.67 %, not 100 %')
  })

  it('fails when Alpha Research has no score at all', () => {
    const verdict = warmVerdict({
      runs: [goodRun(1), goodRun(2), goodRun(3)],
      alphaResearch: { bps: null, scoredCallCount: 0 },
    })
    expect(verdict.failures).toContain('Alpha Research reads no score yet, not 100 %')
    expect(verdict.failures).toContain('Alpha Research has 0 scored Calls, not 3')
  })

  it('fails when fewer than three Calls were scored, even at 100 percent', () => {
    // Two passing Calls are also 10 000 bps; NFR-2 asks for three.
    const verdict = warmVerdict({
      runs: [goodRun(1), goodRun(2), goodRun(3)],
      alphaResearch: { bps: 10_000, scoredCallCount: 2 },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toContain('Alpha Research has 2 scored Calls, not 3')
  })

  it('fails when fewer than three Runs were started', () => {
    const verdict = warmVerdict({ runs: [goodRun(1)], alphaResearch: PERFECT })
    expect(verdict.failures).toContain('1 of 3 Runs were started')
  })

  it('fails on a risk Call that is not_scored for any other reason', () => {
    const runs = [
      goodRun(1),
      goodRun(2),
      goodRun(3, { result: 'not_scored', notScoredReason: 'reject_decision' }),
    ]
    const verdict = warmVerdict({ runs, alphaResearch: PERFECT })
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.some((line) => line.includes('not_scored (reject_decision)'))).toBe(true)
  })

  it('fails on a risk Call that was scored failed', () => {
    const runs = [goodRun(1), goodRun(2), goodRun(3, { result: 'failed', notScoredReason: null })]
    const verdict = warmVerdict({ runs, alphaResearch: PERFECT })
    expect(verdict.failures.some((line) => line.includes('the risk Call is failed'))).toBe(true)
  })

  it('fails on a risk Call that was skipped, and says the Call was skipped', () => {
    const runs = [
      goodRun(1),
      goodRun(2),
      goodRun(3, { status: 'skipped', skipReason: 'hold', result: null, notScoredReason: null }),
    ]
    const verdict = warmVerdict({ runs, alphaResearch: PERFECT })
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.some((line) => line.includes('skipped: hold'))).toBe(true)
  })

  it('fails when a paid Call that AD-9 must settle has no settlements row', () => {
    const runs = [
      goodRun(1),
      goodRun(2),
      { ...goodRun(3), scoredCalls: [call({ callId: 'call_x', result: null, notScoredReason: null })] },
    ]
    const verdict = warmVerdict({ runs, alphaResearch: PERFECT })
    expect(verdict.failures.some((line) => line.includes('has no Settlement'))).toBe(true)
  })

  it('fails when a Run never ended', () => {
    const runs = [goodRun(1), goodRun(2), { ...goodRun(3), status: 'running' }]
    const verdict = warmVerdict({ runs, alphaResearch: PERFECT })
    expect(verdict.failures.some((line) => line.includes('is still running'))).toBe(true)
  })

  it('fails when no risk Call was settled at all', () => {
    const runs = [1, 2, 3].map((index) => ({
      ...goodRun(index),
      scoredCalls: [call({ callId: `call_research_${index}` })],
    }))
    const verdict = warmVerdict({ runs, alphaResearch: PERFECT })
    expect(verdict.failures).toContain('no Guardrail Risk Call was settled')
  })
})

describe('settlementExpected', () => {
  it('is true for exactly the two statuses AD-9 settles', () => {
    expect(settlementExpected('succeeded')).toBe(true)
    expect(settlementExpected('failed_after_payment')).toBe(true)
    for (const status of ['pending', 'price_mismatch', 'payment_failed', 'paid_awaiting_result', 'skipped'] as const) {
      expect(settlementExpected(status)).toBe(false)
    }
  })
})

describe('riskCallAcceptable', () => {
  it('accepts passed and not_scored (no_fill), and nothing else', () => {
    expect(riskCallAcceptable(call({ result: 'passed' }))).toBe(true)
    expect(riskCallAcceptable(call({ result: 'not_scored', notScoredReason: 'no_fill' }))).toBe(true)
    expect(riskCallAcceptable(call({ result: 'failed' }))).toBe(false)
    expect(riskCallAcceptable(call({ result: 'not_scored', notScoredReason: 'reject_decision' }))).toBe(false)
    expect(riskCallAcceptable(call({ result: 'not_scored', notScoredReason: 'no_reference_price' }))).toBe(false)
    expect(riskCallAcceptable(call({ result: null, notScoredReason: null }))).toBe(false)
  })
})

describe('describeResult', () => {
  it('says why a Call has no Settlement rather than just "unsettled"', () => {
    expect(describeResult(call({ status: 'skipped', skipReason: 'reject', result: null }))).toBe(
      'unsettled (the Call was skipped: reject)',
    )
    expect(describeResult(call({ status: 'payment_failed', result: null }))).toBe(
      'unsettled (the Call is payment_failed)',
    )
    expect(describeResult(call({ result: 'not_scored', notScoredReason: 'no_fill' }))).toBe(
      'not_scored (no_fill)',
    )
    expect(describeResult(call({ result: 'passed' }))).toBe('passed')
  })
})

describe('describeRunEnd', () => {
  it('names the secret a failed Node needs', () => {
    expect(
      describeRunEnd({ runId: 'run_1', status: 'failed at research', failureReason: 'handler 500' }),
    ).toContain('ANTHROPIC_API_KEY')
    expect(
      describeRunEnd({ runId: 'run_1', status: 'failed at execution', failureReason: 'timeout' }),
    ).toContain('EXCHANGE_API_KEY')
    expect(
      describeRunEnd({ runId: 'run_1', status: 'failed at notify', failureReason: 'no chat id' }),
    ).toContain('TELEGRAM_BOT_TOKEN')
  })

  it('says how a Run ended when nothing failed, and when a Node has no secret', () => {
    // A Run that did not fail has no `failure_reason`, and saying so as
    // "no reason recorded" reads like a defect rather than a healthy Run.
    expect(describeRunEnd({ runId: 'run_1', status: 'completed', failureReason: null })).toBe(
      'run_1 ended completed',
    )
    expect(
      describeRunEnd({ runId: 'run_1', status: 'completed, no order', failureReason: null }),
    ).toBe('run_1 ended completed, no order')
    expect(
      describeRunEnd({ runId: 'run_1', status: 'failed at risk', failureReason: 'refused_stake' }),
    ).toBe('run_1 ended failed at risk: refused_stake')
  })
})

describe('missingWarmSecrets', () => {
  /** Everything the good chain needs, so a blank one can be introduced on its own. */
  const FILLED: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: 'sk-ant-x',
    EXCHANGE_API_KEY: 'key',
    EXCHANGE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
    TELEGRAM_BOT_TOKEN: '1:abc',
  }

  it('finds nothing when the keys are there', () => {
    expect(missingWarmSecrets(FILLED)).toEqual([])
  })

  it('names ANTHROPIC_API_KEY, which is why a Run ends `failed at research`', () => {
    const gaps = missingWarmSecrets({ ...FILLED, ANTHROPIC_API_KEY: '' })
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.node).toBe('research')
    expect(gaps[0]?.keys).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('treats whitespace as blank, because a dotenv line can be `KEY= `', () => {
    expect(missingWarmSecrets({ ...FILLED, TELEGRAM_BOT_TOKEN: '   ' }).map((g) => g.node)).toEqual([
      'notify',
    ])
  })

  it('accepts either exchange pair, since EXCHANGE_BASE_URL decides which is read', () => {
    const testnetOnly = { ...FILLED }
    const demoOnly: NodeJS.ProcessEnv = {
      ...FILLED,
      EXCHANGE_API_KEY: '',
      EXCHANGE_PRIVATE_KEY: '',
      EXCHANGE_DEMO_API_KEY: 'key',
      EXCHANGE_DEMO_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
    }
    expect(missingWarmSecrets(testnetOnly)).toEqual([])
    expect(missingWarmSecrets(demoOnly)).toEqual([])
  })

  it('asks for both pairs by name when neither is filled in', () => {
    const gaps = missingWarmSecrets({ ...FILLED, EXCHANGE_API_KEY: '', EXCHANGE_PRIVATE_KEY: '' })
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.keys).toEqual([
      'EXCHANGE_API_KEY',
      'EXCHANGE_PRIVATE_KEY',
      'EXCHANGE_DEMO_API_KEY',
      'EXCHANGE_DEMO_PRIVATE_KEY',
    ])
  })

  it('reports every gap at once, so an empty .env is one round of filling in', () => {
    expect(missingWarmSecrets({}).map((gap) => gap.node)).toEqual([
      'research',
      'execution',
      'notify',
    ])
  })

  it('prints one NOTE line per gap and never a refusal', () => {
    const lines = formatWarmSecretGaps(missingWarmSecrets({}))
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(line).toContain('NOTE')
    expect(lines.join('\n')).toContain('ANTHROPIC_API_KEY')
  })
})

// ------------------------------------------------------------------ the timeout

/** A clock the test moves, so a 90 second wait costs no wall-clock time. */
function fakeClock(startMs = 0) {
  let current = startMs
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms
    },
    advance: (ms: number) => {
      current += ms
    },
  }
}

describe('pollUntil', () => {
  it('returns as soon as the condition holds, without sleeping first', async () => {
    const clock = fakeClock()
    let reads = 0
    const result = await pollUntil({
      what: 'the Run to end',
      read: async () => {
        reads += 1
        return reads
      },
      done: (value) => value >= 3,
      timeoutMs: 60_000,
      pollMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(result.ok).toBe(true)
    expect(result.value).toBe(3)
    expect(reads).toBe(3)
    // Two sleeps between three reads.
    expect(result.waitedMs).toBe(2_000)
  })

  it('gives up at the deadline and says what it was waiting for and what it saw', async () => {
    const clock = fakeClock()
    const result = await pollUntil({
      what: 'Run run_1 to end',
      read: async () => ({ status: 'running' }),
      done: () => false,
      timeoutMs: 5_000,
      pollMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
      describe: (value) => `it is ${value.status}`,
    })

    expect(result.ok).toBe(false)
    expect(result.value).toEqual({ status: 'running' })
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe(
      'timed out after 5 s waiting for Run run_1 to end; it is running',
    )
    expect(result.waitedMs).toBe(5_000)
  })

  it('never loops forever: a condition that is never true still returns', async () => {
    const clock = fakeClock()
    let reads = 0
    const result = await pollUntil({
      what: 'nothing',
      read: async () => {
        reads += 1
      },
      done: () => false,
      timeoutMs: 10,
      pollMs: 1,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(result.ok).toBe(false)
    expect(reads).toBe(11)
  })

  it('keeps polling through a read that throws, and reports the last error on timeout', async () => {
    const clock = fakeClock()
    let reads = 0
    const result = await pollUntil({
      what: 'the Settlements',
      read: async () => {
        reads += 1
        throw new Error(`database is down (${reads})`)
      },
      done: () => true,
      timeoutMs: 3_000,
      pollMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(result.ok).toBe(false)
    expect(reads).toBe(4)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('the last read failed: database is down (4)')
  })

  it('recovers when a later read succeeds after an earlier one threw', async () => {
    const clock = fakeClock()
    let reads = 0
    const result = await pollUntil({
      what: 'the Run to end',
      read: async () => {
        reads += 1
        if (reads < 3) throw new Error('connection reset')
        return 'completed'
      },
      done: (value) => value === 'completed',
      timeoutMs: 60_000,
      pollMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(result).toMatchObject({ ok: true, value: 'completed' })
  })

  it('says "nothing was read" when the very first read is past the deadline', async () => {
    const clock = fakeClock()
    const result = await pollUntil({
      what: 'the worker',
      read: async () => {
        clock.advance(10_000)
        throw new Error('timeout')
      },
      done: () => true,
      timeoutMs: 1_000,
      pollMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(result.ok).toBe(false)
    expect(result.value).toBeUndefined()
  })
})
