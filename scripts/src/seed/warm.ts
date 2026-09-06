import { and, eq, inArray } from 'drizzle-orm'
import {
  calls,
  listings,
  platformSettings,
  runs,
  settlements,
  type Database,
} from '@agent-desk/db'
import {
  type AgentType,
  type CallStatus,
  type NotScoredReason,
  type SettlementResult,
  type SkipReason,
} from '@agent-desk/schemas'
import { MAX_REPUTATION_BPS } from '@agent-desk/core/settlement'
import { checkWorkerHeartbeat, message } from '../checks.ts'
import { explorerLink } from '../explorer.ts'
import { seedAgent } from './agents.ts'
import { SEED_GOOD_CHAIN } from './fixtures.ts'
import { SeedRefused } from './refusal.ts'
import type { SeedEnv } from './env.ts'
import type { SeedDemoAccount } from './fixtures.ts'

/**
 * `pnpm seed --warm` — Story 4.6, the demo warm-up.
 *
 * NFR-2 asks the good research Agent to be pre-scored before the demo starts, so
 * the closing ranking is a real number over real Calls rather than "no score
 * yet". This runs the good chain three times, one after another, waiting each
 * time for the Run to end *and* for its `research` and `risk` Settlements to be
 * written, and exits 0 only when Alpha Research reads 100 percent over 3 scored
 * Calls and every Guardrail Risk Call came out `passed` or `not_scored`
 * (`no_fill`).
 *
 * Three deliberate choices:
 *
 *   - Runs are started through `POST /api/runs`, never by inserting rows. AD-4
 *     says web inserts a Run whole, with the Price Lock, the budget check and
 *     the balance check in one transaction; a seed that inserted its own Run
 *     would be a second writer of the thing the demo is about to show.
 *   - Everything it waits on is read from Postgres, which AD-3 makes the system
 *     of record for Runs, Calls and Settlements. The numbers it asserts —
 *     `listings.reputation_bps` and the count of scored `settlements` rows — are
 *     the two values `GET /api/listings` builds the marketplace card from, so
 *     "the marketplace shows 100 % over 3 scored Calls" is asserted at its
 *     source rather than by scraping a page.
 *   - Every wait is bounded and every timeout says what it was waiting for and
 *     what it last saw. A warm-up that hangs is worse than one that fails: it is
 *     run in the last quiet minutes before a demo.
 */

// --------------------------------------------------------------- the polling

export type PollResult<T> =
  | { ok: true; value: T; waitedMs: number }
  | { ok: false; value: T | undefined; waitedMs: number; reason: string }

export interface PollOptions<T> {
  /** What the timeout message says it was waiting for. */
  what: string
  read: () => Promise<T>
  done: (value: T) => boolean
  timeoutMs: number
  pollMs: number
  /** Injected so the timeout is unit-testable without a real clock. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** The last state, for the timeout message. Says the number, not "failed". */
  describe?: (value: T) => string
}

/**
 * Polls until `done`, the deadline, or nothing — there is no fourth outcome, and
 * in particular no path that loops forever.
 *
 * A read that throws is not fatal: a database blip or a worker restart mid-poll
 * is exactly what the retry is for. The last error is kept and printed if the
 * deadline arrives, so a timeout never hides the reason underneath it.
 */
