import { describe, expect, it } from 'vitest'
import { intentKeys } from '@agent-desk/schemas'
import type { ChainCall, ContractCalls, Hex } from '../ports/index.ts'
import type { BuildTx, ChainWriteResult, ChainWriter } from './chain-writer.ts'
import { MAX_UINT256, createWalletCreationJob } from './wallet-create.ts'
import { bnbToWei } from './policy.ts'
import {
  InMemoryChainTxStore,
  InMemoryWalletStore,
  StubChainReader,
  StubSigner,
  StubSigningStore,
  fixedClock,
} from './test-support.ts'

/**
 * AD-5 / FR-2: the order of the four steps, what each of them sends, and what a
 * retry does. The chain writer here is a fake whose idempotence comes from a
 * real `chain_tx` table in memory; the writer's own AD-8 behaviour is proven in
 * `packages/adapters/src/chain`, and the two are wired together end to end in
 * `packages/adapters/src/chain/wallet-create.test.ts`.
 */

const NOW = '2026-09-06T12:00:00.000Z'
const CONFIRMED_AT = new Date('2026-09-06T12:00:07.000Z')
const TUSD = '0x00000000000000000000000000000000000000cc'
const REGISTRY = '0x00000000000000000000000000000000000000dd'

/** Only the four calls this job makes are real; the rest would be dead weight. */
function stubCalls(): ContractCalls {
  const call = (to: string, data: Hex): ChainCall => ({ to, data })
  const notUsed = () => {
    throw new Error('wallet.create does not make this call')
  }
  return {
    addresses: { tusd: TUSD, registry: REGISTRY, identityRegistry: '0x0' },
    nativeTransfer: (to, value) => ({ to, data: '0x', value }),
    tusdMint: (to, amount) => call(TUSD, `0xmint:${to}:${amount}` as Hex),
    tusdApprove: (spender, value) => call(TUSD, `0xapprove:${spender}:${value}` as Hex),
    identityRegister: notUsed,
    identitySetAgentUri: notUsed,
    registryList: notUsed,
    registryAddStake: notUsed,
    registrySetPrice: notUsed,
    registrySetPaused: notUsed,
    registrySlash: notUsed,
    registrySetReputation: notUsed,
    callRef: notUsed,
  }
}

interface Sent {
  intentKey: string
  walletId: string
  to: string
  value?: bigint
  gasFloorWei?: bigint
}

/** Confirms everything it is asked to send, and never sends a key it already has. */
function fakeChainWriter(store: InMemoryChainTxStore, sent: Sent[]): ChainWriter {
  return {
    async chainWrite(intentKey: string, buildTx: BuildTx): Promise<ChainWriteResult> {
      const existing = await store.find(intentKey)
      if (existing && existing.status !== 'pending') {
        return { intentKey, record: existing, reused: true }
      }
      if (existing?.txHash) {
        // The real writer re-checks the receipt of a hash it already recorded
        // and sends nothing; this fake always finds the receipt.
        await store.settle(intentKey, 'confirmed', {
          txHash: existing.txHash,
          confirmedAt: CONFIRMED_AT,
        })
        return { intentKey, record: (await store.find(intentKey))!, reused: true }
      }
      const request = await buildTx()
      const { inserted } = await store.insertPending(intentKey, request.payload)
      if (!inserted) {
        const record = await store.find(intentKey)
        return { intentKey, record: record!, reused: true }
      }
      sent.push({
        intentKey,
        walletId: request.walletId,
        to: request.to,
        ...(request.value === undefined ? {} : { value: request.value }),
        ...(request.gasFloorWei === undefined ? {} : { gasFloorWei: request.gasFloorWei }),
      })
      const txHash = `0x${sent.length.toString(16).padStart(64, '0')}` as Hex
      await store.attachHash(intentKey, txHash)
      await store.settle(intentKey, 'confirmed', { txHash, confirmedAt: CONFIRMED_AT })
      const record = await store.find(intentKey)
      return { intentKey, record: record!, reused: false }
    },
    async refreshListingFromChain() {
      return { refreshed: false, reason: 'listing_not_found' }
    },
  }
}

function build(options: { mode?: 'production' | 'demo'; balanceWei?: bigint } = {}) {
  const clock = fixedClock(NOW)
  const chainTx = new InMemoryChainTxStore(clock)
  const sent: Sent[] = []
  const wallets = new InMemoryWalletStore()
  const store = new StubSigningStore({ settings: { mode: options.mode ?? 'demo' } })
  const reader = new StubChainReader()
  const signer = new StubSigner()
  const run = createWalletCreationJob({
    signer,
    wallets,
    store,
    chain: fakeChainWriter(chainTx, sent),
    reader,
    calls: stubCalls(),
    clock,
    config: {
      platformWalletId: 'wal_platform',
      walletGasFloorWei: bnbToWei('0.005'),
      platformGasFloorWei: bnbToWei('0.05'),
      demoMintAmount: 100_000_000n,
    },
  })
  if (options.balanceWei !== undefined) {
    // Seeded after the signer numbers addresses from 1.
    reader.balances.set('0x0000000000000000000000000000000000000001', options.balanceWei)
  }
  return { run, chainTx, sent, wallets, store, reader, signer }
}

