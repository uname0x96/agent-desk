import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  nonceManager,
  type Abi,
  type PublicClient,
  type TypedDataDomain,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bscTestnet } from 'viem/chains'
import { toFacilitatorEvmSigner, type FacilitatorEvmSigner } from '@x402/evm'
import { SUPPORTED_CHAIN_ID, type FacilitatorEnv } from './env.ts'

/**
 * Conventions: chain reads and sends go through viem `fallback()` over
 * `RPC_URLS` with three retries; receipts are awaited up to 60 s; the
 * facilitator relayer uses viem's `nonceManager`.
 */
type VerifyTypedDataArgs = Parameters<PublicClient['verifyTypedData']>[0]

export const RPC_RETRY_COUNT = 3
export const RECEIPT_TIMEOUT_MS = 60_000

export interface Relayer {
  address: `0x${string}`
  publicClient: PublicClient
  walletClient: WalletClient
  /** What `@x402/evm` verifies and settles through. */
  signer: FacilitatorEvmSigner
}

function chainFor(chainId: number) {
  if (chainId !== SUPPORTED_CHAIN_ID) {
    throw new Error(`no viem chain registered for ${chainId}; this facilitator serves ${SUPPORTED_CHAIN_ID} only`)
  }
  return bscTestnet
}

export function createRelayer(env: FacilitatorEnv): Relayer {
  const chain = chainFor(env.chainId)
  const transport = fallback(env.rpcUrls.map((url) => http(url, { retryCount: RPC_RETRY_COUNT })))
  // nonceManager keeps concurrent settlements off the same nonce.
  const account = privateKeyToAccount(env.relayerKey, { nonceManager })
  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({ account, chain, transport })

  const signer = toFacilitatorEvmSigner(
    {
      address: account.address,
      readContract: (args) =>
        publicClient.readContract({
          address: args.address,
          abi: args.abi as Abi,
          functionName: args.functionName,
          args: args.args ? [...args.args] : [],
        }),
      // viem's typed-data generics cannot be expressed from the SDK's loose
      // Record shape, so the parameter object is cast once, here.
      verifyTypedData: (args) =>
        publicClient.verifyTypedData({
          address: args.address,
          domain: args.domain as TypedDataDomain,
          types: args.types,
          primaryType: args.primaryType,
          message: args.message,
          signature: args.signature,
        } as unknown as VerifyTypedDataArgs),
      writeContract: (args) =>
        walletClient.writeContract({
          account,
          chain,
          address: args.address,
          abi: args.abi as Abi,
          functionName: args.functionName,
          args: [...args.args],
          ...(args.gas === undefined ? {} : { gas: args.gas }),
          ...(args.dataSuffix === undefined ? {} : { dataSuffix: args.dataSuffix }),
        }),
      sendTransaction: (args) => walletClient.sendTransaction({ account, chain, to: args.to, data: args.data }),
      waitForTransactionReceipt: (args) =>
        publicClient.waitForTransactionReceipt({
          hash: args.hash,
          timeout: args.timeout ?? RECEIPT_TIMEOUT_MS,
        }),
      getCode: (args) => publicClient.getCode({ address: args.address }),
    },
    { confirmationTimeoutMs: RECEIPT_TIMEOUT_MS },
  )

  return { address: account.address, publicClient, walletClient, signer }
}
