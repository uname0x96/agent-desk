import { internalSettings, type InternalSettings } from '@agent-desk/schemas'

/**
 * AD-10: platform-operated agents read `emergency_stop` and
 * `order_ceiling_usdt` from `GET /api/internal/settings` on every request, so
 * the Operator can stop trading without a restart. AD-11 makes this agent the
 * only enforcer of both.
 *
 * Story 2.2 delivers the route; until then this is coded against the
 * `internalSettings` schema and stubbed in the tests.
 */

/** Story 2.5: the settings read is bounded at 3 s. */
export const SETTINGS_TIMEOUT_MS = 3_000

export const SETTINGS_PATH = '/api/internal/settings'

/** Any failure to read settings — unreachable, 4xx, 5xx, or a body off-schema. */
export class SettingsUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsUnavailableError'
  }
}

export interface SettingsClientOptions {
  /** `PLATFORM_INTERNAL_URL`, e.g. `http://web:3000`. */
  baseUrl: string
  /** `INTERNAL_TOKEN`, the shared bearer of every internal route. */
  token: string
  timeoutMs?: number
  fetchImpl?: typeof globalThis.fetch
}

/** What the handler depends on. The tests pass a function; production passes the client. */
export type SettingsSource = (signal?: AbortSignal) => Promise<InternalSettings>

export function createSettingsClient(options: SettingsClientOptions): SettingsSource {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? SETTINGS_TIMEOUT_MS
  const doFetch = options.fetchImpl ?? globalThis.fetch

  return async (signal?: AbortSignal): Promise<InternalSettings> => {
    const deadline = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline

    let response: Response
    try {
      response = await doFetch(`${baseUrl}${SETTINGS_PATH}`, {
        headers: { accept: 'application/json', authorization: `Bearer ${options.token}` },
        signal: combined,
      })
    } catch (error) {
      if (deadline.aborted) {
        throw new SettingsUnavailableError(`platform settings timed out after ${timeoutMs} ms`)
      }
      // The handler budget expired rather than the settings deadline; let the
      // kit's own timeout error surface instead of dressing it as a refusal.
      if (signal?.aborted) throw error
      const reason = error instanceof Error ? error.message : String(error)
      throw new SettingsUnavailableError(`platform settings are unreachable: ${reason}`)
    }

    if (!response.ok) {
      throw new SettingsUnavailableError(`platform settings answered ${response.status}`)
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new SettingsUnavailableError('platform settings answered a non-JSON body')
    }

    const parsed = internalSettings.safeParse(body)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new SettingsUnavailableError(
        `platform settings are off-schema: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
      )
    }
    return parsed.data
  }
}
