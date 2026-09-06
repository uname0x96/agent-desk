import {
  AgentEnvError,
  parseAgentEnv,
  requireEnv,
  type AgentEnv,
  type EnvSource,
  type ParseResult,
} from '@agent-desk/agent-kit'
import { DEFAULT_EXPLORER_URL, normaliseBase } from './explorer.ts'

/**
 * The shared agent variables plus the three this agent owns.
 * `TELEGRAM_BOT_TOKEN` lives here and nowhere else in the repo (spine,
 * Consistency Conventions); the notifier is the only process that talks to the
 * Bot API.
 *
 * Every issue is collected before the process exits, so a fresh laptop learns
 * about all of its missing keys in one run rather than one per restart.
 */

export interface NotifierEnv extends AgentEnv {
  /** From BotFather; see README.md. Only this agent reads it. */
  TELEGRAM_BOT_TOKEN: string
  /** AD-12: long polling on. Set only in compose. */
  AGENT_TELEGRAM_POLL: boolean
  /** AD-13: the base every tx hash in the message links to. */
  EXPLORER_URL: string
}

/**
 * A real token is `<bot_id>:<secret>`. The check is deliberately loose — it
 * catches a bot username or a URL pasted into the slot without risking a
 * refusal of a token Telegram issues in some shape we did not anticipate.
 */
const BOT_TOKEN_RE = /^\d+:.+$/

const TRUE_VALUES = new Set(['true', '1'])
const FALSE_VALUES = new Set(['false', '0', ''])

function readBoolean(source: EnvSource, key: string, issues: string[]): boolean {
  const raw = source[key]?.trim().toLowerCase()
  if (raw === undefined || FALSE_VALUES.has(raw)) return false
  if (TRUE_VALUES.has(raw)) return true
  issues.push(`${key}: must be true or false, got ${source[key]}`)
  return false
}

export function parseNotifierEnv(source: EnvSource = process.env): ParseResult<NotifierEnv> {
  const base = parseAgentEnv(source)
  const issues: string[] = base.ok ? [] : [...base.issues]

  let TELEGRAM_BOT_TOKEN = ''
  try {
    // The kit's helper for the keys an agent adds on top of the shared ones.
    TELEGRAM_BOT_TOKEN = requireEnv(source, 'TELEGRAM_BOT_TOKEN').TELEGRAM_BOT_TOKEN ?? ''
    if (!BOT_TOKEN_RE.test(TELEGRAM_BOT_TOKEN)) {
      issues.push('TELEGRAM_BOT_TOKEN: must look like <bot_id>:<secret> from BotFather')
    }
  } catch (error) {
    if (!(error instanceof AgentEnvError)) throw error
    issues.push(...error.issues)
  }

  const AGENT_TELEGRAM_POLL = readBoolean(source, 'AGENT_TELEGRAM_POLL', issues)

  const explorerRaw = source.EXPLORER_URL?.trim()
  const EXPLORER_URL = normaliseBase(
    explorerRaw === undefined || explorerRaw === '' ? DEFAULT_EXPLORER_URL : explorerRaw,
  )
  if (!URL.canParse(EXPLORER_URL)) {
    issues.push(`EXPLORER_URL: must be an absolute URL, got ${explorerRaw}`)
  }

  if (issues.length > 0 || !base.ok) return { ok: false, issues }
  return {
    ok: true,
    value: { ...base.value, TELEGRAM_BOT_TOKEN, AGENT_TELEGRAM_POLL, EXPLORER_URL },
  }
}

/** Boot-time loader: writes every failed key to stderr and exits 1. */
export function loadNotifierEnv(source: EnvSource = process.env): NotifierEnv {
  const parsed = parseNotifierEnv(source)
  if (parsed.ok) return parsed.value
  process.stderr.write(new AgentEnvError(parsed.issues).message + '\n')
  process.exit(1)
}
