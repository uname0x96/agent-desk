import { encodeFunctionData, keccak256, stringToHex } from 'viem'
import type {
  ChainCall,
  ContractCalls,
  Hex,
  RegistryListArgs,
  RegistrySlashArgs,
} from '@agent-desk/core/ports'
import { identityRegistryAbi, registryAbi, tusdAbi } from './abi.ts'
import { addressesFor, type ContractAddresses } from './clients.ts'

/**
 * Every call this system makes, encoded once. The domain names an intent; this
 * turns it into calldata against the ABI the contracts build exported (AD-8).
 *
 * Amounts arrive as `bigint` in base units and addresses as lower-case strings
 * (AD-13); viem checksums neither on the way in and neither contract cares.
 */
export function createContractCalls(
  chainIdOrAddresses: number | ContractAddresses,
): ContractCalls {
  const addresses =
    typeof chainIdOrAddresses === 'number' ? addressesFor(chainIdOrAddresses) : chainIdOrAddresses

  const call = (to: string, data: Hex): ChainCall => ({ to: to.toLowerCase(), data })

  return {
    addresses,

    nativeTransfer(to, valueWei) {
      return { to: to.toLowerCase(), data: '0x', value: valueWei }
    },

    tusdMint(to, amount) {
      return call(
        addresses.tusd,
        encodeFunctionData({ abi: tusdAbi, functionName: 'mint', args: [to, amount] }),
      )
    },

    tusdApprove(spender, value) {
      return call(
        addresses.tusd,
        encodeFunctionData({ abi: tusdAbi, functionName: 'approve', args: [spender, value] }),
      )
    },

    identityRegister(agentUri) {
      return call(
        addresses.identityRegistry,
        encodeFunctionData({
          abi: identityRegistryAbi,
          functionName: 'register',
          args: [agentUri],
        }),
      )
    },

    identitySetAgentUri(agentId, agentUri) {
      return call(
        addresses.identityRegistry,
        encodeFunctionData({
          abi: identityRegistryAbi,
          functionName: 'setAgentURI',
          args: [agentId, agentUri],
        }),
      )
    },

    registryList(args: RegistryListArgs) {
      return call(
        addresses.registry,
        encodeFunctionData({
          abi: registryAbi,
          functionName: 'list',
          // The contract stores the Type name verbatim, so the argument order
          // here is the FR-6 field order and not a convenience.
          args: [args.agentId, args.agentType, args.price, args.endpoint, args.payTo, args.stake],
        }),
      )
    },

    registryAddStake(registryListingId, amount) {
      return call(
        addresses.registry,
        encodeFunctionData({
          abi: registryAbi,
          functionName: 'addStake',
          args: [registryListingId, amount],
        }),
      )
    },

    registrySetPrice(registryListingId, price) {
      return call(
        addresses.registry,
        encodeFunctionData({
          abi: registryAbi,
          functionName: 'setPrice',
          args: [registryListingId, price],
        }),
      )
    },

    registrySetPaused(registryListingId, paused) {
      return call(
        addresses.registry,
        encodeFunctionData({
          abi: registryAbi,
          functionName: 'setPaused',
          args: [registryListingId, paused],
        }),
      )
    },

    registrySlash(args: RegistrySlashArgs) {
      return call(
        addresses.registry,
        encodeFunctionData({
          abi: registryAbi,
          functionName: 'slash',
          args: [args.registryListingId, args.callRef, args.amount, args.to],
        }),
      )
    },

    registrySetReputation(registryListingId, bps) {
      return call(
        addresses.registry,
        encodeFunctionData({
          abi: registryAbi,
          functionName: 'setReputation',
          args: [registryListingId, bps],
        }),
      )
    },

    /** AD-8: `callRef` is `keccak256(call_id)`, over the id's UTF-8 bytes. */
    callRef(callId: string): Hex {
      return keccak256(stringToHex(callId))
    },
  }
}
