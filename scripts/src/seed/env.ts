import { SEED_AGENTS, SLOPPY_RESEARCH_2, type SeedAgentKey } from './agents.ts'

/**
 * The environment Story 2.10 and Story 4.6 add on top of `scripts/src/env.ts`.
 *
 * It is a module of its own for the same reason `scripts/src/env.ts` exists at
 * all — every process validates its env and says which key failed — and because
 * `scripts/src/env.ts` belongs to Story 1.10. Nothing here is a secret: seven
 * agent URLs, the web origin `--warm` starts Runs against, and the Telegram chat
 * id the demo Builder pastes into settings.
 *
 * Every URL defaults to `http://localhost:<port>`, matching the
 * `SEED_BINANCE_TICKER_URL` default Story 1.10 already chose: the seed runs on
 * the demo laptop against the published compose ports. An operator whose worker
 * runs inside the compose network overrides them with the service names, because
 * `listings.endpoint` is what the *engine* dials, not what the seed dials.
 */

export interface SeedEnv {
  /** One endpoint per Seed Agent, in `SEED_AGENTS` order. */
  endpoints: Readonly<Record<SeedAgentKey, string>>
  /** The :4107 instance. Printed for the Story 3.4 live-listing demo, never listed. */
  sloppyResearch2Url: string
  /** Digits, as Telegram gives them. Null when `SEED_TELEGRAM_CHAT_ID` is absent. */
  telegramChatId: string | null
  /** Where `--warm` posts `POST /api/runs` and signs in (AD-4: web inserts Runs). */
  webBaseUrl: string
}

/** Telegram chat ids are integers and may be negative for a group. */
const CHAT_ID = /^-?\d+$/

export function parseSeedEnv(source: NodeJS.ProcessEnv = process.env): SeedEnv {
  const problems: string[] = []

  const url = (key: string, fallback: string): string => {
    const value = source[key]?.trim()
    if (!value) return fallback
    // `URL.canParse` accepts any scheme, so `agent-alpha-research:4102` — a
    // service name with a port and no scheme — parses as a URL whose protocol is
    // `agent-alpha-research:`. The engine dials `listings.endpoint` with `fetch`,
    // so only http and https are usable.
    const parsed = URL.parse(value)
    if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      problems.push(`  ${key}: must be an absolute http(s) URL, e.g. http://localhost:4102`)
      return fallback
    }
    return value.replace(/\/+$/, '')
  }

  const endpoints = {} as Record<SeedAgentKey, string>
  for (const agent of SEED_AGENTS) {
    endpoints[agent.key] = url(agent.endpointEnv, `http://localhost:${agent.port}`)
  }

  const rawChatId = source.SEED_TELEGRAM_CHAT_ID?.trim() ?? ''
  if (rawChatId !== '' && !CHAT_ID.test(rawChatId)) {
    problems.push('  SEED_TELEGRAM_CHAT_ID: must be the integer chat id the bot replied with')
  }

  const env: SeedEnv = {
    endpoints,
    sloppyResearch2Url: url(
      SLOPPY_RESEARCH_2.endpointEnv,
      `http://localhost:${SLOPPY_RESEARCH_2.port}`,
    ),
    telegramChatId: CHAT_ID.test(rawChatId) ? rawChatId : null,
    webBaseUrl: url('SEED_WEB_BASE_URL', 'http://localhost:3000'),
  }

  if (problems.length > 0) throw new SeedEnvError(problems)
  return env
}

/** The boot-time form: print every failing key and stop, as `loadScriptsEnv` does. */
export function loadSeedEnv(source: NodeJS.ProcessEnv = process.env): SeedEnv {
  try {
    return parseSeedEnv(source)
  } catch (error) {
    if (!(error instanceof SeedEnvError)) throw error
    process.stderr.write(`Invalid environment:\n${error.problems.join('\n')}\n`)
    process.exit(1)
  }
}

export class SeedEnvError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`Invalid environment:\n${problems.join('\n')}`)
    this.name = 'SeedEnvError'
    this.problems = problems
  }
}
