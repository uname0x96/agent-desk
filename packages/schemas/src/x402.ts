import { getDeployment } from './deployments.ts'

/**
 * AD-6: one x402 binding for the engine, the agents, and the facilitator.
 * There is no default asset for eip155:97, so every 402 carries an explicit
 * AssetAmount with `extra`; a 402 without it is rejected by both sides.
 */

export const X402_VERSION = 2 as const
export const X402_SCHEME = 'exact' as const
export const X402_HEADERS = {
  required: 'PAYMENT-REQUIRED',
  signature: 'PAYMENT-SIGNATURE',
  response: 'PAYMENT-RESPONSE',
} as const

/** Conventions: 15 s unpaid, 15 s paid, at most two paid attempts. */
export const X402_UNPAID_TIMEOUT_MS = 15_000
export const X402_PAID_TIMEOUT_MS = 15_000
export const X402_MAX_PAID_ATTEMPTS = 2
/** A 402 asking for more than this is refused as a price mismatch. */
export const X402_MAX_TIMEOUT_SECONDS = 15

export interface X402Config {
  network: string
  asset: string
  extra: { name: string; version: string }
  facilitatorUrl: string
  decimals: number
  maxTimeoutSeconds: number
}

export function networkForChain(chainId: number): string {
  return `eip155:${chainId}`
}

export function buildX402Config(options: { facilitatorUrl: string; chainId?: number }): X402Config {
  const chainId = options.chainId ?? 97
  const deployment = getDeployment(chainId)
  return {
    network: networkForChain(chainId),
    asset: deployment.tusd.address.toLowerCase(),
    extra: { name: deployment.tusd.name, version: deployment.tusd.version },
    facilitatorUrl: options.facilitatorUrl,
    decimals: deployment.tusd.decimals,
    maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
  }
}
