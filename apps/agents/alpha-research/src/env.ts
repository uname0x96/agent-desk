import type { EnvSource, ParseResult } from '@agent-desk/agent-kit'
import { AgentEnvError } from '@agent-desk/agent-kit'
import { DEFAULT_MODEL } from './model.ts'

/**
 * The keys Alpha Research adds on top of the shared agent env. AD-1 keeps
 * `ANTHROPIC_API_KEY` here: it appears in this agent's env schema, in
 * `.env.example` under "alpha-research only", and nowhere else.
 *
 * Conventions: validate at boot and exit naming the failed keys, so a missing
 * key is a refused start rather than a HOLD on every request.
 */

export interface AlphaEnv {
  ANTHROPIC_API_KEY: string
  /** Defaults to `claude-sonnet-5`. */
  ANTHROPIC_MODEL: string
}

export function parseAlphaEnv(source: EnvSource = process.env): ParseResult<AlphaEnv> {
  const apiKey = source.ANTHROPIC_API_KEY?.trim() ?? ''
  if (apiKey === '') return { ok: false, issues: ['ANTHROPIC_API_KEY: required'] }
  const model = source.ANTHROPIC_MODEL?.trim() ?? ''
  return {
    ok: true,
    value: { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_MODEL: model === '' ? DEFAULT_MODEL : model },
  }
}

export function loadAlphaEnv(source: EnvSource = process.env): AlphaEnv {
  const parsed = parseAlphaEnv(source)
  if (parsed.ok) return parsed.value
  process.stderr.write(new AgentEnvError(parsed.issues).message + '\n')
  process.exit(1)
}
