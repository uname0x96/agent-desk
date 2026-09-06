import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import { intentKeys, toBaseUnits } from '@agent-desk/schemas'
import type { RegistryListing } from '@agent-desk/core/ports'
import type { ChainIntent, SentTx, SigningOutcome } from '@agent-desk/core/signing'
import {
  InMemoryChainTxStore,
  InMemoryListingCache,
  StubChainReader,
  fixedClock,
} from '@agent-desk/core/testing'
import { identityRegistryAbi, registryAbi } from './abi.ts'
import type { ContractAddresses } from './clients.ts'
import {
  DEFAULT_STALE_SEND_MS,
  createChainWriter,
  decodeReceipt,
  type RawLog,
  type RawReceipt,
  type ReceiptSource,
} from './writer.ts'

/**
 * AD-8 and AD-2 against a mocked chain. Nothing here reaches BSC testnet: the
 * receipts are hand-built from the real ABIs and the reads come from a stub, so
 * what is proven is this file's own logic — which intent is sent once, which
 * row reaches which status, and which columns a confirmed receipt writes.
 */

const NOW = '2026-09-06T12:00:00.000Z'
const BLOCK_TIME = new Date('2026-09-06T12:00:09.000Z')
const LISTING = 'lst_01JKZ0000000000000000000AA'
const WALLET = 'wal_01JKZ0000000000000000000AA'
const CREATOR = '0x00000000000000000000000000000000000000aa'
const PAY_TO = '0x00000000000000000000000000000000000000bb'

const ADDRESSES: ContractAddresses = {
  tusd: '0x00000000000000000000000000000000000000cc',
  registry: '0x00000000000000000000000000000000000000dd',
  identityRegistry: '0x8004a818bfb912233c491871b3d84c89a494bd9e',
}

// ---------------------------------------------------------------- fake chain

/** Records what it was asked to send and answers with a numbered hash. */
class StubSigning {
  readonly sent: (ChainIntent & { walletId: string })[] = []
  /** Set to refuse the next send the way the AD-5 policy would. */
  refusal: { code: 'refused_balance'; check: 'gas_floor'; message: string; details: Record<string, string> } | null =
    null
  /** Set to throw the way an unreachable RPC would. */
  error: Error | null = null

  async sendTx(walletId: string, intent: ChainIntent): Promise<SigningOutcome<SentTx>> {
    if (this.error) throw this.error
    if (this.refusal) return { ok: false, refusal: this.refusal }
    this.sent.push({ ...intent, walletId })
    return { ok: true, txHash: hashOf(this.sent.length) }
  }
}

/** The receipt half: a test decides which hashes have landed, and when. */
class StubReceipts implements ReceiptSource {
  readonly byHash = new Map<Hex, RawReceipt>()
  readonly waited: Hex[] = []
  readonly looked: Hex[] = []

  async waitFor(txHash: Hex): Promise<RawReceipt | null> {
    this.waited.push(txHash)
    return this.byHash.get(txHash) ?? null
  }

  async get(txHash: Hex): Promise<RawReceipt | null> {
    this.looked.push(txHash)
    return this.byHash.get(txHash) ?? null
  }

  land(txHash: Hex, receipt: Partial<RawReceipt> = {}): RawReceipt {
    const full: RawReceipt = {
      transactionHash: txHash,
      status: 'success',
      blockNumber: 42n,
      timestamp: BLOCK_TIME,
      logs: [],
      ...receipt,
    }
    this.byHash.set(txHash, full)
    return full
  }
}

const hashOf = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

function listedLog(overrides: { listingId?: bigint; agentId?: bigint; address?: string } = {}): RawLog {
  const listingId = overrides.listingId ?? 7n
  const agentId = overrides.agentId ?? 31n
  return {
    address: overrides.address ?? ADDRESSES.registry,
    topics: encodeEventTopics({
      abi: registryAbi,
      eventName: 'Listed',
      args: { listingId, creator: CREATOR, agentId },
    }) as Hex[],
    data: encodeAbiParameters(
      [
        { name: 'agentType', type: 'string' },
        { name: 'price', type: 'uint256' },
        { name: 'endpoint', type: 'string' },
        { name: 'payTo', type: 'address' },
        { name: 'stake', type: 'uint256' },
      ],
      ['data', toBaseUnits('0.01'), 'https://agent.example/run', PAY_TO, toBaseUnits('0.10')],
    ),
  }
}

