import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import type { FacilitatorEvmSigner } from '@x402/evm'
import type { FacilitatorConfig } from '../src/config.ts'

export const ASSET = '0x1111111111111111111111111111111111111111'
export const OTHER_ASSET = '0x2222222222222222222222222222222222222222'
export const PAY_TO = '0x3333333333333333333333333333333333333333'
export const PAYER = '0x4444444444444444444444444444444444444444'
export const RELAYER = '0x5555555555555555555555555555555555555555'
export const NONCE = `0x${'ab'.repeat(32)}`

export function testConfig(overrides: Partial<FacilitatorConfig> = {}): FacilitatorConfig {
  return {
    chainId: 97,
    assetDeployed: true,
    x402: {
      network: 'eip155:97',
      asset: ASSET,
      extra: { name: 'tUSD', version: '1' },
      facilitatorUrl: 'http://localhost:4020',
      decimals: 6,
      maxTimeoutSeconds: 15,
    },
    ...overrides,
  }
}

export function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:97',
    asset: ASSET,
    amount: '10000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 15,
    extra: { name: 'tUSD', version: '1' },
    ...overrides,
  }
}

export function payload(accepted: PaymentRequirements = requirements()): PaymentPayload {
  return {
    x402Version: 2,
    accepted,
    payload: {
      signature: `0x${'cd'.repeat(65)}`,
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: accepted.amount,
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + 60),
        nonce: NONCE,
      },
    },
  }
}

export interface SignerCalls {
  readContract: { functionName: string; args: readonly unknown[] }[]
  writeContract: unknown[]
  sendTransaction: unknown[]
}

/** A FacilitatorEvmSigner that touches no chain and records what was asked of it. */
export function fakeSigner(options: { authorizationState?: boolean } = {}): {
  signer: FacilitatorEvmSigner
  calls: SignerCalls
} {
  const calls: SignerCalls = { readContract: [], writeContract: [], sendTransaction: [] }
  const signer: FacilitatorEvmSigner = {
    getAddresses: () => [RELAYER],
    readContract: async (args) => {
      calls.readContract.push({ functionName: args.functionName, args: args.args ?? [] })
      if (args.functionName === 'authorizationState') return options.authorizationState ?? false
      throw new Error(`unstubbed readContract: ${args.functionName}`)
    },
    verifyTypedData: async () => true,
    writeContract: async (args) => {
      calls.writeContract.push(args)
      throw new Error('writeContract must not be reached in these tests')
    },
    sendTransaction: async (args) => {
      calls.sendTransaction.push(args)
      throw new Error('sendTransaction must not be reached in these tests')
    },
    waitForTransactionReceipt: async () => ({ status: 'success' }),
    getCode: async () => '0x60',
  }
  return { signer, calls }
}
