import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  accounts,
  calls,
  listings,
  platformSettings,
  runs,
  settlements,
  wallets,
  workflows,
  type Database,
} from '@agent-desk/db'
import { newId, toBaseUnits, type PriceLock, type RunStatus } from '@agent-desk/schemas'
import { TEST_DATABASE_URL, databaseLock, databaseReachable, resetDatabase, testDb } from '../test-db.ts'
import { SEED_AGENTS, seedAgent } from './agents.ts'
import { parseSeedEnv } from './env.ts'
import { SEED_DEMO_BUILDER, SEED_DEMO_DAILY_FEE_BUDGET, SEED_GOOD_CHAIN } from './fixtures.ts'
import { SeedRefused } from './refusal.ts'
import { formatWarmSummary, runWarmUp, type RunStarter } from './warm.ts'

/**
 * `runWarmUp` against real Postgres, with the worker played by the test.
 *
 * The exit condition and the timeout are unit tested in `warm.test.ts` over
 * fixture values. What is left — and what a demo actually depends on — is the
 * loop around them: that it waits for a Run to end before starting the next one,
 * that it stops waiting for a Settlement that AD-9 will never write, and that
 * every unhappy path ends rather than hangs. All three are properties of the
 * SQL and the polling together, so they are here.
 *
 * The Runs are inserted by a stub `RunStarter` rather than by `POST /api/runs`:
 * the web app is a separate process, and AD-4's rule that only web inserts a Run
 * is about the production path, not about who writes a fixture.
 */

const HAVE_POSTGRES = await databaseReachable()
const db: Database = testDb()
const lock = databaseLock()

const ADDRESS = '0x00000000000000000000000000000000000000aa'
const PAY_TO = '0x00000000000000000000000000000000000000bb'
const TX = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`

const lines: string[] = []
const log = (line: string): void => {
  lines.push(line)
}

const seedEnv = parseSeedEnv({})

let walletId: string

const PRICE_LOCK: PriceLock = {
  nodes: [],
  total: '0',
  locked_at: '2026-09-06T12:00:00.000',
}

/** The demo Builder, a wallet to pay from, and the six Seed Listings. */
async function fixtures(): Promise<void> {
  await db.insert(accounts).values({
    id: SEED_DEMO_BUILDER.accountId,
    email: SEED_DEMO_BUILDER.email,
    passwordHash: SEED_DEMO_BUILDER.passwordHash,
    dailyFeeBudget: SEED_DEMO_DAILY_FEE_BUDGET,
    budgetWindowStart: new Date(0),
  })
  walletId = newId('wallet')
  await db.insert(wallets).values({
    id: walletId,
    accountId: SEED_DEMO_BUILDER.accountId,
    address: ADDRESS,
    encryptedKey: 'gcm1.a.b.c',
  })
  for (const agent of SEED_AGENTS) {
    await db.insert(listings).values({
      id: agent.listingId,
      creatorAccountId: SEED_DEMO_BUILDER.accountId,
      name: agent.name,
      type: agent.type,
      endpoint: `http://localhost:${agent.port}`,
      declaredPrice: toBaseUnits(agent.priceUsdt).toString(),
      declaredStake: toBaseUnits(agent.stakeUsdt).toString(),
      payoutWallet: PAY_TO,
      status: 'active',
      price: toBaseUnits(agent.priceUsdt).toString(),
      stake: toBaseUnits(agent.stakeUsdt).toString(),
    })
  }
  // The warm-up refuses outside demo mode and without a live worker (addendum §6).
  await db
    .update(platformSettings)
    .set({ mode: 'demo', workerSeenAt: new Date() })
    .where(eq(platformSettings.id, 1))
  await db.insert(workflows).values({
    id: SEED_GOOD_CHAIN.workflowId,
    accountId: SEED_DEMO_BUILDER.accountId,
    name: SEED_GOOD_CHAIN.name,
    symbol: SEED_GOOD_CHAIN.symbol,
    orderCapUsdt: SEED_GOOD_CHAIN.orderCapUsdt,
  })
}

/** A Run row of the good chain, as `POST /api/runs` would insert it (AD-4). */
async function insertRun(workflowId: string): Promise<string> {
  const runId = newId('run')
  await db.insert(runs).values({
    id: runId,
    workflowId,
    accountId: SEED_DEMO_BUILDER.accountId,
    walletId,
    status: 'running',
    priceLock: PRICE_LOCK,
  })
  return runId
}