function registeredLog(agentId = 31n): RawLog {
  return {
    address: ADDRESSES.identityRegistry,
    topics: encodeEventTopics({
      abi: identityRegistryAbi,
      eventName: 'Registered',
      args: { agentId, owner: CREATOR },
    }) as Hex[],
    data: encodeAbiParameters([{ name: 'agentURI', type: 'string' }], ['https://agentdesk.example/a.json']),
  }
}

function slashedLog(amount: bigint, callRef: Hex): RawLog {
  return {
    address: ADDRESSES.registry,
    topics: encodeEventTopics({
      abi: registryAbi,
      eventName: 'Slashed',
      args: { listingId: 7n, callRef },
    }) as Hex[],
    data: encodeAbiParameters([{ name: 'amount', type: 'uint256' }], [amount]),
  }
}

function onChainListing(overrides: Partial<RegistryListing> = {}): RegistryListing {
  return {
    creator: CREATOR,
    payTo: PAY_TO,
    agentId: 31n,
    agentType: 'data',
    endpoint: 'https://agent.example/run',
    price: toBaseUnits('0.01'),
    stake: toBaseUnits('0.10'),
    reputationBps: 9_000,
    pausedByCreator: false,
    pausedByStake: false,
    ...overrides,
  }
}

function build(options: { staleSendAfterMs?: number } = {}) {
  const clock = fixedClock(NOW)
  const store = new InMemoryChainTxStore(clock)
  const listings = new InMemoryListingCache()
  const reader = new StubChainReader()
  const signing = new StubSigning()
  const receipts = new StubReceipts()
  const writer = createChainWriter({
    store,
    listings,
    reader,
    signing,
    receipts,
    addresses: ADDRESSES,
    clock,
    ...(options.staleSendAfterMs === undefined ? {} : { staleSendAfterMs: options.staleSendAfterMs }),
  })
  listings.seed({
    id: LISTING,
    creatorAccountId: 'acc_1',
    type: 'data',
    agentId: null,
    registryListingId: null,
    price: null,
    stake: null,
  })
  reader.listings.set('7', onChainListing())
  return { writer, store, listings, reader, signing, receipts, clock }
}

const request = (overrides: Record<string, unknown> = {}) => ({
  walletId: WALLET,
  to: ADDRESSES.registry,
  data: '0xdeadbeef' as Hex,
  payload: { listing_id: LISTING },
  ...overrides,
})

// ------------------------------------------------------------------- tests

