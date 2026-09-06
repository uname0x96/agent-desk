import { z } from 'zod'
import deployments97 from '../../../deployments/97.json' with { type: 'json' }

/** AD-10 / AD-14: contract addresses come only from the deployments file. */

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

export const deploymentSchema = z.object({
  chainId: z.number().int(),
  name: z.string(),
  tusd: z.object({
    address: addressSchema,
    name: z.string(),
    version: z.string(),
    decimals: z.number().int(),
  }),
  registry: z.object({ address: addressSchema }),
  identityRegistry: z.object({ address: addressSchema }),
  deployedAtBlock: z.object({ tusd: z.number().int(), registry: z.number().int() }),
})

export type Deployment = z.infer<typeof deploymentSchema>

const byChainId: Record<number, Deployment> = {
  97: deploymentSchema.parse(deployments97),
}

export function getDeployment(chainId: number): Deployment {
  const deployment = byChainId[chainId]
  if (!deployment) throw new Error(`no deployment recorded for chain ${chainId}`)
  return deployment
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export function isDeployed(deployment: Deployment): boolean {
  return (
    deployment.tusd.address.toLowerCase() !== ZERO_ADDRESS &&
    deployment.registry.address.toLowerCase() !== ZERO_ADDRESS
  )
}
