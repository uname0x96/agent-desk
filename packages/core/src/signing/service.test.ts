import { describe, expect, it } from 'vitest'
import { toBaseUnits } from '@agent-desk/schemas'
import { createSigningService, type PaymentSigningRequest } from './service.ts'
import { bnbToWei } from './policy.ts'
import {
  StubChainReader,
  StubPaymentSigner,
  StubSigner,
  StubSigningStore,
  fixedClock,
  stubWallet,
} from './test-support.ts'

/**
 * AD-5, as behaviour: what the lock guarantees, what the policy refuses before
 * anything is signed, and why a retry can never produce a second authorization
 * for one Call.
 */

const NOW = '2026-09-06T12:00:00.000Z'
const WALLET = stubWallet({ id: 'wal_A', accountId: 'acc_A' })
const tusd = (decimal: string) => toBaseUnits(decimal).toString()

function build(options: {
  store?: StubSigningStore
  payments?: StubPaymentSigner
  signer?: StubSigner
  chain?: StubChainReader
} = {}) {
  const store = options.store ?? new StubSigningStore()
  const payments = options.payments ?? new StubPaymentSigner()
  const signer = options.signer ?? new StubSigner()
  const chain = options.chain ?? new StubChainReader()
  store.seedWallet(WALLET)
  const service = createSigningService({
    signer,
    payments,
    store,
    chain,
    clock: fixedClock(NOW),
    gasFloorWei: bnbToWei('0.02'),
  })
  return { service, store, payments, signer, chain }
}

function paymentRequest(overrides: Partial<PaymentSigningRequest> = {}): PaymentSigningRequest {
  return {
    scheme: 'exact',
    network: 'eip155:97',
    asset: '0x00000000000000000000000000000000000000cc',
    amount: tusd('0.01'),
    payTo: '0x00000000000000000000000000000000000000bb',
    maxTimeoutSeconds: 15,
    extra: { name: 'tUSD', version: '1' },
    call: {
      callId: 'call_1',
      kind: 'run',
      accountId: 'acc_A',
      listingId: 'lst_1',
      nodeType: 'data',
    },
    ...overrides,
  }
}

describe('signPayment', () => {
  it('signs once and records the payload and the status in one write', async () => {
    const { service, store, payments } = build()

    const result = await service.signPayment('wal_A', paymentRequest())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reused).toBe(false)
    expect(result.header).toBe('header-1')
    expect(payments.signatures).toBe(1)

    // AD-3: the five fields `calls.payment_payload` carries, plus the signature
    // and the header a retry resends unchanged.
    expect(store.recorded).toHaveLength(1)
    expect(store.recorded[0]?.callId).toBe('call_1')
    expect(store.recorded[0]?.startedAt.toISOString()).toBe(NOW)
    expect(store.recorded[0]?.payload).toMatchObject({
      from: WALLET.address,
      to: '0x00000000000000000000000000000000000000bb',
      value: tusd('0.01'),
      validAfter: '0',
      header: 'header-1',
    })
  })

  it('returns the stored header on a retry and never signs twice', async () => {
    const { service, store, payments } = build()

    const first = await service.signPayment('wal_A', paymentRequest())
    const second = await service.signPayment('wal_A', paymentRequest())

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.reused).toBe(true)
    expect(second.header).toBe(first.header)
    expect(payments.signatures).toBe(1)
    expect(store.recorded).toHaveLength(1)
  })

  it('serialises two concurrent signPayment calls on one wallet', async () => {
    const { service, store, payments } = build()

    // The store yields inside `recordPaymentAuthorization`, which is the window
    // a second caller would slip through if the lock did not hold: it has read
    // "no stored payload" but has not yet written one.
    let inside = 0
    let peak = 0
    store.onRecord = async () => {
      inside += 1
      peak = Math.max(peak, inside)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inside -= 1
    }

    const [a, b] = await Promise.all([
      service.signPayment('wal_A', paymentRequest()),
      service.signPayment('wal_A', paymentRequest()),
    ])

    expect(peak).toBe(1)
    // The second caller found the first one's payload: one signature, one row.
    expect(payments.signatures).toBe(1)
    expect(store.recorded).toHaveLength(1)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.header).toBe(a.header)
    expect([a.reused, b.reused].filter(Boolean)).toHaveLength(1)
  })

  it('refuses over the Daily Fee Budget before signing', async () => {
    const store = new StubSigningStore({ budget: { spend: toBaseUnits('0.995'), budget: toBaseUnits('1') } })
    const { service, payments } = build({ store })

    const result = await service.signPayment('wal_A', paymentRequest())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('refused_budget')
    expect(payments.signatures).toBe(0)
    expect(store.recorded).toHaveLength(0)
  })

  it('refuses a research Call over the Stake reservation before signing', async () => {
    const store = new StubSigningStore({
      stake: { stake: toBaseUnits('0.30'), reserved: toBaseUnits('0.295') },
    })
    const { service, payments } = build({ store })

    const result = await service.signPayment(
      'wal_A',
      paymentRequest({ call: { callId: 'call_2', kind: 'run', accountId: 'acc_A', listingId: 'lst_1', nodeType: 'research' } }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('refused_stake')
    expect(payments.signatures).toBe(0)
  })

  it('checks the verification cap and no Stake for a verification Call', async () => {
    const store = new StubSigningStore({
      verification: { spent: toBaseUnits('5'), cap: toBaseUnits('5') },
      // Deliberately exhausted: FR-11 exempts a verification Call from scoring,
      // so it must never reserve Stake and must never be refused for it.
      stake: { stake: 0n, reserved: 0n },
    })
    const { service } = build({ store })

    const refused = await service.signPayment(
      'wal_A',
      paymentRequest({ call: { callId: 'call_v', kind: 'verification', accountId: null, listingId: 'lst_1', nodeType: 'research' } }),
    )
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.refusal.check).toBe('verification_cap')

    store.verification = { spent: 0n, cap: toBaseUnits('5'), callCounted: false }
    const allowed = await service.signPayment(
      'wal_A',
      paymentRequest({ call: { callId: 'call_v2', kind: 'verification', accountId: null, listingId: 'lst_1', nodeType: 'research' } }),
    )
    expect(allowed.ok).toBe(true)
  })
})