describe('chainWrite', () => {
  it('inserts the pending row with its payload before anything is signed', async () => {
    const { writer, store, signing } = build()
    const key = intentKeys.list(LISTING)
    let rowAtBuildTime: unknown = 'buildTx was never called'

    signing.refusal = {
      code: 'refused_balance',
      check: 'gas_floor',
      message: 'wallet below the BNB floor',
      details: {},
    }
    await writer.chainWrite(key, async () => {
      rowAtBuildTime = await store.find(key)
      return request()
    })

    // The row did not exist while the transaction was being built...
    expect(rowAtBuildTime).toBeNull()
    // ...and existed, pending, with its payload, before the send was attempted.
    expect(store.inserts).toEqual([key])
    expect(store.rows.get(key)).toMatchObject({
      status: 'pending',
      txHash: null,
      payload: { listing_id: LISTING },
    })
  })

  it('confirms a send and records the hash and the block timestamp', async () => {
    const { writer, store, signing, receipts } = build()
    receipts.land(hashOf(1), { logs: [listedLog()] })

    const result = await writer.chainWrite(intentKeys.list(LISTING), () => request())

    expect(result.reused).toBe(false)
    expect(result.record.status).toBe('confirmed')
    expect(result.record.txHash).toBe(hashOf(1))
    expect(result.record.confirmedAt).toEqual(BLOCK_TIME)
    expect(store.settlements).toEqual([{ intentKey: intentKeys.list(LISTING), status: 'confirmed' }])
    expect(signing.sent).toHaveLength(1)
  })

  it('sends nothing on a second call with the same intent key', async () => {
    const { writer, signing, receipts } = build()
    const key = intentKeys.list(LISTING)
    receipts.land(hashOf(1), { logs: [listedLog()] })

    await writer.chainWrite(key, () => request())
    let built = false
    const second = await writer.chainWrite(key, () => {
      built = true
      return request()
    })

    expect(built).toBe(false)
    expect(second.reused).toBe(true)
    expect(second.record.status).toBe('confirmed')
    expect(signing.sent).toHaveLength(1)
  })

  it('leaves the row pending when no receipt arrives inside the wait', async () => {
    const { writer, store } = build()
    const key = intentKeys.list(LISTING)

    const result = await writer.chainWrite(key, () => request())

    expect(result.record.status).toBe('pending')
    expect(result.record.txHash).toBe(hashOf(1))
    expect(store.settlements).toEqual([])
  })

  it('re-checks the receipt of a hash it already recorded and sends nothing', async () => {
    const { writer, store, signing, receipts } = build()
    const key = intentKeys.list(LISTING)

    // First pass: broadcast, no receipt inside the window.
    await writer.chainWrite(key, () => request())
    expect(store.rows.get(key)?.status).toBe('pending')

    // The transaction landed between the two calls.
    receipts.land(hashOf(1), { logs: [listedLog()] })
    const second = await writer.chainWrite(key, () => request())

    expect(signing.sent).toHaveLength(1)
    expect(receipts.looked).toEqual([hashOf(1)])
    expect(second.reused).toBe(true)
    expect(second.record.status).toBe('confirmed')
    expect(second.record.confirmedAt).toEqual(BLOCK_TIME)
  })

  it('writes listings.last_error when the transaction reverts', async () => {
    const { writer, listings, receipts } = build()
    const key = intentKeys.stake(LISTING, 1)
    receipts.land(hashOf(1), { status: 'reverted' })

    const result = await writer.chainWrite(key, () => request())

    expect(result.record.status).toBe('reverted')
    expect(listings.lastErrors).toHaveLength(1)
    expect(listings.lastErrors[0]?.listingId).toBe(LISTING)
    expect(listings.lastErrors[0]?.lastError).toContain('reverted on chain')
    // A reverted write must never touch the chain-owned columns.
    expect(listings.chainOwnedWrites).toHaveLength(0)
  })

  it('marks the row failed and records why when the send throws', async () => {
    const { writer, store, listings, signing } = build()
    const key = intentKeys.price(LISTING, 2)
    signing.error = new Error('all RPC endpoints failed')

    const result = await writer.chainWrite(key, () => request())

    expect(result.record.status).toBe('failed')
    expect(store.rows.get(key)?.status).toBe('failed')
    expect(store.rows.get(key)?.txHash).toBeNull()
    expect(listings.lastErrors[0]?.lastError).toContain('all RPC endpoints failed')
  })

  it('leaves the row pending on a policy refusal and returns the refusal', async () => {
    const { writer, store, listings, signing } = build()
    const key = intentKeys.price(LISTING, 3)
    signing.refusal = {
      code: 'refused_balance',
      check: 'gas_floor',
      message: 'wallet holds 0.001 BNB, below the 0.02 BNB floor',
      details: { shortfall_wei: '19000000000000000' },
    }

    const result = await writer.chainWrite(key, () => request())

    expect(result.refusal?.code).toBe('refused_balance')
    // Nothing was signed, so the intent key must stay usable.
    expect(store.rows.get(key)?.status).toBe('pending')
    expect(store.settlements).toEqual([])
    expect(listings.lastErrors[0]?.lastError).toContain('below the 0.02 BNB floor')
  })

  it('does not re-send a young pending row that has no hash', async () => {
    const { writer, store, signing } = build()
    const key = intentKeys.list(LISTING)
    store.seed({ intentKey: key })

    const result = await writer.chainWrite(key, () => request())

    expect(signing.sent).toHaveLength(0)
    expect(result.reused).toBe(true)
    expect(result.record.status).toBe('pending')
  })

  it('rebuilds and sends once a hashless pending row is past the stale window', async () => {
    const { writer, store, signing, clock, receipts } = build({ staleSendAfterMs: DEFAULT_STALE_SEND_MS })
    const key = intentKeys.list(LISTING)
    store.seed({ intentKey: key })
    // The process that inserted the row died before it broadcast anything.
    clock.set('2026-09-06T12:03:00.000Z')
    receipts.land(hashOf(1), { logs: [listedLog()] })

    const result = await writer.chainWrite(key, () => request())

    expect(signing.sent).toHaveLength(1)
    expect(result.record.status).toBe('confirmed')
  })

  it('passes the value, the gas floor, and the stake check through to the signer', async () => {
    const { writer, signing } = build()

    await writer.chainWrite(
      intentKeys.stake(LISTING, 1),
      () =>
        request({
          value: 5n,
          gasFloorWei: 7n,
          stakeCheck: { price: toBaseUnits('0.01'), stake: toBaseUnits('0.10') },
        }),
    )

    expect(signing.sent[0]).toMatchObject({
      walletId: WALLET,
      intentKey: intentKeys.stake(LISTING, 1),
      value: 5n,
      gasFloorWei: 7n,
      stakeCheck: { price: 10_000n, stake: 100_000n },
    })
  })

  it('neither refreshes nor records an error for an intent that names no Listing', async () => {
    const { writer, listings, reader, receipts } = build()
    receipts.land(hashOf(1), { status: 'reverted' })

    await writer.chainWrite(intentKeys.gas(WALLET), () => request())

    expect(listings.lastErrors).toEqual([])
    expect(listings.chainOwnedWrites).toEqual([])
    expect(reader.getListingCalls).toEqual([])
  })
})

