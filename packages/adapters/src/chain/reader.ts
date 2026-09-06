import type { PublicClient } from 'viem'
import type { Address, ChainReader, Hex, RegistryListing } from '@agent-desk/core/ports'
import { registryAbi, tusdAbi } from './abi.ts'
import type { ContractAddresses } from './clients.ts'

/**
 * The read half of the chain. Kept apart from the writer so the signing policy
 * can be handed balances without being handed the ability to send anything, and
 * so `refreshListingFromChain` reads `getListing` through the same client the
 * receipts came from.
 */
export interface ChainReaderDeps {
  publicClient: PublicClient
  addresses: ContractAddresses
}

export function createChainReader(deps: ChainReaderDeps): ChainReader {
  const { publicClient, addresses } = deps

  return {
    nativeBalance(address: Address): Promise<bigint> {
      return publicClient.getBalance({ address: address as Hex })
    },

    async tokenBalance(address: Address): Promise<bigint> {
      return (await publicClient.readContract({
        address: addresses.tusd as Hex,
        abi: tusdAbi,
        functionName: 'balanceOf',
        args: [address],
      })) as bigint
    },

    async registryAllowance(owner: Address): Promise<bigint> {
      return (await publicClient.readContract({
        address: addresses.tusd as Hex,
        abi: tusdAbi,
        functionName: 'allowance',
        args: [owner, addresses.registry],
      })) as bigint
    },

    async authorizationUsed(authorizer: Address, nonce: Hex): Promise<boolean> {
      return (await publicClient.readContract({
        address: addresses.tusd as Hex,
        abi: tusdAbi,
        functionName: 'authorizationState',
        args: [authorizer, nonce],
      })) as boolean
    },

    /** AD-2: the single source `refreshListingFromChain` maps into the cache. */
    async getListing(registryListingId: bigint): Promise<RegistryListing> {
      const listing = (await publicClient.readContract({
        address: addresses.registry as Hex,
        abi: registryAbi,
        functionName: 'getListing',
        args: [registryListingId],
      })) as RawRegistryListing
      return {
        creator: listing.creator.toLowerCase(),
        payTo: listing.payTo.toLowerCase(),
        agentId: listing.agentId,
        agentType: listing.agentType,
        endpoint: listing.endpoint,
        price: listing.price,
        stake: listing.stake,
        reputationBps: Number(listing.reputationBps),
        pausedByCreator: listing.pausedByCreator,
        pausedByStake: listing.pausedByStake,
      }
    },
  }
}

/** The Solidity struct as viem decodes it: named fields, `uint` as `bigint`. */
interface RawRegistryListing {
  creator: string
  payTo: string
  agentId: bigint
  agentType: string
  endpoint: string
  price: bigint
  stake: bigint
  reputationBps: number | bigint
  pausedByCreator: boolean
  pausedByStake: boolean
}
