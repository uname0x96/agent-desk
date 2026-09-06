import registryAbiJson from './abi/AgentDeskRegistry.json' with { type: 'json' }
import tusdAbiJson from './abi/TUSD.json' with { type: 'json' }
import identityRegistryAbiJson from './abi/IdentityRegistry.json' with { type: 'json' }
import type { Abi } from 'viem'

/**
 * AD-8: `pnpm --filter contracts build` exports these three ABIs from the
 * compiled contracts; adapters import only them and nothing else re-declares a
 * function signature. The JSON is generated output — read it, never edit it.
 */
export const registryAbi = registryAbiJson as Abi
export const tusdAbi = tusdAbiJson as Abi
export const identityRegistryAbi = identityRegistryAbiJson as Abi