export async function pollUntil<T>(options: PollOptions<T>): Promise<PollResult<T>> {
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? defaultSleep
  const started = now()
  const deadline = started + options.timeoutMs

  /** The newest value any poll managed to read, kept for the caller and the message. */
  let seen: { value: T } | undefined
  /** Why the newest poll produced nothing, when it produced nothing. */
  let failure: string | undefined

  for (;;) {
    try {
      const value = await options.read()
      seen = { value }
      failure = undefined
      if (options.done(value)) return { ok: true, value, waitedMs: now() - started }
    } catch (error) {
      failure = message(error)
    }

    if (now() >= deadline) {
      const detail =
        failure !== undefined
          ? `the last read failed: ${failure}`
          : seen === undefined
            ? 'nothing was read'
            : (options.describe?.(seen.value) ?? 'still not done')
      return {
        ok: false,
        value: seen?.value,
        waitedMs: now() - started,
        reason: `timed out after ${Math.round(options.timeoutMs / 1000)} s waiting for ${options.what}; ${detail}`,
      }
    }
    await sleep(options.pollMs)
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------- the exit condition

/** One `research` or `risk` Call of a warm-up Run, with its Settlement if it has one. */
export interface WarmCall {
  callId: string
  listingId: string
  nodeType: AgentType
  status: CallStatus
  /** AD-4: why a still-`pending` Call was skipped at Run end, when it was. */
  skipReason: SkipReason | null
  result: SettlementResult | null
  notScoredReason: NotScoredReason | null
  ruleLabel: string | null
  reputationTxHash: string | null
}

export interface WarmRunRecord {
  runId: string
  status: string
  failureReason: string | null
  /** Only `research` and `risk` Calls; AD-9 settles no other Type. */
  scoredCalls: readonly WarmCall[]
}

/** What the marketplace card reads: the chain's number and the AD-9 scored count. */
export interface WarmReputation {
  bps: number | null
  scoredCallCount: number
}

export interface WarmVerdict {
  ok: boolean
  /** One line per unmet condition, in the order Story 4.6 states them. */
  failures: readonly string[]
}

/** AD-9 writes a `settlements` row only for these two Call statuses. */
export function settlementExpected(status: CallStatus): boolean {
  return status === 'succeeded' || status === 'failed_after_payment'
}

/** Story 4.6: a Guardrail Risk Call passes the warm-up as `passed` or `no_fill`. */
export function riskCallAcceptable(call: WarmCall): boolean {
  if (call.result === 'passed') return true
  return call.result === 'not_scored' && call.notScoredReason === 'no_fill'
}

export const WARM_RUNS = 3

/**
 * Story 4.6's exit condition, whole and pure:
 *
 *   "exits 0 only when Alpha Research shows Reputation 100 percent with 3 scored
 *    Calls on the marketplace and the Guardrail Risk Call results are `passed`
 *    or `not_scored` (`no_fill`)".
 *
 * Everything it needs was read by the caller, so the rule can be tested over
 * fixture rows without a database, a chain or a worker.
 */
export function warmVerdict(input: {
  runs: readonly WarmRunRecord[]
  alphaResearch: WarmReputation
  expectedRuns?: number
}): WarmVerdict {
  const expected = input.expectedRuns ?? WARM_RUNS
  const failures: string[] = []

  if (input.runs.length !== expected) {
    failures.push(`${input.runs.length} of ${expected} Runs were started`)
  }

  for (const run of input.runs) {
    if (run.status === 'running') {
      failures.push(`${run.runId} is still running`)
      continue
    }
    for (const call of run.scoredCalls) {
      if (settlementExpected(call.status) && call.result === null) {
        failures.push(`${run.runId}: the ${call.nodeType} Call ${call.callId} has no Settlement`)
      }
    }
  }

  const { bps, scoredCallCount } = input.alphaResearch
  if (bps !== MAX_REPUTATION_BPS) {
    failures.push(
      `Alpha Research reads ${bps === null ? 'no score yet' : `${bps / 100} %`}, not 100 %`,
    )
  }
  if (scoredCallCount !== expected) {
    failures.push(`Alpha Research has ${scoredCallCount} scored Calls, not ${expected}`)
  }

  const riskCalls = input.runs.flatMap((run) =>
    run.scoredCalls
      .filter((call) => call.nodeType === 'risk')
      .map((call) => ({ runId: run.runId, call })),
  )
  if (riskCalls.length === 0) {
    failures.push('no Guardrail Risk Call was settled')
  }
  for (const { runId, call } of riskCalls) {
    if (!riskCallAcceptable(call)) {
      failures.push(
        `${runId}: the risk Call is ${describeResult(call)}, not passed or not_scored (no_fill)`,
      )
    }
  }

  return { ok: failures.length === 0, failures }
}

export function describeResult(call: WarmCall): string {
  if (call.result === null) {
    return call.status === 'skipped'
      ? `unsettled (the Call was skipped: ${call.skipReason ?? 'no reason'})`
      : `unsettled (the Call is ${call.status})`
  }
  return call.result === 'not_scored'
    ? `not_scored (${call.notScoredReason ?? 'no reason'})`
    : call.result
}

// ------------------------------------------------- legible failure reporting

/**
 * The secret a Node needs, named at the moment it is missed.
 *
 * The warm-up runs on a laptop whose `.env` is filled in by hand over two days,
 * and the failure it produces — "Run failed at research" — is the same whatever
 * went wrong. This turns it into a sentence with a key in it.
 */
const SECRET_BY_NODE: Partial<Record<AgentType, string>> = {
  research: 'ANTHROPIC_API_KEY (Alpha Research calls the LLM; it falls back to HOLD on an API error, but not on a missing key at boot)',
  execution: 'EXCHANGE_API_KEY and EXCHANGE_PRIVATE_KEY (the Binance Spot Testnet Ed25519 key pair), or EXCHANGE_DEMO_API_KEY and EXCHANGE_DEMO_PRIVATE_KEY when EXCHANGE_BASE_URL is Spot Demo Mode',
  notify: 'TELEGRAM_BOT_TOKEN, and SEED_TELEGRAM_CHAT_ID for the Builder',
}

/** One paid Node of the good chain and the keys without which it cannot answer. */
export interface WarmSecretGap {
  node: AgentType
  /** Every key the operator has to fill in, in the spelling `.env.example` uses. */
  keys: readonly string[]
  detail: string
}

/**
 * The keys the good chain needs, checked before three Runs are started rather
 * than after the first one has already been paid for.
 *
 * This is advisory and never refuses. The agents are containers with their own
 * `env_file`, so a laptop shell that seeds without those keys exported is a
 * false alarm, and an operator who is told "you cannot do this" when they can is
 * worse than one told "check this first". The authoritative check stays where it
 * belongs: every agent validates its own env at boot and exits naming its keys.
 *
 * The `execution` pair is reported only when *neither* pair is filled in.
 * `EXCHANGE_BASE_URL` decides which of the two the executor reads (AD-11), and
 * that decision lives in `apps/agents/spot-executor`, which AD-1 keeps out of
 * `scripts/`; naming both and asking for one is true either way.
 */
export function missingWarmSecrets(source: NodeJS.ProcessEnv): WarmSecretGap[] {
  const blank = (key: string): boolean => (source[key]?.trim() ?? '') === ''
  const gaps: WarmSecretGap[] = []

  if (blank('ANTHROPIC_API_KEY')) {
    gaps.push({
      node: 'research',
      keys: ['ANTHROPIC_API_KEY'],
      detail: 'Alpha Research exits at boot without it, so every Run ends `failed at research`',
    })
  }
  const testnetPair = ['EXCHANGE_API_KEY', 'EXCHANGE_PRIVATE_KEY']
  const demoPair = ['EXCHANGE_DEMO_API_KEY', 'EXCHANGE_DEMO_PRIVATE_KEY']
  if (testnetPair.every(blank) && demoPair.every(blank)) {
    gaps.push({
      node: 'execution',
      keys: [...testnetPair, ...demoPair],
      detail: 'one pair is required; EXCHANGE_BASE_URL decides which',
    })
  }
  if (blank('TELEGRAM_BOT_TOKEN')) {
    gaps.push({
      node: 'notify',
      keys: ['TELEGRAM_BOT_TOKEN'],
      detail: 'the Telegram Notifier exits at boot without it',
    })
  }
  return gaps
}

/**
 * Story 4.6's exit condition does not depend on the `notify` Node: `research`
 * and `risk` are paid, answered and settled before the chain reaches it (FR-17),
 * so a Run that ends `failed at notify` still scores Alpha Research. That is why
 * every line here is a warning and none of them stops the warm-up.
 */
export function formatWarmSecretGaps(gaps: readonly WarmSecretGap[]): string[] {
  return gaps.map(
    (gap) => `warm-up            NOTE the ${gap.node} Node needs ${gap.keys.join(' / ')}: ${gap.detail}`,
  )
}

/** One actionable line about how a Run ended, with the key to fill in when it failed. */
export function describeRunEnd(run: {
  runId: string
  status: string
  failureReason: string | null
}): string {
  const node = /^failed at (.+)$/.exec(run.status)?.[1]
  const reason = run.failureReason ?? 'no reason recorded'
  // AD-4: `completed` and `completed, no order` carry no `failure_reason`, and
  // "no reason recorded" reads like a defect on a Run that did not fail.
  if (!node) return run.failureReason === null ? `${run.runId} ended ${run.status}` : `${run.runId} ended ${run.status}: ${reason}`

  const secret = SECRET_BY_NODE[node as AgentType]
  return (
    `${run.runId} ended ${run.status}: ${reason}` +
    (secret ? `\n  the ${node} Node needs ${secret}` : '')
  )
}

// ------------------------------------------------------------------ the HTTP

/** `POST /api/auth/sign-in` then `POST /api/runs`, as a Builder in a browser would. */
export interface RunStarter {
  start(workflowId: string): Promise<string>
}

interface WebClientOptions {
  baseUrl: string
  builder: SeedDemoAccount
  timeoutMs?: number
  log: (line: string) => void
}

export function createWebRunStarter(options: WebClientOptions): RunStarter {
  const timeout = options.timeoutMs ?? 15_000
  let cookie: string | null = null
  let signedIn = false

  const signIn = async (): Promise<void> => {
    if (signedIn) return
    signedIn = true
    const response = await request(
      `${options.baseUrl}/api/auth/sign-in`,
      { email: options.builder.email, password: options.builder.password },
      null,
      timeout,
    )
    if (response.status === 404) {
      // Story 2.1 is what adds the session; before it lands the route is absent
      // and `POST /api/runs` takes no cookie. Say so rather than fail.
      options.log('warm-up            /api/auth/sign-in is not there yet; starting Runs unauthenticated')
      return
    }
    if (response.status !== 200) {
      throw new SeedRefused(
        `sign-in as ${options.builder.email} answered ${response.status}: ${response.body}. ` +
          'Run `pnpm seed` first so the demo Accounts exist.',
      )
    }
    cookie = response.setCookie
  }

  return {
    async start(workflowId: string): Promise<string> {
      await signIn()
      const response = await request(
        `${options.baseUrl}/api/runs`,
        { workflow_id: workflowId },
        cookie,
        timeout,
      )
      if (response.status !== 201 && response.status !== 200) {
        throw new SeedRefused(
          `POST ${options.baseUrl}/api/runs answered ${response.status}: ${response.body}`,
        )
      }
      const id = (response.json as { id?: unknown } | null)?.id
      if (typeof id !== 'string') {
        throw new SeedRefused(`POST /api/runs answered 201 with no Run id: ${response.body}`)
      }
      return id
    },
  }
}

interface WebResponse {
  status: number
  body: string
  json: unknown
  setCookie: string | null
}

async function request(
  url: string,
  body: unknown,
  cookie: string | null,
  timeoutMs: number,
): Promise<WebResponse> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new SeedRefused(
      `${url} could not be reached: ${message(error)}. Is \`docker compose up -d\` running?`,
    )
  }
  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  // `getSetCookie` keeps the cookies separate; one header is what fetch sends back.
  const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0])
  return {
    status: response.status,
    body: text.slice(0, 400),
    json,
    setCookie: cookies.length > 0 ? cookies.join('; ') : null,
  }
}

