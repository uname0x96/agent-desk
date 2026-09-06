import { buildX402Config, getDeployment, ZERO_ADDRESS, type X402Config } from '@agent-desk/schemas'
import type { FacilitatorEnv } from './env.ts'

/**
 * AD-6: the one x402 binding. The asset, the EIP-712 domain and the network all
 * come from `buildX402Config`, which reads `deployments/97.json` at runtime, so
 * nothing here is baked in at build time and a redeploy of tUSD only needs a
 * restart.
 */
export interface FacilitatorConfig {
  chainId: number
  x402: X402Config
  /** False while `deployments/97.json` still carries the zero address for tUSD. */
  assetDeployed: boolean
}

export function buildFacilitatorConfig(env: FacilitatorEnv): FacilitatorConfig {
  const x402 = buildX402Config({ facilitatorUrl: env.facilitatorUrl, chainId: env.chainId })
  // Only tUSD matters here; the registry addresses in the same file are the
  // worker's business, so `isDeployed` would be too strict a gate for this app.
  return { chainId: env.chainId, x402, assetDeployed: isTusdDeployed(env.chainId) }
}

export function isTusdDeployed(chainId: number): boolean {
  return getDeployment(chainId).tusd.address.toLowerCase() !== ZERO_ADDRESS
}

/** The `extra` published for the single supported kind on `GET /supported`. */
export function supportedExtra(config: FacilitatorConfig): Record<string, unknown> {
  return {
    asset: config.x402.asset,
    decimals: config.x402.decimals,
    name: config.x402.extra.name,
    version: config.x402.extra.version,
  }
}
