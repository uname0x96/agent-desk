/**
 * AD-13: every address and tx hash in the UI becomes an explorer link through
 * this one helper, over `EXPLORER_URL`.
 */

export const DEFAULT_EXPLORER_URL = 'https://testnet.bscscan.com'

export type ExplorerTarget = 'tx' | 'address' | 'token' | 'block'

const PATHS: Record<ExplorerTarget, string> = {
  tx: 'tx',
  address: 'address',
  token: 'token',
  block: 'block',
}

/**
 * Read on the server only. `EXPLORER_URL` is not a `NEXT_PUBLIC_` variable, so
 * client components receive it through `ExplorerProvider` in the root layout
 * rather than reading it here.
 */
export function explorerBaseUrl(): string {
  const configured = process.env.EXPLORER_URL?.trim()
  return normaliseBase(configured && configured.length > 0 ? configured : DEFAULT_EXPLORER_URL)
}

export function explorerLink(
  target: ExplorerTarget,
  value: string,
  baseUrl: string = DEFAULT_EXPLORER_URL,
): string {
  return `${normaliseBase(baseUrl)}/${PATHS[target]}/${value}`
}

function normaliseBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}