// --------------------------------------------------------------- the reads

async function readRun(db: Database, runId: string) {
  const [row] = await db
    .select({ status: runs.status, failureReason: runs.failureReason, endedAt: runs.endedAt })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1)
  return row ?? null
}

const SCORED_TYPES: readonly AgentType[] = ['research', 'risk']

async function readScoredCalls(db: Database, runId: string): Promise<WarmCall[]> {
  const rows = await db
    .select({
      callId: calls.id,
      listingId: calls.listingId,
      nodeType: calls.nodeType,
      status: calls.status,
      skipReason: calls.skipReason,
      result: settlements.result,
      notScoredReason: settlements.notScoredReason,
      ruleLabel: settlements.ruleLabel,
      reputationTxHash: settlements.reputationTxHash,
    })
    .from(calls)
    .leftJoin(settlements, eq(settlements.callId, calls.id))
    .where(and(eq(calls.runId, runId), inArray(calls.nodeType, SCORED_TYPES)))
  return rows.map((row) => ({
    callId: row.callId,
    listingId: row.listingId,
    nodeType: row.nodeType,
    status: row.status,
    skipReason: row.skipReason,
    result: row.result,
    notScoredReason: row.notScoredReason,
    ruleLabel: row.ruleLabel,
    reputationTxHash: row.reputationTxHash,
  }))
}

