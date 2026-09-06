import { toBaseUnits, toDecimalUsdt, type AgentType } from '@agent-desk/schemas'
import { SEED_BINANCE_TICKER, seedId } from './fixtures.ts'

/**
 * The six Seed Agents of FR-44, at the PRD addendum §2 prices.
 *
 * ┌─ Why the table is here and not imported from the agents ────────────────┐
 * │ `apps/agents/*` each carry a `seed-listing.ts` descriptor, and it would │
 * │ be tempting to import them. AD-1 forbids it in as many words: "Nothing  │
 * │ imports from an `apps/*` directory", and `eslint no-restricted-imports` │
 * │ fails the build if you try. So the prices are transcribed here, and     │
 * │ `agents.test.ts` pins every one of them against the addendum §2 table   │
 * │ verbatim — a price that drifts fails a unit test rather than a demo.    │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Story 2.10 asks the seed to *assert* these six are `active` at these prices.
 * It also creates any that are missing, through the same `skip_verification`
 * path Stories 1.10 and 2.3 to 2.6 use, so a fresh database reaches the same
 * state as one those stories' seeds have already run against; `assertSeedAgents`
 * then reports what is still not `active`, by name, instead of continuing into a
 * demo that has no Provider for a Node.
 *
 * The Stake is exactly ten times the price in every row, which is the Registry's
 * `STAKE_MULTIPLE` floor: `list(...)` reverts below it.
 */

export const SEED_AGENT_KEYS = [
  'binance-ticker',
  'alpha-research',
  'sloppy-research',
  'guardrail-risk',
  'spot-executor',
  'telegram-notifier',
] as const

export type SeedAgentKey = (typeof SEED_AGENT_KEYS)[number]

export interface SeedAgent {
  key: SeedAgentKey
  /** Fixed, so a second seed finds the row by primary key (see `fixtures.ts`). */
  listingId: string
  /** The marketplace name, verbatim from addendum §2. */
  name: string
  description: string
  type: AgentType
  /** Decimal USDT (AD-13), verbatim from addendum §2. */
  priceUsdt: string
  /** Ten times `priceUsdt`, the Registry minimum. */
  stakeUsdt: string
  /** The compose service that serves it. */
  service: string
  /** Its published port. */
  port: number
  /** The env var an Operator overrides the endpoint with. */
  endpointEnv: string
}

/** `0.05` -> `0.5`, through AD-14's conversions, so the rule is arithmetic, not prose. */
function tenTimes(priceUsdt: string): string {
  return toDecimalUsdt(toBaseUnits(priceUsdt) * 10n)
}

function agent(
  key: SeedAgentKey,
  listingId: string,
  name: string,
  type: AgentType,
  priceUsdt: string,
  port: number,
  service: string,
  endpointEnv: string,
  description: string,
): SeedAgent {
  return {
    key,
    listingId,
    name,
    description,
    type,
    priceUsdt,
    stakeUsdt: tenTimes(priceUsdt),
    service,
    port,
    endpointEnv,
  }
}

export const SEED_AGENTS: readonly SeedAgent[] = [
  agent(
    'binance-ticker',
    SEED_BINANCE_TICKER.listingId,
    SEED_BINANCE_TICKER.name,
    SEED_BINANCE_TICKER.type,
    SEED_BINANCE_TICKER.priceUsdt,
    4101,
    'agent-binance-ticker',
    'SEED_BINANCE_TICKER_URL',
    SEED_BINANCE_TICKER.description,
  ),
  agent(
    'alpha-research',
    seedId('listing', 'SEEDAPHA01'),
    'Alpha Research',
    'research',
    '0.05',
    4102,
    'agent-alpha-research',
    'SEED_ALPHA_RESEARCH_URL',
    'Sends the market snapshot to an LLM with a fixed prompt and answers a trend-following ' +
      'signal with a confidence and a one-sentence reason grounded in the snapshot.',
  ),
  agent(
    'sloppy-research',
    seedId('listing', 'SEEDSPPY01'),
    'Sloppy Research',
    'research',
    '0.03',
    4103,
    'agent-sloppy-research',
    'SEED_SLOPPY_RESEARCH_URL',
    'Fades the 24 h move: LONG when the market fell, SHORT when it rose, always at ' +
      'confidence 0.9. Built to fail the demo Settlement rule every time.',
  ),
  agent(
    'guardrail-risk',
    seedId('listing', 'SEEDRSK01'),
    'Guardrail Risk',
    'risk',
    '0.02',
    4104,
    'agent-guardrail-risk',
    'SEED_GUARDRAIL_RISK_URL',
    'Rejects a confident counter-trend signal, rejects above 6 percent volatility, sizes ' +
      'down to 60 percent above 3 percent, and never exceeds the account balance.',
  ),
  agent(
    'spot-executor',
    seedId('listing', 'SEEDEXEC01'),
    'Binance Spot Executor',
    'execution',
    '0.01',
    4105,
    'agent-spot-executor',
    'SEED_SPOT_EXECUTOR_URL',
    'Places a MARKET order on the Platform Exchange Account and answers the fill, or a ' +
      'schema-valid refusal when the platform has stopped trading.',
  ),
  agent(
    'telegram-notifier',
    seedId('listing', 'SEEDNTFY01'),
    'Telegram Notifier',
    'notify',
    '0.005',
    4106,
    'agent-telegram-notifier',
    'SEED_TELEGRAM_NOTIFIER_URL',
    'Posts the Run summary, the cost table, the payment tx hashes and the order to the ' +
      "Builder's Telegram chat.",
  ),
]

