/**
 * AD-13: every address and tx hash the seed prints becomes an explorer link
 * through one helper over `EXPLORER_URL`.
 *
 * This mirrors `apps/web/lib/explorer.ts`. AD-1 forbids `scripts/` importing
 * from `apps/*`, and `packages/schemas` — where AD-14 would put a shared
 * contract like this — does not export one yet, so there are two copies of nine
 * lines until someone moves it there. Keep them identical.
 */

export const DEFAULT_EXPLORER_URL = 'https://testnet.bscscan.com'

export type ExplorerTarget = 'tx' | 'address' | 'token' | 'block'

const PATHS: Record<ExplorerTarget, string> = { tx: 'tx', address: 'address', token: 'token', block: 'block' }

export function explorerLink(
  target: ExplorerTarget,
  value: string,
  baseUrl: string = DEFAULT_EXPLORER_URL,
): string {
  return `${baseUrl.replace(/\/+$/, '')}/${PATHS[target]}/${value}`
}