/**
 * The two numbers the marketplace card is built from (`apps/web/app/api/listings`):
 * the chain-owned `reputation_bps` and the count of `passed` or `failed` rows.
 */
async function readReputation(db: Database, listingId: string): Promise<WarmReputation> {
  const [listing] = await db
    .select({ reputationBps: listings.reputationBps })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1)
  const scored = await db
    .select({ id: settlements.id })
    .from(settlements)
    .where(
      and(eq(settlements.listingId, listingId), inArray(settlements.result, ['passed', 'failed'])),
    )
  return { bps: listing?.reputationBps ?? null, scoredCallCount: scored.length }
}

// ------------------------------------------------------------ the warm-up

export interface WarmDeps {
  db: Database
  env: SeedEnv
  explorerUrl: string
  builder: SeedDemoAccount
  log: (line: string) => void
  /** Injected by the tests; the CLI uses the real web app. */
  starter?: RunStarter
  /** AD-4: 120 s Run timeout plus the settlement loop's 45 s grace. */
  runTimeoutMs?: number
  /** Addendum §6 demo: a 20 s Settlement Window, a 2 s poll, then chain receipts. */
  settlementTimeoutMs?: number
  /** How long the reputation transaction has to confirm and refresh the cache. */
  reputationTimeoutMs?: number
  pollMs?: number
  runCount?: number
  /** Injected by the tests; the CLI checks the shell the operator seeded from. */
  secretSource?: NodeJS.ProcessEnv
}

