import { describe, expect, it } from 'vitest'
import { getDeployment, ZERO_ADDRESS } from '@agent-desk/schemas'
import { buildFacilitatorConfig, supportedExtra } from '../src/config.ts'
import { SUPPORTED_CHAIN_ID } from '../src/env.ts'

const env = {
  chainId: SUPPORTED_CHAIN_ID,
  rpcUrls: ['https://a.example/rpc'],
  relayerKey: `0x${'11'.repeat(32)}` as `0x${string}`,
  port: 4020,
  facilitatorUrl: 'http://facilitator:4020',
}

describe('buildFacilitatorConfig', () => {
  it('takes the asset and EIP-712 domain from deployments/97.json at runtime', () => {
    const deployment = getDeployment(SUPPORTED_CHAIN_ID)
    const config = buildFacilitatorConfig(env)
    expect(config.chainId).toBe(SUPPORTED_CHAIN_ID)
    expect(config.x402.network).toBe(`eip155:${SUPPORTED_CHAIN_ID}`)
    expect(config.x402.asset).toBe(deployment.tusd.address.toLowerCase())
    expect(config.x402.extra).toEqual({ name: deployment.tusd.name, version: deployment.tusd.version })
    expect(config.x402.decimals).toBe(deployment.tusd.decimals)
    expect(config.x402.maxTimeoutSeconds).toBe(15)
  })

  it('tracks whether tUSD has been deployed yet, ignoring the registry addresses', () => {
    const tusd = getDeployment(SUPPORTED_CHAIN_ID).tusd.address.toLowerCase()
    expect(buildFacilitatorConfig(env).assetDeployed).toBe(tusd !== ZERO_ADDRESS)
  })

  it('publishes the asset, decimals and domain as the supported extra', () => {
    const config = buildFacilitatorConfig(env)
    expect(supportedExtra(config)).toEqual({
      asset: config.x402.asset,
      decimals: config.x402.decimals,
      name: config.x402.extra.name,
      version: config.x402.extra.version,
    })
  })
})