/** What the worker does to a Run: two paid Calls, an end status, two Settlements. */
async function finishRun(
  runId: string,
  options: {
    status?: RunStatus
    research?: { result: 'passed' | 'failed'; tx: string } | null
    risk?: { result: 'not_scored'; reason: 'no_fill' } | { result: 'passed' } | null
    riskCallStatus?: 'succeeded' | 'skipped'
  } = {},
): Promise<void> {
  const researchCallId = newId('call')
  const riskCallId = newId('call')
  const research = seedAgent('alpha-research')
  const risk = seedAgent('guardrail-risk')

  for (const [callId, agent, nodeIndex, status] of [
    [researchCallId, research, 1, 'succeeded'],
    [riskCallId, risk, 2, options.riskCallStatus ?? 'succeeded'],
  ] as const) {
    await db.insert(calls).values({
      id: callId,
      runId,
      kind: 'run',
      listingId: agent.listingId,
      nodeIndex,
      nodeType: agent.type,
      status,
      lockedPrice: toBaseUnits(agent.priceUsdt).toString(),
      lockedPayTo: PAY_TO,
      lockedAsset: PAY_TO,
      lockedNetwork: 'eip155:97',
      // Research answered HOLD, so the Nodes after it are never reached.
      skipReason: status === 'skipped' ? 'hold' : null,
    })
  }

  await db
    .update(runs)
    .set({ status: options.status ?? 'completed, no order', endedAt: new Date() })
    .where(eq(runs.id, runId))

  if (options.research !== null) {
    const outcome = options.research ?? { result: 'passed' as const, tx: TX(1) }
    await db.insert(settlements).values({
      id: newId('settlement'),
      callId: researchCallId,
      listingId: research.listingId,
      result: outcome.result,
      mode: 'demo',
      ruleLabel: 'demo settlement rule: 24h trend',
      scoredAt: new Date(),
      reputationTxHash: outcome.tx,
    })
  }
  if (options.risk !== null && (options.riskCallStatus ?? 'succeeded') === 'succeeded') {
    const outcome = options.risk ?? { result: 'not_scored' as const, reason: 'no_fill' as const }
    await db.insert(settlements).values({
      id: newId('settlement'),
      callId: riskCallId,
      listingId: risk.listingId,
      result: outcome.result,
      notScoredReason: 'reason' in outcome ? outcome.reason : null,
      mode: 'demo',
      ruleLabel: 'demo settlement rule: 24h trend',
      scoredAt: new Date(),
      reputationTxHash: TX(2),
    })
  }
}

/** AD-2: only `refreshListingFromChain` writes this; the test plays the chain. */
async function setReputation(bps: number): Promise<void> {
  await db
    .update(listings)
    .set({ reputationBps: bps })
    .where(eq(listings.id, seedAgent('alpha-research').listingId))
}

/**
 * A `RunStarter` that inserts the Run and then hands it to `after`, which stands
 * in for the worker executing it.
 */
function starterThat(after: (runId: string, index: number) => Promise<void>): RunStarter {
  let index = 0
  return {
    async start(workflowId: string): Promise<string> {
      const runId = await insertRun(workflowId)
      await after(runId, index)
      index += 1
      return runId
    },
  }
}

function warm(over: Partial<Parameters<typeof runWarmUp>[0]> = {}) {
  return runWarmUp({
    db,
    env: seedEnv,
    explorerUrl: 'https://testnet.bscscan.com',
    builder: SEED_DEMO_BUILDER,
    log,
    // Short, because every wait in these tests is meant to be reached.
    runTimeoutMs: 2_000,
    settlementTimeoutMs: 2_000,
    reputationTimeoutMs: 2_000,
    pollMs: 50,
    // The secrets live in the agent containers; a blank shell must not warn here.
    secretSource: {
      ANTHROPIC_API_KEY: 'x',
      EXCHANGE_API_KEY: 'x',
      EXCHANGE_PRIVATE_KEY: 'x',
      TELEGRAM_BOT_TOKEN: 'x',
    },
    ...over,
  })
}