export interface WarmResult {
  runs: readonly WarmRunRecord[]
  alphaResearch: WarmReputation
  verdict: WarmVerdict
}

const DEFAULT_RUN_TIMEOUT_MS = 165_000
const DEFAULT_SETTLEMENT_TIMEOUT_MS = 90_000
const DEFAULT_REPUTATION_TIMEOUT_MS = 90_000
const DEFAULT_POLL_MS = 1_000

export async function runWarmUp(deps: WarmDeps): Promise<WarmResult> {
  const { db, log } = deps
  const runCount = deps.runCount ?? WARM_RUNS
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS
  const alpha = seedAgent('alpha-research')

  await assertReadyForWarmUp(db)
  for (const line of formatWarmSecretGaps(missingWarmSecrets(deps.secretSource ?? process.env))) {
    log(line)
  }

  const starter =
    deps.starter ??
    createWebRunStarter({ baseUrl: deps.env.webBaseUrl, builder: deps.builder, log })

  const records: WarmRunRecord[] = []
  for (let index = 0; index < runCount; index += 1) {
    log('')
    log(`warm-up ${index + 1}/${runCount}      starting a Run of ${SEED_GOOD_CHAIN.name}`)
    const runId = await starter.start(SEED_GOOD_CHAIN.workflowId)
    log(`warm-up ${index + 1}/${runCount}      run ${runId}`)

    // 1. the Run ends. AD-4 bounds it at 120 s from `started_at`, and the
    //    settlement loop sweeps a stuck Run 45 s after that, so a Run that has
    //    not ended by then is not going to.
    const ended = await pollUntil({
      what: `Run ${runId} to end`,
      read: () => readRun(db, runId),
      done: (row) => row !== null && row.status !== 'running',
      timeoutMs: deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      pollMs,
      describe: (row) => `it is ${row?.status ?? 'missing'}`,
    })
    if (!ended.ok) throw new SeedRefused(`warm-up: ${ended.reason}`)
    // `done` above already proved the row is there; this is the type-level half.
    const run = ended.value
    if (!run) throw new SeedRefused(`warm-up: the Run ${runId} disappeared from the database`)

    // 2. its research and risk Settlements are written. A Call that never
    //    reached `succeeded` or `failed_after_payment` will never get a row
    //    (AD-9), so waiting on it would be waiting forever; `settlementExpected`
    //    is what stops that, and the verdict below reports it as a failure.
    const settled = await pollUntil({
      what: `the research and risk Settlements of ${runId}`,
      read: () => readScoredCalls(db, runId),
      done: (rows) =>
        rows.length > 0 &&
        rows.every((row) => !settlementExpected(row.status) || row.result !== null),
      timeoutMs: deps.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS,
      pollMs,
      describe: (rows) =>
        rows.length === 0
          ? 'the Run has no research or risk Call'
          : rows
              .map((row) => `${row.nodeType} ${row.status} -> ${row.result ?? 'unsettled'}`)
              .join(', '),
    })

    const scoredCalls = settled.value ?? []
    records.push({
      runId,
      status: run.status,
      failureReason: run.failureReason,
      scoredCalls,
    })

    log(`warm-up ${index + 1}/${runCount}      ${describeRunEnd({ runId, status: run.status, failureReason: run.failureReason })}`)
    for (const call of scoredCalls) {
      log(
        `warm-up ${index + 1}/${runCount}      ${call.nodeType.padEnd(8)} ` +
          `${describeResult(call)}${call.ruleLabel ? `  [${call.ruleLabel}]` : ''}  ` +
          `reputation tx ${
            call.reputationTxHash ? explorerLink('tx', call.reputationTxHash, deps.explorerUrl) : '(none)'
          }`,
      )
    }
    if (!settled.ok) log(`warm-up ${index + 1}/${runCount}      ${settled.reason}`)
  }

  // 3. the number the marketplace shows. The reputation transaction is a second
  //    transaction after the Settlement row (AD-9), and `reputation_bps` only
  //    changes once `refreshListingFromChain` has seen its receipt, so this is
  //    its own wait rather than part of the settlement one.
  log('')
  const reputation = await pollUntil({
    what: `${alpha.name} to read 100 % over ${runCount} scored Calls`,
    read: () => readReputation(db, alpha.listingId),
    done: (value) => value.bps === MAX_REPUTATION_BPS && value.scoredCallCount === runCount,
    timeoutMs: deps.reputationTimeoutMs ?? DEFAULT_REPUTATION_TIMEOUT_MS,
    pollMs,
    describe: (value) =>
      `it reads ${value.bps === null ? 'no score yet' : `${value.bps / 100} %`} over ` +
      `${value.scoredCallCount} scored Calls`,
  })
  const alphaResearch = reputation.value ?? { bps: null, scoredCallCount: 0 }
  if (!reputation.ok) log(`warm-up            ${reputation.reason}`)

  const verdict = warmVerdict({ runs: records, alphaResearch, expectedRuns: runCount })
  return { runs: records, alphaResearch, verdict }
}

