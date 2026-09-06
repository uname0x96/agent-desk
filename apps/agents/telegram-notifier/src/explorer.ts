/**
 * AD-13: every tx hash the notifier renders becomes an explorer link through
 * this one helper, over `EXPLORER_URL`.
 *
 * This mirrors `apps/web/lib/explorer.ts` deliberately. AD-1 forbids an agent
 * importing from an `apps/*` directory, so the web helper cannot be reused
 * here; the two must be kept in step by hand. The behaviour copied is exact:
 * the same default base, the same `<base>/<path>/<value>` shape, and the same
 * trailing-slash normalisation. The explorer base is this agent's own env.
 */

export const DEFAULT_EXPLORER_URL = 'https://testnet.bscscan.com'

export type ExplorerTarget = 'tx' | 'address' | 'token' | 'block'

const PATHS: Record<ExplorerTarget, string> = {
  tx: 'tx',
  address: 'address',
  token: 'token',
  block: 'block',
}

export function explorerLink(
  target: ExplorerTarget,
  value: string,
  baseUrl: string = DEFAULT_EXPLORER_URL,
): string {
  return `${normaliseBase(baseUrl)}/${PATHS[target]}/${value}`
}

export function normaliseBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}