describe.skipIf(!HAVE_POSTGRES)(`the demo warm-up against ${TEST_DATABASE_URL}`, () => {
  beforeAll(async () => {
    await lock.acquire()
  })
  afterAll(async () => {
    await lock.release()
  })
  beforeEach(async () => {
    await resetDatabase(db)
    await fixtures()
    lines.length = 0
  })

  it('runs the good chain three times and exits 0 on Story 4.6 exit condition', async () => {
    await setReputation(10_000)
    const result = await warm({
      starter: starterThat(async (runId) => {
        await finishRun(runId)
      }),
    })

    expect(result.verdict).toEqual({ ok: true, failures: [] })
    expect(result.runs).toHaveLength(3)
    expect(result.alphaResearch).toEqual({ bps: 10_000, scoredCallCount: 3 })
  })

  it('starts each Run only after the one before it ended', async () => {
    await setReputation(10_000)
    const startedWhileRunning: number[] = []
    await warm({
      starter: starterThat(async (runId, index) => {
        const stillRunning = await db
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.status, 'running'))
        // The Run just inserted is the only one that may be `running`.
        if (stillRunning.length > 1) startedWhileRunning.push(index)
        await finishRun(runId)
      }),
    })

    expect(startedWhileRunning).toEqual([])
  })

  it('prints every Run id, every Settlement result and every reputation tx hash', async () => {
    await setReputation(10_000)
    const result = await warm({
      starter: starterThat(async (runId) => {
        await finishRun(runId)
      }),
    })
    const summary = formatWarmSummary(result, 'https://testnet.bscscan.com')

    for (const run of result.runs) expect(summary).toContain(run.runId)
    expect(summary).toContain('passed')
    expect(summary).toContain('not_scored (no_fill)')
    expect(summary).toContain(`https://testnet.bscscan.com/tx/${TX(1)}`)
    expect(summary).toContain('Warm-up complete.')
  })

  it('refuses with a legible reason, not a hang, when a Run never ends', async () => {
    // One attempt, not two: `runs_one_running_per_workflow` (AD-4) means the
    // Run this leaves behind blocks the next one, which is the right behaviour
    // and the wrong error to be asserting.
    const started = Date.now()
    const failure = await warm({ starter: starterThat(async () => undefined) }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(SeedRefused)
    expect((failure as SeedRefused).message).toMatch(
      /timed out after 2 s waiting for Run run_.* to end; it is running/,
    )
    // The bound is the injected 2 s, not the 165 s default: it ends, it hangs.
    expect(Date.now() - started).toBeLessThan(20_000)
  })

  it('stops waiting for a Settlement AD-9 will never write, and says which Call', async () => {
    // A skipped Call never reaches `succeeded` or `failed_after_payment`, so it
    // never gets a `settlements` row; waiting on it would be waiting forever.
    await setReputation(10_000)
    const result = await warm({
      starter: starterThat(async (runId) => {
        await finishRun(runId, { riskCallStatus: 'skipped', risk: null })
      }),
    })

    expect(result.verdict.ok).toBe(false)
    expect(result.verdict.failures.join('\n')).toContain('not passed or not_scored (no_fill)')
    expect(formatWarmSummary(result, '')).toContain('unsettled (the Call was skipped: hold)')
  })

  it('reports an unsettled research Call rather than waiting past its timeout twice', async () => {
    await setReputation(10_000)
    const result = await warm({
      runCount: 1,
      starter: starterThat(async (runId) => {
        await finishRun(runId, { research: null })
      }),
    })

    expect(result.verdict.ok).toBe(false)
    expect(result.verdict.failures.join('\n')).toMatch(/the research Call call_.* has no Settlement/)
  })

  it('fails the verdict when the marketplace number is not 100 % over three Calls', async () => {
    await setReputation(6_666)
    const result = await warm({
      starter: starterThat(async (runId, index) => {
        await finishRun(runId, index === 0 ? { research: { result: 'failed', tx: TX(3) } } : {})
      }),
    })

    expect(result.verdict.ok).toBe(false)
    expect(result.verdict.failures).toContain('Alpha Research reads 66.66 %, not 100 %')
    expect(formatWarmSummary(result, '')).toContain('Warm-up did NOT reach its exit condition.')
  })

  it('names the missing secret in the summary when a Run failed at a Node', async () => {
    const result = await warm({
      runCount: 1,
      starter: starterThat(async (runId) => {
        await finishRun(runId, {
          status: 'failed at research',
          research: null,
          risk: null,
          riskCallStatus: 'skipped',
        })
      }),
    })

    expect(formatWarmSummary(result, '')).toContain('ANTHROPIC_API_KEY')
  })

  it('refuses before starting anything when the platform is not in demo mode', async () => {
    await db.update(platformSettings).set({ mode: 'production' }).where(eq(platformSettings.id, 1))

    await expect(warm({ starter: starterThat(async () => undefined) })).rejects.toThrow(
      /--warm needs demo mode/,
    )
    expect(await db.select({ id: runs.id }).from(runs)).toEqual([])
  })

  it('refuses before starting anything when the worker heartbeat is stale', async () => {
    await db
      .update(platformSettings)
      .set({ workerSeenAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(platformSettings.id, 1))

    await expect(warm({ starter: starterThat(async () => undefined) })).rejects.toThrow(
      /--warm needs the worker/,
    )
    expect(await db.select({ id: runs.id }).from(runs)).toEqual([])
  })
})
