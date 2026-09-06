import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeFunctionData, getAddress, type Hex } from 'viem'
import { intentKeys } from '@agent-desk/schemas'
import type { SendRawTxRequest, Signer, WalletRecord } from '@agent-desk/core/ports'
import {
  MAX_UINT256,
  bnbToWei,
  createSigningService,
  createWalletCreationJob,
} from '@agent-desk/core/signing'
import {
  InMemoryChainTxStore,
  InMemoryListingCache,
  InMemoryWalletStore,
  StubChainReader,
  StubPaymentSigner,
  StubSigningStore,
  fixedClock,
} from '@agent-desk/core/testing'
import { createSigner } from '../signer/index.ts'
import { tusdAbi } from './abi.ts'
import { createContractCalls } from './calls.ts'
import type { ContractAddresses } from './clients.ts'
import { createChainWriter, type RawReceipt, type ReceiptSource } from './writer.ts'

/**
 * `wallet.create` with every real part wired together: the real AES-256-GCM
 * signer, the real ABI encoder, the real `chainWrite`, and the real signing
 * policy. Only two things are mocked, and both are the chain itself —
 * `sendRawTx` returns a hash instead of broadcasting, and the receipt source
 * answers instead of a node. Nothing here shows a transaction would be accepted
 * by BSC testnet; it shows this system builds, orders, and resumes them.
 */

const MASTER = randomBytes(32).toString('hex')
const ADDRESSES: ContractAddresses = {
  tusd: '0x00000000000000000000000000000000000000cc',
  registry: '0x00000000000000000000000000000000000000dd',
  identityRegistry: '0x8004a818bfb912233c491871b3d84c89a494bd9e',
}
const NOW = '2026-09-06T12:00:00.000Z'
const BLOCK_TIME = new Date('2026-09-06T12:00:09.000Z')

/**
 * Real crypto, no node: the broadcast is the only thing replaced. A value
 * transfer credits the recipient in the stub reader, because the second and
 * third steps are signed by the wallet the first step funds and would otherwise
 * be refused by the gas floor for a balance the chain would have.
 */
function mockedBroadcastSigner(reader: StubChainReader) {
  const real = createSigner({ masterKey: MASTER, chainId: 97, rpcUrls: ['http://127.0.0.1:8545'] })
  const broadcast: SendRawTxRequest[] = []
  const signer: Signer = {
    generateKey: () => real.generateKey(),
    decryptKey: (encryptedKey) => real.decryptKey(encryptedKey),
    signTypedData: (request) => real.signTypedData(request),
    async sendRawTx(request) {
      broadcast.push(request)
      if (request.value) {
        const to = request.to.toLowerCase()
        reader.balances.set(to, (reader.balances.get(to) ?? 0n) + request.value)
      }
      return `0x${broadcast.length.toString(16).padStart(64, '0')}` as Hex
    },
  }
  return { signer, broadcast }
}

/** Every hash lands in the next block, unless a test says otherwise. */
class LandsEverything implements ReceiptSource {
  missing = new Set<Hex>()

  private receipt(txHash: Hex): RawReceipt | null {
    if (this.missing.has(txHash)) return null
    return { transactionHash: txHash, status: 'success', blockNumber: 42n, timestamp: BLOCK_TIME, logs: [] }
  }

  async waitFor(txHash: Hex) {
    return this.receipt(txHash)
  }

  async get(txHash: Hex) {
    return this.receipt(txHash)
  }
}

/**
 * One wallet table behind both ports. In production `packages/db` is that
 * table; here the two in-memory stores are kept in step so the signing service
 * can find a wallet the job has just inserted.
 */
class LinkedWallets extends InMemoryWalletStore {
  readonly signing: StubSigningStore

  constructor(signing: StubSigningStore) {
    super()
    this.signing = signing
  }

  override async insert(wallet: Parameters<InMemoryWalletStore['insert']>[0]): Promise<WalletRecord> {
    const record = await super.insert(wallet)
    this.signing.seedWallet(record)
    return record
  }
}

