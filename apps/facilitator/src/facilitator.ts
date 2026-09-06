import { x402Facilitator } from '@x402/core/facilitator'
import type { Network } from '@x402/core/types'
import type { FacilitatorConfig } from './config.ts'
import { AgentDeskExactScheme } from './scheme.ts'
import type { Relayer } from './relayer.ts'

/**
 * AD-6: the `exact` scheme on eip155:97 and nothing else. `registerExactEvmScheme`
 * is deliberately not used because it also registers the v1 scheme across every
 * EVM network the SDK knows, which would make `GET /supported` advertise networks
 * this deployment cannot settle on. There is no Solana signer path.
 */
export function createFacilitator(config: FacilitatorConfig, relayer: Relayer): x402Facilitator {
  const scheme = new AgentDeskExactScheme(config, relayer.signer)
  return new x402Facilitator().register(config.x402.network as Network, scheme)
}
