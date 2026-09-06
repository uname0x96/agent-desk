import { describe, expect, it } from 'vitest'
import { AgentDeskExactScheme, REJECTION, checkAdmissible } from '../src/scheme.ts'
import { ASSET, NONCE, OTHER_ASSET, PAYER, fakeSigner, payload, requirements, testConfig } from './fixtures.ts'

describe('checkAdmissible (AD-6 admission rules)', () => {
  it('admits a request that matches the configured network, asset and domain', () => {
    expect(checkAdmissible(testConfig(), payload(), requirements())).toBeUndefined()
  })

  it('admits a checksummed asset that differs only in case', () => {
    const upper = ASSET.toUpperCase().replace('0X', '0x')
    const accepted = requirements({ asset: upper })
    expect(checkAdmissible(testConfig(), payload(accepted), accepted)).toBeUndefined()
  })

  it('rejects an asset that is not the configured one', () => {
    const accepted = requirements({ asset: OTHER_ASSET })
    expect(checkAdmissible(testConfig(), payload(accepted), accepted)).toBe(REJECTION.unsupportedAsset)
  })

  it('rejects requirements whose extra is missing', () => {
    const accepted = requirements({ extra: undefined as unknown as Record<string, unknown> })
    expect(checkAdmissible(testConfig(), payload(accepted), accepted)).toBe(REJECTION.missingExtra)
  })

  it('rejects requirements whose extra omits version', () => {
    const accepted = requirements({ extra: { name: 'tUSD' } })
    expect(checkAdmissible(testConfig(), payload(accepted), accepted)).toBe(REJECTION.missingExtra)
  })

  it('rejects an extra whose EIP-712 domain is not the configured token domain', () => {
    const accepted = requirements({ extra: { name: 'USDC', version: '2' } })
    expect(checkAdmissible(testConfig(), payload(accepted), accepted)).toBe(REJECTION.domainMismatch)
  })

  it('rejects a network that is not eip155:97', () => {
    const accepted = requirements({ network: 'eip155:56' })
    expect(checkAdmissible(testConfig(), payload(accepted), accepted)).toBe(REJECTION.networkMismatch)
  })

  it('rejects when the payload accepted block disagrees with the requirements asset', () => {
    expect(checkAdmissible(testConfig(), payload(requirements({ asset: OTHER_ASSET })), requirements())).toBe(
      REJECTION.acceptedMismatch,
    )
  })

  it('rejects everything while tUSD is still the zero address', () => {
    const config = testConfig({ assetDeployed: false })
    expect(checkAdmissible(config, payload(), requirements())).toBe(REJECTION.assetNotDeployed)
  })
})

describe('AgentDeskExactScheme', () => {
  it('publishes the configured asset and domain as the supported extra', () => {
    const { signer } = fakeSigner()
    const scheme = new AgentDeskExactScheme(testConfig(), signer)
    expect(scheme.scheme).toBe('exact')
    expect(scheme.getExtra('eip155:97')).toEqual({ asset: ASSET, decimals: 6, name: 'tUSD', version: '1' })
  })

  it('rejects verify without touching the chain when extra is missing', async () => {
    const { signer, calls } = fakeSigner()
    const scheme = new AgentDeskExactScheme(testConfig(), signer)
    const accepted = requirements({ extra: undefined as unknown as Record<string, unknown> })
    const result = await scheme.verify(payload(accepted), accepted)
    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe(REJECTION.missingExtra)
    expect(result.payer).toBe(PAYER)
    expect(calls.readContract).toHaveLength(0)
  })

  it('rejects verify for an asset that is not the configured one', async () => {
    const { signer, calls } = fakeSigner()
    const scheme = new AgentDeskExactScheme(testConfig(), signer)
    const accepted = requirements({ asset: OTHER_ASSET })
    const result = await scheme.verify(payload(accepted), accepted)
    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe(REJECTION.unsupportedAsset)
    expect(calls.readContract).toHaveLength(0)
  })

  it('refuses to settle a replayed authorisation and sends no transaction', async () => {
    const { signer, calls } = fakeSigner({ authorizationState: true })
    const scheme = new AgentDeskExactScheme(testConfig(), signer)
    const result = await scheme.settle(payload(), requirements())
    expect(result.success).toBe(false)
    expect(result.errorReason).toBe(REJECTION.nonceAlreadyUsed)
    expect(result.transaction).toBe('')
    expect(result.network).toBe('eip155:97')
    expect(calls.readContract).toEqual([{ functionName: 'authorizationState', args: [PAYER, NONCE] }])
    expect(calls.writeContract).toHaveLength(0)
    expect(calls.sendTransaction).toHaveLength(0)
  })

  it('checks the authorisation state against the configured asset before settling', async () => {
    const { signer, calls } = fakeSigner({ authorizationState: false })
    const scheme = new AgentDeskExactScheme(testConfig(), signer)
    const result = await scheme.settle(payload(), requirements())
    expect(calls.readContract[0]).toEqual({ functionName: 'authorizationState', args: [PAYER, NONCE] })
    // The guard passes, so the inner scheme re-verifies; that verification fails
    // against a signer with no chain behind it, and still nothing is broadcast.
    expect(result.success).toBe(false)
    expect(calls.writeContract).toHaveLength(0)
    expect(calls.sendTransaction).toHaveLength(0)
  })

  it('rejects settle on an admission failure before reading the chain', async () => {
    const { signer, calls } = fakeSigner()
    const scheme = new AgentDeskExactScheme(testConfig(), signer)
    const accepted = requirements({ asset: OTHER_ASSET })
    const result = await scheme.settle(payload(accepted), accepted)
    expect(result.success).toBe(false)
    expect(result.errorReason).toBe(REJECTION.unsupportedAsset)
    expect(calls.readContract).toHaveLength(0)
    expect(calls.writeContract).toHaveLength(0)
  })
})