describe('wallet.create', () => {
  it('runs gas, mint, then approve, and sets ready_at from the approve receipt', async () => {
    const { run, sent, wallets } = build()

    const result = await run({ account_id: 'acc_1' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toBe(true)
    expect(sent.map((s) => s.intentKey)).toEqual([
      intentKeys.gas(result.walletId),
      intentKeys.mint(result.walletId),
      intentKeys.approve(result.walletId),
    ])
    expect(result.steps).toEqual({ gas: 'sent', mint: 'sent', approve: 'sent' })
    expect(result.readyAt).toEqual(CONFIRMED_AT)
    expect(wallets.byId.get(result.walletId)?.readyAt).toEqual(CONFIRMED_AT)
  })

  it('funds from the Platform Wallet up to WALLET_GAS_FLOOR and signs the rest with the new wallet', async () => {
    const { run, sent } = build()

    const result = await run({ account_id: 'acc_1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [gas, mint, approve] = sent
    expect(gas?.walletId).toBe('wal_platform')
    expect(gas?.to).toBe(result.address)
    expect(gas?.value).toBe(bnbToWei('0.005'))
    expect(gas?.gasFloorWei).toBe(bnbToWei('0.05'))

    // Steps 3 and 4 are signed by the wallet that was just funded, so they are
    // held to its floor and not to a Creator's.
    expect(mint?.walletId).toBe(result.walletId)
    expect(approve?.walletId).toBe(result.walletId)
    expect(approve?.gasFloorWei).toBe(bnbToWei('0.005'))
  })

  it('approves the registry for the full uint256 allowance', async () => {
    const { run, chainTx } = build()
    const result = await run({ account_id: 'acc_1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(chainTx.rows.get(intentKeys.approve(result.walletId))?.payload).toEqual({
      wallet_id: result.walletId,
      spender: REGISTRY,
      value: MAX_UINT256.toString(),
    })
  })

  it('skips the mint outside demo mode', async () => {
    const { run, sent } = build({ mode: 'production' })

    const result = await run({ account_id: 'acc_1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.steps.mint).toBe('skipped')
    expect(sent.map((s) => s.intentKey.split(':')[0])).toEqual(['gas', 'approve'])
  })

  it('skips the top-up when the wallet already holds the floor', async () => {
    const { run, sent } = build({ balanceWei: bnbToWei('0.01') })

    const result = await run({ account_id: 'acc_1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.steps.gas).toBe('skipped')
    expect(sent.some((s) => s.intentKey.startsWith('gas:'))).toBe(false)
  })

  it('resumes at the first unconfirmed intent with no second gas or mint transaction', async () => {
    const { run, chainTx, sent, wallets, reader } = build()

    const first = await run({ account_id: 'acc_1' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(sent).toHaveLength(3)
    const walletId = first.walletId

    // The crash: `gas:` and `mint:` confirmed, the process died before
    // `approve:` was ever built, so no row for it and no `ready_at`.
    chainTx.rows.delete(intentKeys.approve(walletId))
    wallets.byId.set(walletId, { ...wallets.byId.get(walletId)!, readyAt: null })
    // The balance is back to zero, so only the confirmed `gas:` row — not the
    // balance check — can be what stops a second top-up.
    reader.balances.clear()
    sent.length = 0

    const second = await run({ account_id: 'acc_1' })

    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.walletId).toBe(walletId)
    expect(second.created).toBe(false)
    expect(second.steps).toEqual({ gas: 'reused', mint: 'reused', approve: 'sent' })
    // The whole point: no second gas and no second mint.
    expect(sent.map((s) => s.intentKey)).toEqual([intentKeys.approve(walletId)])
    expect(wallets.byId.get(walletId)?.readyAt).toEqual(CONFIRMED_AT)
  })

  it('resumes a crash after the approve was broadcast by re-checking, sending nothing', async () => {
    const { run, chainTx, sent, wallets, reader } = build()

    const first = await run({ account_id: 'acc_1' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const walletId = first.walletId

    // The narrower crash: the hash was recorded, the receipt never read.
    chainTx.rows.set(intentKeys.approve(walletId), {
      ...chainTx.rows.get(intentKeys.approve(walletId))!,
      status: 'pending',
      confirmedAt: null,
    })
    wallets.byId.set(walletId, { ...wallets.byId.get(walletId)!, readyAt: null })
    reader.balances.clear()
    sent.length = 0

    const second = await run({ account_id: 'acc_1' })

    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.steps).toEqual({ gas: 'reused', mint: 'reused', approve: 'reused' })
    expect(sent).toEqual([])
    expect(wallets.byId.get(walletId)?.readyAt).toEqual(CONFIRMED_AT)
  })

  it('generates exactly one key for one account across retries', async () => {
    const { run, signer, wallets } = build()

    const first = await run({ account_id: 'acc_1' })
    const second = await run({ account_id: 'acc_1' })

    expect(first.walletId).toBe(second.walletId)
    expect(wallets.byId.size).toBe(1)
    // `StubSigner` numbers every generated address, so a second key would show.
    expect(wallets.byId.get(first.walletId)?.address).toBe('0x0000000000000000000000000000000000000001')
    expect(signer.sentTransactions).toHaveLength(0)
  })

  it('refuses a demo mint above the contract cap at construction', () => {
    expect(() =>
      createWalletCreationJob({
        signer: new StubSigner(),
        wallets: new InMemoryWalletStore(),
        store: new StubSigningStore(),
        chain: fakeChainWriter(new InMemoryChainTxStore(), []),
        reader: new StubChainReader(),
        calls: stubCalls(),
        config: {
          platformWalletId: 'wal_platform',
          walletGasFloorWei: 1n,
          platformGasFloorWei: 1n,
          demoMintAmount: 1_000_000_001n,
        },
      }),
    ).toThrow('MINT_CAP')
  })
})
