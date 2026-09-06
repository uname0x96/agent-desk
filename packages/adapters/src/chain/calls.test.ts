import { describe, expect, it } from 'vitest'
import { decodeFunctionData, getAddress, keccak256, stringToHex } from 'viem'
import { toBaseUnits } from '@agent-desk/schemas'
import { identityRegistryAbi, registryAbi, tusdAbi } from './abi.ts'
import { createContractCalls } from './calls.ts'
import type { ContractAddresses } from './clients.ts'

/**
 * AD-8: adapters encode against the ABI the contracts build exported, and this
 * file is the only place an argument order is written down. Every case decodes
 * the calldata back through the same ABI, so a swapped argument fails here
 * instead of reverting on testnet with a message nobody can read.
 */

const ADDRESSES: ContractAddresses = {
  tusd: '0x00000000000000000000000000000000000000cc',
  registry: '0x00000000000000000000000000000000000000dd',
  identityRegistry: '0x8004a818bfb912233c491871b3d84c89a494bd9e',
}

const calls = createContractCalls(ADDRESSES)
const WALLET = '0x00000000000000000000000000000000000000aa'
const PAY_TO = '0x00000000000000000000000000000000000000bb'
/** viem decodes addresses checksummed; the wire bytes are the same 20. */
const checksummed = (address: string) => getAddress(address)

describe('tUSD calls', () => {
  it('encodes mint(to, amount) against the token', () => {
    const call = calls.tusdMint(WALLET, toBaseUnits('100'))
    expect(call.to).toBe(ADDRESSES.tusd)
    expect(decodeFunctionData({ abi: tusdAbi, data: call.data })).toMatchObject({
      functionName: 'mint',
      args: [checksummed(WALLET), 100_000_000n],
    })
  })

  it('encodes approve(spender, value) with the registry as the spender', () => {
    const max = (1n << 256n) - 1n
    const call = calls.tusdApprove(ADDRESSES.registry, max)
    expect(call.to).toBe(ADDRESSES.tusd)
    expect(decodeFunctionData({ abi: tusdAbi, data: call.data })).toMatchObject({
      functionName: 'approve',
      args: [checksummed(ADDRESSES.registry), max],
    })
  })
})

describe('identity registry calls', () => {
  it('encodes register(agentURI)', () => {
    const uri = 'https://agentdesk.example/api/listings/lst_1/agent.json'
    const call = calls.identityRegister(uri)
    expect(call.to).toBe(ADDRESSES.identityRegistry)
    expect(decodeFunctionData({ abi: identityRegistryAbi, data: call.data })).toMatchObject({
      functionName: 'register',
      args: [uri],
    })
  })

  it('encodes setAgentURI(agentId, agentURI) for the AD-2 repair path', () => {
    const call = calls.identitySetAgentUri(42n, 'data:application/json;base64,e30=')
    expect(decodeFunctionData({ abi: identityRegistryAbi, data: call.data })).toMatchObject({
      functionName: 'setAgentURI',
      args: [42n, 'data:application/json;base64,e30='],
    })
  })
})

describe('registry calls', () => {
  it('encodes list(agentId, agentType, price, endpoint, payTo, stake) in that order', () => {
    const call = calls.registryList({
      agentId: 7n,
      agentType: 'data',
      price: toBaseUnits('0.01'),
      endpoint: 'https://agent.example/',
      payTo: PAY_TO,
      stake: toBaseUnits('0.10'),
    })
    expect(call.to).toBe(ADDRESSES.registry)
    expect(decodeFunctionData({ abi: registryAbi, data: call.data })).toMatchObject({
      functionName: 'list',
      args: [7n, 'data', 10_000n, 'https://agent.example/', checksummed(PAY_TO), 100_000n],
    })
  })

  it('encodes addStake, setPrice, and setPaused', () => {
    expect(decodeFunctionData({ abi: registryAbi, data: calls.registryAddStake(3n, 500n).data })).toMatchObject({
      functionName: 'addStake',
      args: [3n, 500n],
    })
    expect(decodeFunctionData({ abi: registryAbi, data: calls.registrySetPrice(3n, 20_000n).data })).toMatchObject({
      functionName: 'setPrice',
      args: [3n, 20_000n],
    })
    expect(decodeFunctionData({ abi: registryAbi, data: calls.registrySetPaused(3n, true).data })).toMatchObject({
      functionName: 'setPaused',
      args: [3n, true],
    })
  })

  it('encodes slash(listingId, callRef, amount, to)', () => {
    const callRef = calls.callRef('call_1')
    const call = calls.registrySlash({
      registryListingId: 3n,
      callRef,
      amount: toBaseUnits('0.05'),
      to: WALLET,
    })
    expect(decodeFunctionData({ abi: registryAbi, data: call.data })).toMatchObject({
      functionName: 'slash',
      args: [3n, callRef, 50_000n, checksummed(WALLET)],
    })
  })

  it('encodes setReputation(listingId, bps)', () => {
    expect(
      decodeFunctionData({ abi: registryAbi, data: calls.registrySetReputation(3n, 8_750).data }),
    ).toMatchObject({ functionName: 'setReputation', args: [3n, 8_750] })
  })
})

describe('nativeTransfer', () => {
  it('is a bare value transfer with no calldata', () => {
    const call = calls.nativeTransfer(WALLET, 5_000_000_000_000_000n)
    expect(call).toEqual({ to: WALLET, data: '0x', value: 5_000_000_000_000_000n })
  })
})

describe('callRef', () => {
  it('is keccak256 of the call id, pinned to a fixed value', () => {
    const callId = 'call_01JKZ0000000000000000000AA'
    expect(calls.callRef(callId)).toBe(
      '0xfa98d60132e1fbc97b7a6f4360a36575c8abdc1325126ba28e10fb6ea410f835',
    )
    expect(calls.callRef(callId)).toBe(keccak256(stringToHex(callId)))
  })
})