describe('refreshListingFromChain', () => {
  it('maps every chain-owned column from getListing', async () => {
    const { writer, listings, reader, receipts } = build()
    receipts.land(hashOf(1), { logs: [registeredLog(), listedLog()] })

    await writer.chainWrite(intentKeys.list(LISTING), () => request())

    expect(reader.getListingCalls).toEqual(['7'])
    expect(listings.chainOwnedWrites).toHaveLength(1)
    expect(listings.chainOwnedWrites[0]).toEqual({
      listingId: LISTING,
      columns: {
        price: '10000',
        stake: '100000',
        reputationBps: 9_000,
        pausedByCreator: false,
        pausedByStake: false,
        payoutWallet: PAY_TO,
        endpoint: 'https://agent.example/run',
        agentId: '31',
        registryListingId: '7',
      },
    })
  })

  it('lower-cases the payout wallet the node returns checksummed (AD-13)', async () => {
    const { writer, listings, reader, receipts } = build()
    reader.listings.set('7', onChainListing({ payTo: '0x00000000000000000000000000000000000000BB' }))
    receipts.land(hashOf(1), { logs: [listedLog()] })

    await writer.chainWrite(intentKeys.list(LISTING), () => request())

    expect(listings.chainOwnedWrites[0]?.columns.payoutWallet).toBe(PAY_TO)
  })

  it('takes the Registry id from the receipt when the cache has none yet', async () => {
    const { writer, listings, receipts } = build()
    receipts.land(hashOf(1), { logs: [listedLog({ listingId: 7n })] })

    // The cached row starts with `registry_listing_id` null; only the `Listed`
    // event in this receipt can supply it.
    expect(listings.rows.get(LISTING)?.registryListingId).toBeNull()
    await writer.chainWrite(intentKeys.list(LISTING), () => request())
    expect(listings.rows.get(LISTING)?.registryListingId).toBe('7')
  })

  it('writes nothing for an identity receipt that arrives before the Registry entry', async () => {
    const { writer, listings, reader, receipts } = build()
    receipts.land(hashOf(1), { logs: [registeredLog(31n)] })

    const result = await writer.chainWrite(intentKeys.identity(LISTING), () => request())

    expect(result.record.status).toBe('confirmed')
    expect(listings.chainOwnedWrites).toEqual([])
    expect(reader.getListingCalls).toEqual([])
    expect(await writer.refreshListingFromChain(LISTING)).toEqual({
      refreshed: false,
      reason: 'no_registry_listing_id',
    })
  })

  it('reports a Listing that is not in the cache instead of writing one', async () => {
    const { writer, listings } = build()
    expect(await writer.refreshListingFromChain('lst_missing')).toEqual({
      refreshed: false,
      reason: 'listing_not_found',
    })
    expect(listings.chainOwnedWrites).toEqual([])
  })

  it('reads the Registry again on a manual refresh with no hints', async () => {
    const { writer, listings, reader } = build()
    listings.seed({
      id: LISTING,
      creatorAccountId: 'acc_1',
      type: 'data',
      agentId: '31',
      registryListingId: '7',
      price: '10000',
      stake: '100000',
    })
    reader.listings.set('7', onChainListing({ price: toBaseUnits('0.02'), pausedByStake: true, reputationBps: 4_200 }))

    const result = await writer.refreshListingFromChain(LISTING)

    expect(result).toEqual({ refreshed: true, registryListingId: '7' })
    expect(listings.chainOwnedWrites[0]?.columns).toMatchObject({
      price: '20000',
      pausedByStake: true,
      reputationBps: 4_200,
    })
  })
})