export function seedAgent(key: SeedAgentKey): SeedAgent {
  const found = SEED_AGENTS.find((candidate) => candidate.key === key)
  if (!found) throw new Error(`no Seed Agent named ${key}`)
  return found
}

/**
 * The second Sloppy Research instance, `agent-sloppy-research-2` on :4107.
 *
 * It is the same image as :4103 and differs only in `AGENT_PAYTO`, which compose
 * reads from the `.env.seed` file this seed writes with the demo Creator's
 * wallet. The seed does not list it: Story 3.4's demo is a stranger listing it
 * live from `/listings/new`, so all the seed owes that story is the URL to paste
 * and a payout wallet that is not the platform's.
 */
export const SLOPPY_RESEARCH_2 = {
  service: 'agent-sloppy-research-2',
  port: 4107,
  endpointEnv: 'SEED_SLOPPY_RESEARCH_2_URL',
} as const

// ------------------------------------------------------- the price assertion

/** As much of a `listings` row as the assertion reads. */
export interface ListedAgentRow {
  status: string
  /** AD-2 chain-owned `listings.price`, base units; null before the `list:` receipt. */
  price: string | null
  type: AgentType
}

export interface SeedAgentVerdict {
  agent: SeedAgent
  ok: boolean
  /** One line, naming the number rather than "wrong". */
  detail: string
}

/**
 * Story 2.10: "asserts all six Seed Agents are `active` at the PRD addendum §2
 * prices and prints a clear list of any that are missing rather than silently
 * continuing".
 *
 * Pure over rows the caller has already read, so the whole rule is unit-tested
 * without a database. The price compared is the chain-owned `listings.price`,
 * not `declared_price`: AD-2 makes the Registry the system of record, so an
 * Agent whose declared price never reached the chain has not been listed at that
 * price, whatever the form said.
 */
export function assertSeedAgents(
  rows: ReadonlyMap<string, ListedAgentRow>,
  agents: readonly SeedAgent[] = SEED_AGENTS,
): SeedAgentVerdict[] {
  return agents.map((agent) => {
    const row = rows.get(agent.listingId)
    const expected = toBaseUnits(agent.priceUsdt).toString()

    if (!row) {
      return { agent, ok: false, detail: `missing: no listings row ${agent.listingId}` }
    }
    if (row.type !== agent.type) {
      return { agent, ok: false, detail: `is type ${row.type}, addendum §2 says ${agent.type}` }
    }
    if (row.status !== 'active') {
      return { agent, ok: false, detail: `is ${row.status}, not active` }
    }
    if (row.price === null) {
      return { agent, ok: false, detail: 'is active with no price from the chain' }
    }
    if (row.price !== expected) {
      return {
        agent,
        ok: false,
        detail: `is listed at ${toDecimalUsdt(row.price)} tUSD, addendum §2 says ${agent.priceUsdt} tUSD`,
      }
    }
    return { agent, ok: true, detail: `active at ${agent.priceUsdt} tUSD` }
  })
}

export function unhealthySeedAgents(verdicts: readonly SeedAgentVerdict[]): SeedAgentVerdict[] {
  return verdicts.filter((verdict) => !verdict.ok)
}

/** The list Story 2.10 asks to be printed, one Agent per line. */
export function formatSeedAgentVerdicts(verdicts: readonly SeedAgentVerdict[]): string {
  return verdicts
    .map(
      (verdict) =>
        `${verdict.ok ? 'PASS' : 'FAIL'}  ${verdict.agent.name.padEnd(24)} ${verdict.detail}`,
    )
    .join('\n')
}