async function build(options: { mode?: 'demo' | 'production'; platformBalance?: string } = {}) {
  const clock = fixedClock(NOW)
  const reader = new StubChainReader()
  const { signer, broadcast } = mockedBroadcastSigner(reader)
  const chainTx = new InMemoryChainTxStore(clock)
  const listings = new InMemoryListingCache()
  const receipts = new LandsEverything()
  const store = new StubSigningStore({ settings: { mode: options.mode ?? 'demo' } })
  const wallets = new LinkedWallets(store)

  const platformKey = await signer.generateKey()
  const platform: WalletRecord = {
    id: 'wal_platform',
    accountId: 'acc_platform',
    address: platformKey.address,
    encryptedKey: platformKey.encryptedKey,
    readyAt: new Date(NOW),
  }
  wallets.seed(platform)
  store.seedWallet(platform)
  reader.balances.set(platform.address, bnbToWei(options.platformBalance ?? '1'))

  const signing = createSigningService({
    signer,
    payments: new StubPaymentSigner(),
    store,
    chain: reader,
    clock,
    gasFloorWei: bnbToWei('0.02'),
  })
  const writer = createChainWriter({
    store: chainTx,
    listings,
    reader,
    signing,
    receipts,
    addresses: ADDRESSES,
    clock,
  })
  const run = createWalletCreationJob({
    signer,
    wallets,
    store,
    chain: writer,
    reader,
    calls: createContractCalls(ADDRESSES),
    clock,
    config: {
      platformWalletId: platform.id,
      walletGasFloorWei: bnbToWei('0.005'),
      platformGasFloorWei: bnbToWei('0.05'),
      demoMintAmount: 100_000_000n,
    },
  })

  return { run, broadcast, chainTx, reader, wallets, store, receipts, platform, signing }
}