/**
 * Two things make the warm-up pointless before it starts: a worker that is not
 * running, so nothing ever advances, and `production` mode, whose 60 minute
 * Settlement Window no wait here is long enough for (addendum §6).
 */
async function assertReadyForWarmUp(db: Database): Promise<void> {
  const [settings] = await db
    .select({ mode: platformSettings.mode, workerSeenAt: platformSettings.workerSeenAt })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)
  if (!settings) throw new SeedRefused('platform_settings row 1 is missing; run the migrations')

  if (settings.mode !== 'demo') {
    throw new SeedRefused(
      `--warm needs demo mode; platform_settings.mode is ${settings.mode}. In production the ` +
        'Settlement Window is 60 minutes (addendum §6). Run `pnpm seed`, which sets it.',
    )
  }
  const heartbeat = checkWorkerHeartbeat(settings.workerSeenAt ?? null, new Date())
  if (!heartbeat.ok) {
    throw new SeedRefused(
      `--warm needs the worker: ${heartbeat.detail}. Nothing executes a Run or writes a ` +
        'Settlement without it; `pnpm doctor` says more.',
    )
  }
}

/** The block `pnpm seed --warm` ends on. */
export function formatWarmSummary(result: WarmResult, explorerUrl: string): string {
  const alpha = seedAgent('alpha-research')
  const lines = ['', result.verdict.ok ? 'Warm-up complete.' : 'Warm-up did NOT reach its exit condition.', '']

  for (const run of result.runs) {
    // `describeRunEnd`, not the bare status: a Run that failed at a Node is the
    // one line an operator acts on, and it carries the key to fill in.
    lines.push(`  Run ${describeRunEnd(run)}`)
    for (const call of run.scoredCalls) {
      lines.push(
        `    ${call.nodeType.padEnd(8)} ${describeResult(call).padEnd(28)} ` +
          `reputation tx ${
            call.reputationTxHash ? explorerLink('tx', call.reputationTxHash, explorerUrl) : '(none)'
          }`,
      )
    }
  }

  lines.push('')
  lines.push(
    `  ${alpha.name.padEnd(20)} ${
      result.alphaResearch.bps === null ? 'no score yet' : `${result.alphaResearch.bps / 100} %`
    } over ${result.alphaResearch.scoredCallCount} scored Calls`,
  )
  if (!result.verdict.ok) {
    lines.push('')
    for (const failure of result.verdict.failures) lines.push(`  NOT MET  ${failure}`)
  }
  lines.push('')
  return lines.join('\n')
}
