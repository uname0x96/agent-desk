import { describe, expect, it } from 'vitest'
import { readHealth, type HealthProbe } from '../src/health.ts'
import { RELAYER, testConfig } from './fixtures.ts'

function probe(overrides: Partial<HealthProbe> = {}): HealthProbe {
  return {
    address: RELAYER,
    getBalance: async () => 50_000_000_000_000_000n,
    getPendingNonce: async () => 12,
    getLatestNonce: async () => 9,
    ...overrides,
  }
}

describe('readHealth', () => {
  it('answers 200 with the relayer address, BNB balance and pending nonce count', async () => {
    const health = await readHealth(testConfig(), probe())
    expect(health.status).toBe(200)
    expect(health.body.status).toBe('ok')
    expect(health.body.relayer).toEqual({
      address: RELAYER,
      bnbBalanceWei: '50000000000000000',
      bnbBalance: '0.05',
      pendingNonceCount: 3,
    })
  })

  it('reports zero pending when nothing is in flight', async () => {
    const health = await readHealth(testConfig(), probe({ getPendingNonce: async () => 9 }))
    expect((health.body.relayer as { pendingNonceCount: number }).pendingNonceCount).toBe(0)
  })

  it('reports whether tUSD is deployed yet', async () => {
    const health = await readHealth(testConfig({ assetDeployed: false }), probe())
    expect((health.body.asset as { deployed: boolean }).deployed).toBe(false)
  })

  it('answers 503 when the RPC is unreachable', async () => {
    const health = await readHealth(
      testConfig(),
      probe({
        getBalance: async () => {
          throw new Error('fetch failed')
        },
      }),
    )
    expect(health.status).toBe(503)
    expect(health.body.status).toBe('rpc_unreachable')
    expect(health.body.error).toBe('fetch failed')
    expect(health.body.relayer).toEqual({ address: RELAYER })
  })

  it('answers 503 when the nonce reads fail', async () => {
    const health = await readHealth(
      testConfig(),
      probe({
        getPendingNonce: async () => {
          throw new Error('all fallback transports failed')
        },
      }),
    )
    expect(health.status).toBe(503)
    expect(health.body.error).toBe('all fallback transports failed')
  })
})
