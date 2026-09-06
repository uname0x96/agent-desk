import { csv } from '@agent-desk/schemas/env'

/**
 * Conventions: every process validates its env at boot and exits on failure,
 * naming the keys that failed.
 *
 * This module should call `defineEnv` from `@agent-desk/schemas/env`, but `zod`
 * is not a declared dependency of `apps/facilitator`, so it cannot be imported
 * here. `parseFacilitatorEnv` keeps the same contract (collect every failing
 * key, never throw) and `loadFacilitatorEnv` keeps the same behaviour (print
 * the failures to stderr, exit 1). Swap both for `defineEnv` once `zod` is
 * declared in this app's package.json.
 */

/** AD-6 binds this app to one chain; a different id has no viem chain here. */
export const SUPPORTED_CHAIN_ID = 97
export const DEFAULT_FACILITATOR_PORT = 4020

export interface FacilitatorEnv {
  chainId: number
  rpcUrls: string[]
  /** Relays every x402 settlement. Lives only in this app; never logged. */
  relayerKey: `0x${string}`
  port: number
  facilitatorUrl: string
}

export type EnvResult = { ok: true; env: FacilitatorEnv } | { ok: false; issues: string[] }

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/

function readPort(raw: string | undefined, issues: string[]): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_FACILITATOR_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issues.push('FACILITATOR_PORT: expected an integer between 1 and 65535')
    return DEFAULT_FACILITATOR_PORT
  }
  return port
}

function readChainId(raw: string | undefined, issues: string[]): number {
  if (raw === undefined || raw.trim() === '') return SUPPORTED_CHAIN_ID
  const chainId = Number(raw)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    issues.push('CHAIN_ID: expected a positive integer')
    return SUPPORTED_CHAIN_ID
  }
  if (chainId !== SUPPORTED_CHAIN_ID) {
    issues.push(`CHAIN_ID: this facilitator only serves chain ${SUPPORTED_CHAIN_ID}, got ${chainId}`)
  }
  return chainId
}

function readRpcUrls(raw: string | undefined, issues: string[]): string[] {
  const urls = csv(raw ?? '')
  if (urls.length === 0) {
    issues.push('RPC_URLS: expected a comma-separated list with at least one URL')
    return urls
  }
  for (const url of urls) {
    if (!/^https?:\/\//.test(url)) {
      issues.push(`RPC_URLS: "${url}" is not an http(s) URL`)
    }
  }
  return urls
}

function readRelayerKey(raw: string | undefined, issues: string[]): `0x${string}` {
  if (!raw || !PRIVATE_KEY.test(raw.trim())) {
    issues.push('FACILITATOR_RELAYER_KEY: expected a 0x-prefixed 32-byte hex private key')
    return '0x'
  }
  return raw.trim() as `0x${string}`
}

export function parseFacilitatorEnv(source: NodeJS.ProcessEnv = process.env): EnvResult {
  const issues: string[] = []
  const chainId = readChainId(source.CHAIN_ID, issues)
  const rpcUrls = readRpcUrls(source.RPC_URLS, issues)
  const relayerKey = readRelayerKey(source.FACILITATOR_RELAYER_KEY, issues)
  const port = readPort(source.FACILITATOR_PORT, issues)
  const facilitatorUrl = source.FACILITATOR_URL?.trim() || `http://localhost:${port}`
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, env: { chainId, rpcUrls, relayerKey, port, facilitatorUrl } }
}

export function loadFacilitatorEnv(source: NodeJS.ProcessEnv = process.env): FacilitatorEnv {
  const result = parseFacilitatorEnv(source)
  if (result.ok) return result.env
  process.stderr.write(`Invalid environment:\n${result.issues.map((issue) => `  ${issue}`).join('\n')}\n`)
  process.exit(1)
}