describe('wallet.create end to end', () => {
  it('sends three real transactions in order and marks the wallet ready', async () => {
    const { run, broadcast, chainTx, wallets, platform } = await build()

    const result = await run({ account_id: 'acc_1' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.steps).toEqual({ gas: 'sent', mint: 'sent', approve: 'sent' })
    expect(result.readyAt).toEqual(BLOCK_TIME)
    expect(wallets.byId.get(result.walletId)?.readyAt).toEqual(BLOCK_TIME)

    // 1. BNB from the Platform Wallet, no calldata.
    expect(broadcast[0]).toMatchObject({
      encryptedKey: platform.encryptedKey,
      to: result.address,
      data: '0x',
      value: bnbToWei('0.005'),
    })
    // 2. mint(newWallet, 100 tUSD), signed by the new wallet.
    expect(broadcast[1]?.to).toBe(ADDRESSES.tusd)
    expect(decodeFunctionData({ abi: tusdAbi, data: broadcast[1]!.data })).toMatchObject({
      functionName: 'mint',
      args: [getAddress(result.address), 100_000_000n],
    })
    // 3. approve(registry, max), whose receipt is what set `ready_at`.
    expect(decodeFunctionData({ abi: tusdAbi, data: broadcast[2]!.data })).toMatchObject({
      functionName: 'approve',
      args: [getAddress(ADDRESSES.registry), MAX_UINT256],
    })

    for (const key of [intentKeys.gas, intentKeys.mint, intentKeys.approve]) {
      expect(chainTx.rows.get(key(result.walletId))?.status).toBe('confirmed')
    }
  })

  it('signs steps 2 and 3 with the wallet it just created, not the Platform Wallet', async () => {
    const { run, broadcast, wallets, platform } = await build()

    const result = await run({ account_id: 'acc_1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const walletKey = wallets.byId.get(result.walletId)?.encryptedKey
    expect(broadcast[0]?.encryptedKey).toBe(platform.encryptedKey)
    expect(broadcast[1]?.encryptedKey).toBe(walletKey)
    expect(broadcast[2]?.encryptedKey).toBe(walletKey)
    expect(walletKey).not.toBe(platform.encryptedKey)
  })

  it('resumes after a crash with no second gas and no second mint', async () => {
    const { run, broadcast, chainTx, wallets, reader } = await build()

    const first = await run({ account_id: 'acc_1' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const walletId = first.walletId
    expect(broadcast).toHaveLength(3)

    // The crash: `gas:` and `mint:` are confirmed, the process died before it
    // ever built `approve:`, and `ready_at` was never written.
    chainTx.rows.delete(intentKeys.approve(walletId))
    wallets.byId.set(walletId, { ...wallets.byId.get(walletId)!, readyAt: null })
    // The wallet keeps exactly the floor it was funded to, so nothing but the
    // confirmed `gas:` row can be what stops a second top-up.
    expect(reader.balances.get(first.address)).toBe(bnbToWei('0.005'))
    broadcast.length = 0

    const second = await run({ account_id: 'acc_1' })

    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.walletId).toBe(walletId)
    expect(second.created).toBe(false)
    expect(second.steps).toEqual({ gas: 'reused', mint: 'reused', approve: 'sent' })
    expect(broadcast).toHaveLength(1)
    expect(decodeFunctionData({ abi: tusdAbi, data: broadcast[0]!.data }).functionName).toBe('approve')
    expect(wallets.byId.get(walletId)?.readyAt).toEqual(BLOCK_TIME)
  })

  it('resumes a broadcast whose receipt was never read by re-checking it', async () => {
    const { run, broadcast, chainTx, wallets, receipts } = await build()

    // The narrower crash: `approve:` was broadcast, the receipt never arrived.
    const approveHash = `0x${(3).toString(16).padStart(64, '0')}` as Hex
    receipts.missing.add(approveHash)
    const first = await run({ account_id: 'acc_1' })
    expect(first.ok).toBe(false)
    if (first.ok) return
    expect(first.failedAt).toBe('approve')
    const walletId = first.walletId
    expect(chainTx.rows.get(intentKeys.approve(walletId))).toMatchObject({
      status: 'pending',
      txHash: approveHash,
    })

    // The transaction lands between the two runs.
    receipts.missing.clear()
    broadcast.length = 0
    const second = await run({ account_id: 'acc_1' })

    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.steps).toEqual({ gas: 'reused', mint: 'reused', approve: 'reused' })
    expect(broadcast).toEqual([])
    expect(wallets.byId.get(walletId)?.readyAt).toEqual(BLOCK_TIME)
  })

  it('refuses at the gas step when the Platform Wallet is under its floor', async () => {
    const { run, broadcast, chainTx } = await build({ platformBalance: '0.04' })

    const result = await run({ account_id: 'acc_1' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failedAt).toBe('gas')
    expect(result.refusal?.code).toBe('refused_balance')
    expect(broadcast).toEqual([])
    // AD-8: nothing was signed, so the intent key stays usable once the
    // Platform Wallet is topped up.
    expect(chainTx.rows.get(intentKeys.gas(result.walletId))?.status).toBe('pending')
  })

  it('skips the mint outside demo mode', async () => {
    const { run, broadcast, chainTx } = await build({ mode: 'production' })

    const result = await run({ account_id: 'acc_1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.steps.mint).toBe('skipped')
    expect(broadcast).toHaveLength(2)
    expect(chainTx.rows.has(intentKeys.mint(result.walletId))).toBe(false)
  })

  it('generates one key per account, whatever the job is redelivered', async () => {
    const { run, wallets } = await build()

    const first = await run({ account_id: 'acc_1' })
    const second = await run({ account_id: 'acc_1' })
    const other = await run({ account_id: 'acc_2' })

    expect(first.walletId).toBe(second.walletId)
    expect(other.walletId).not.toBe(first.walletId)
    // Two accounts, two wallets, plus the Platform Wallet that was seeded.
    expect(wallets.byId.size).toBe(3)
  })
})