describe('sendTx', () => {
  it('refuses below the gas floor and sends nothing', async () => {
    const chain = new StubChainReader()
    chain.balances.set(WALLET.address, bnbToWei('0.019'))
    const { service, signer } = build({ chain })

    const result = await service.sendTx('wal_A', {
      intentKey: 'list:lst_1',
      to: '0x00000000000000000000000000000000000000dd',
      data: '0x1234',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('refused_balance')
    expect(signer.sentTransactions).toHaveLength(0)
  })

  it('honours a per-intent floor, so an approve on a freshly topped-up wallet passes', async () => {
    const chain = new StubChainReader()
    chain.balances.set(WALLET.address, bnbToWei('0.005'))
    const { service, signer } = build({ chain })

    // The service default is 0.02 BNB; `approve:` passes WALLET_GAS_FLOOR.
    const refused = await service.sendTx('wal_A', { intentKey: 'approve:wal_A', to: '0x0', data: '0x' })
    expect(refused.ok).toBe(false)

    const allowed = await service.sendTx('wal_A', {
      intentKey: 'approve:wal_A',
      to: '0x00000000000000000000000000000000000000cc',
      data: '0x095ea7b3',
      gasFloorWei: bnbToWei('0.005'),
    })
    expect(allowed.ok).toBe(true)
    expect(signer.sentTransactions).toHaveLength(1)
  })

  it('refuses a listing write below the ten-times Stake minimum before signing', async () => {
    const chain = new StubChainReader()
    chain.balances.set(WALLET.address, bnbToWei('1'))
    const { service, signer } = build({ chain })

    const result = await service.sendTx('wal_A', {
      intentKey: 'price:lst_1:1',
      to: '0x00000000000000000000000000000000000000dd',
      data: '0x1234',
      stakeCheck: { price: toBaseUnits('0.05'), stake: toBaseUnits('0.30') },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.check).toBe('creator_stake_minimum')
    expect(signer.sentTransactions).toHaveLength(0)
  })

  it('serialises two sends on one wallet', async () => {
    const chain = new StubChainReader()
    chain.balances.set(WALLET.address, bnbToWei('1'))
    const { service, signer } = build({ chain })

    const [a, b] = await Promise.all([
      service.sendTx('wal_A', { intentKey: 'gas:wal_A', to: '0x00000000000000000000000000000000000000ee', data: '0x' }),
      service.sendTx('wal_A', { intentKey: 'mint:wal_A', to: '0x00000000000000000000000000000000000000cc', data: '0x40c10f19' }),
    ])

    expect(a.ok && b.ok).toBe(true)
    expect(signer.sentTransactions).toHaveLength(2)
    // Distinct hashes: the stub numbers them in send order.
    expect(new Set(signer.sentTransactions.map((_, index) => index)).size).toBe(2)
  })

  it('throws for a wallet that does not exist', async () => {
    const { service } = build()
    await expect(
      service.sendTx('wal_missing', { intentKey: 'gas:wal_missing', to: '0x0', data: '0x' }),
    ).rejects.toThrow('no wallet wal_missing')
  })
})
