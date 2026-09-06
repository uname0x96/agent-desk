import { createPublicClient, fallback, http, type Chain, type PublicClient } from 'viem'
import { bscTestnet } from 'viem/chains'
import { ZERO_ADDRESS, getDeployment } from '@agent-desk/schemas'
import type { Address } from '@agent-desk/core/ports'

/**
 * Conventions: chain reads and sends go through viem `fallback()` over
 * `RPC_URLS` with three retries, and receipts are awaited up to 60 s, after
 * which the `chain_tx` row stays `pending` and the next iteration re-checks.
 */

export const RPC_RETRY_COUNT = 3
export const RECEIPT_TIMEOUT_MS = 60_000

const CHAINS: Record<number, Chain> = { [bscTestnet.id]: bscTestnet }

export function chainFor(chainId: number): Chain {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`no viem chain registered for chain id ${chainId}`)
  return chain
}

export interface ChainClientConfig {
  chainId: number
  rpcUrls: readonly string[]
}

export function createPublicChainClient(config: ChainClientConfig): PublicClient {
  if (config.rpcUrls.length === 0) throw new Error('RPC_URLS is empty')
  return createPublicClient({
    chain: chainFor(config.chainId),
    transport: fallback(config.rpcUrls.map((url) => http(url, { retryCount: RPC_RETRY_COUNT }))),
  })
}

/** AD-10: contract addresses come only from `deployments/<chain id>.json`. */
export interface ContractAddresses {
  tusd: Address
  registry: Address
  identityRegistry: Address
}

export function addressesFor(chainId: number): ContractAddresses {
  const deployment = getDeployment(chainId)
  return {
    tusd: deployment.tusd.address.toLowerCase(),
    registry: deployment.registry.address.toLowerCase(),
    identityRegistry: deployment.identityRegistry.address.toLowerCase(),
  }
}

/**
 * Fails loudly at boot rather than at the first transaction. tUSD and the
 * Registry still carry the zero address in `deployments/97.json` because nobody
 * has funded the Platform Wallet yet, so any host that needs to write must call
 * this and refuse to start.
 */
export function assertDeployed(addresses: ContractAddresses): ContractAddresses {
  const missing = (Object.entries(addresses) as [keyof ContractAddresses, Address][])
    .filter(([, address]) => address === ZERO_ADDRESS)
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(
      `deployments file still carries the zero address for: ${missing.join(', ')}. ` +
        'Deploy the contracts and update deployments/<chain id>.json before writing to chain.',
    )
  }
  return addresses
}
