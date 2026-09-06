import { describe, expect, it } from 'vitest'
import { ZERO_ADDRESS, toBaseUnits } from '@agent-desk/schemas'
import { buildPriceLock, checkAdmission, type WorkflowNodeRow } from './admission.ts'

/**
 * The refusal rules of `POST /api/runs`, without a database.
 *
 * Everything here is a value in and a value out, which is the point: the reason
 * a Run was refused, and by how much, has to be provable without a Postgres, an
 * RPC node, or a paid Agent anywhere near it.
 */

const ASSET = '0xd0e0851ca8a176d211e2a410f5bcf1fa440fada7'
const PAYOUT = '0x00000000000000000000000000000000000000Bb'
const NOW = new Date('2026-09-06T12:00:00.000Z')
const CONFIG = { chainId: 97, asset: ASSET }

function node(overrides: Partial<WorkflowNodeRow> = {}): WorkflowNodeRow {
  return {
    nodeIndex: 0,
    nodeType: 'data',
    listingId: 'lst_01J000000000000000000000AA',
    provider: 'Price Feed',
    status: 'active',
    price: toBaseUnits('0.01').toString(),
    payoutWallet: PAYOUT,
    pausedByCreator: false,
    pausedByStake: false,
    ...overrides,
  }
}

describe('buildPriceLock', () => {
  it('locks every active Node at the Listing price, in node_index order', () => {
    const result = buildPriceLock(
      [
        node({ nodeIndex: 1, nodeType: 'research', price: toBaseUnits('0.02').toString() }),
        node({ nodeIndex: 0, nodeType: 'data', price: toBaseUnits('0.01').toString() }),
      ],
      CONFIG,
      NOW,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lock.nodes.map((entry) => entry.node_index)).toEqual([0, 1])
    expect(result.lock.total).toBe(toBaseUnits('0.03').toString())
    expect(result.lock.locked_at).toBe('2026-09-06T12:00:00.000Z')
  })

  it('writes the asset and the network from the deployment, not from the Listing', () => {
    const result = buildPriceLock([node()], CONFIG, NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lock.nodes[0]?.asset).toBe(ASSET)
    expect(result.lock.nodes[0]?.network).toBe('eip155:97')
  })

  it('lower-cases pay_to, so AD-13 holds before the 402 is ever compared', () => {
    const result = buildPriceLock([node({ payoutWallet: PAYOUT })], CONFIG, NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lock.nodes[0]?.pay_to).toBe(PAYOUT.toLowerCase())
  })

  it('refuses a Workflow with no Nodes', () => {
    const result = buildPriceLock([], CONFIG, NOW)
    expect(result).toMatchObject({ ok: false, refusal: { code: 'validation_failed' } })
  })

  it('refuses when tUSD is not deployed on this chain', () => {
    const result = buildPriceLock([node()], { chainId: 97, asset: ZERO_ADDRESS }, NOW)
    expect(result).toMatchObject({ ok: false, refusal: { code: 'validation_failed' } })
  })

  for (const status of ['verifying', 'paused', 'failed'] as const) {
    it(`refuses a Listing that is ${status} rather than active`, () => {
      const result = buildPriceLock([node({ status })], CONFIG, NOW)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.refusal.code).toBe('validation_failed')
      expect(result.refusal.details).toMatchObject({ node_index: 0, status })
    })
  }

  it('refuses a Listing the Creator paused on chain', () => {
    const result = buildPriceLock([node({ pausedByCreator: true })], CONFIG, NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('validation_failed')
    expect(result.refusal.details).toMatchObject({ paused_by_creator: true })
  })

  it('refuses a Listing the Registry paused for an under-collateralised Stake', () => {
    const result = buildPriceLock([node({ pausedByStake: true })], CONFIG, NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.details).toMatchObject({ paused_by_stake: true })
  })

  it('refuses a Listing with no confirmed on-chain price', () => {
    const result = buildPriceLock([node({ price: null })], CONFIG, NOW)
    expect(result).toMatchObject({ ok: false, refusal: { code: 'validation_failed' } })
  })

  it('names the offending Node even when it is not the first one', () => {
    const result = buildPriceLock([node({ nodeIndex: 0 }), node({ nodeIndex: 1, status: 'paused' })], CONFIG, NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.details).toMatchObject({ node_index: 1 })
  })
})

describe('checkAdmission', () => {
  const ready = new Date('2026-09-01T00:00:00.000Z')

  it('admits a Run that fits both the budget and the balance', () => {
    expect(
      checkAdmission({
        walletReadyAt: ready,
        total: 30_000n,
        spend: 10_000n,
        budget: 1_000_000n,
        balance: 30_000n,
      }),
    ).toBeNull()
  })

  it('refuses before anything else when the wallet is not ready', () => {
    const refusal = checkAdmission({
      walletReadyAt: null,
      total: 1n,
      spend: 0n,
      budget: 0n,
      balance: 0n,
    })
    // The budget and the balance are both violated here too; the wallet wins.
    expect(refusal?.code).toBe('wallet_not_ready')
  })

  it('refuses a missing wallet row the same way', () => {
    expect(
      checkAdmission({ walletReadyAt: undefined, total: 1n, spend: 0n, budget: 100n, balance: 100n }),
    ).toMatchObject({ code: 'wallet_not_ready' })
  })

  it('refuses on the budget with the shortfall in base units', () => {
    const refusal = checkAdmission({
      walletReadyAt: ready,
      total: 30_000n,
      spend: 990_000n,
      budget: 1_000_000n,
      balance: 10_000_000n,
    })
    expect(refusal?.code).toBe('refused_budget')
    expect(refusal?.details).toEqual({
      spend: '990000',
      budget: '1000000',
      total: '30000',
      shortfall: '20000',
    })
  })

  it('admits a Run that lands exactly on the budget', () => {
    expect(
      checkAdmission({
        walletReadyAt: ready,
        total: 10_000n,
        spend: 990_000n,
        budget: 1_000_000n,
        balance: 10_000n,
      }),
    ).toBeNull()
  })

  it('checks the budget before the balance', () => {
    const refusal = checkAdmission({
      walletReadyAt: ready,
      total: 30_000n,
      spend: 990_000n,
      budget: 1_000_000n,
      balance: 0n,
    })
    expect(refusal?.code).toBe('refused_budget')
  })

  it('refuses on the balance with the shortfall in base units', () => {
    const refusal = checkAdmission({
      walletReadyAt: ready,
      total: 30_000n,
      spend: 0n,
      budget: 1_000_000n,
      balance: 25_000n,
    })
    expect(refusal?.code).toBe('refused_balance')
    expect(refusal?.details).toEqual({ balance: '25000', total: '30000', shortfall: '5000' })
  })

  it('admits a Run that spends the balance to the last base unit', () => {
    expect(
      checkAdmission({
        walletReadyAt: ready,
        total: 30_000n,
        spend: 0n,
        budget: 1_000_000n,
        balance: 30_000n,
      }),
    ).toBeNull()
  })

  it("compares the balance against the Price Lock only, not against the day's spend", () => {
    // The balance question is "can this Run be paid", not "could every Run today
    // have been paid": the earlier ones already were.
    expect(
      checkAdmission({
        walletReadyAt: ready,
        total: 10_000n,
        spend: 900_000n,
        budget: 1_000_000n,
        balance: 10_000n,
      }),
    ).toBeNull()
  })
})