describe('decodeReceipt', () => {
  const receipt = (logs: RawLog[]): RawReceipt => ({
    transactionHash: hashOf(1),
    status: 'success',
    blockNumber: 42n,
    timestamp: BLOCK_TIME,
    logs,
  })

  it('decodes Listed, Registered, and Slashed', () => {
    const callRef = `0x${'ab'.repeat(32)}` as Hex
    const decoded = decodeReceipt(
      receipt([registeredLog(31n), listedLog(), slashedLog(toBaseUnits('0.05'), callRef)]),
      ADDRESSES,
    )

    expect(decoded.registered).toEqual({
      agentId: '31',
      agentURI: 'https://agentdesk.example/a.json',
      owner: CREATOR,
    })
    expect(decoded.listed).toEqual({
      registryListingId: '7',
      agentId: '31',
      price: '10000',
      stake: '100000',
    })
    expect(decoded.slashed).toEqual({ registryListingId: '7', callRef, amount: '50000' })
  })

  it('ignores a Listed log emitted by any other contract', () => {
    const decoded = decodeReceipt(
      receipt([listedLog({ address: '0x00000000000000000000000000000000000000ff' })]),
      ADDRESSES,
    )
    expect(decoded.listed).toBeUndefined()
  })

  it('ignores a log neither ABI describes', () => {
    const transfer: RawLog = {
      address: ADDRESSES.registry,
      topics: [`0x${'01'.repeat(32)}` as Hex],
      data: '0x',
    }
    const decoded = decodeReceipt(receipt([transfer]), ADDRESSES)
    expect(decoded.listed).toBeUndefined()
    expect(decoded.slashed).toBeUndefined()
    expect(decoded.registered).toBeUndefined()
  })

  it('carries the hash, the status, and the block through unchanged', () => {
    const decoded = decodeReceipt({ ...receipt([]), status: 'reverted' }, ADDRESSES)
    expect(decoded).toEqual({
      txHash: hashOf(1),
      status: 'reverted',
      blockNumber: 42n,
      timestamp: BLOCK_TIME,
    })
  })
})
