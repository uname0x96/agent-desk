import {
  encodeAbiParameters,
  encodeEventTopics,
  parseEther,
  type Abi,
  type AbiEvent,
  type AbiParameter,
} from 'viem'
import {
  createChainWriter,
  identityRegistryAbi,
  registryAbi,
  type ContractAddresses,
  type RawLog,
  type RawReceipt,
  type ReceiptSource,
} from '@agent-desk/adapters/chain'
import { bnbToWei, createSigningService } from '@agent-desk/core/signing'
import {
  InMemoryChainTxStore,
  StubChainReader,
  StubPaymentSigner,
  StubSigner,
  StubSigningStore,
} from '@agent-desk/core/testing'
import type {
  ChainOwnedListingColumns,
  Hex,
  ListingCacheRow,
  ListingCacheStore,
} from '@agent-desk/core/ports'
import type {
  CreatorWallet,
  ListingPipelineRow,
  ListingPipelineStore,
} from '@agent-desk/core/listing'
import type { AgentType, ListingStatus } from '@agent-desk/schemas'
import type { Engine } from '@agent-desk/scripts/wiring'
import type { ListingWriteRow, ListingWriteStore } from './write-ports.ts'

/**
 * The worker's listing wiring, with the chain replaced and nothing else.
 *
 * `chainWrite` here is the real `createChainWriter` — the same AD-8 code the
 * worker runs — over the in-memory `chain_tx` store and listings cache from
 * `@agent-desk/core/testing`, and the real `createSigningService` over
 * `StubSigner`. What is faked is the RPC: transactions are accepted without
 * being broadcast and receipts are handed out on demand, with their logs encoded
 * from the real ABIs so `decodeReceipt` is exercised for real.
 *
 * That matters for what the tests can claim. Idempotence, the intent-first
 * ordering, the frozen `agentURI`, and the revert path are properties of this
 * code and are proven. Whether `AgentDeskRegistry.list` accepts the calldata is
 * a property of the contracts, and no fake can answer it.
 */

/** Deliberately not `addressesFor(97)`: the tests must not move with the deployments file. */
export const TEST_ADDRESSES: ContractAddresses = {
  tusd: '0x0000000000000000000000000000000000000a01',
  registry: '0x0000000000000000000000000000000000000a02',
  identityRegistry: '0x0000000000000000000000000000000000000a03',
}

export const CREATOR_ACCOUNT_ID = 'acc_CREATOR'
export const CREATOR_WALLET_ID = 'wal_CREATOR'
export const CREATOR_ADDRESS = '0x00000000000000000000000000000000000000c1'
export const PAYOUT_WALLET = '0x00000000000000000000000000000000000000b2'

// ------------------------------------------------------------- listings table

/** Every column the two stores share, as one row, the way Postgres holds it. */
export interface FakeListingRow extends ListingPipelineRow {
  lastError: string | null
  price: string | null
  stake: string | null
  reputationBps: number | null
  pausedByCreator: boolean
  pausedByStake: boolean
}

/**
 * One `listings` table behind both ports.
 *
 * AD-2 splits the writers, not the table: `refreshListingFromChain` owns the
 * nine chain-owned columns through {@link ListingCacheStore}, and the pipeline
 * owns `status` and `last_error` through {@link ListingPipelineStore}. Backing
 * them with two objects would let a test pass while the real code wrote to two
 * different rows.
 */
export class FakeListingTable {
  readonly rows = new Map<string, FakeListingRow>()
  readonly chainOwnedWrites: { listingId: string; columns: ChainOwnedListingColumns }[] = []
  readonly statusWrites: { listingId: string; status: ListingStatus; lastError: string | null }[] = []
  wallet: CreatorWallet | null = {
    id: CREATOR_WALLET_ID,
    address: CREATOR_ADDRESS,
    readyAt: new Date('2026-09-06T09:00:00Z'),
  }

  seed(overrides: Partial<FakeListingRow> = {}): FakeListingRow {
    const row: FakeListingRow = {
      id: 'lst_SEED',
      creatorAccountId: CREATOR_ACCOUNT_ID,
      name: 'Binance Ticker',
      description: 'BNBUSDT last price and 24h change.',
      type: 'data' as AgentType,
      endpoint: 'http://agent-binance-ticker:4101/',
      declaredPrice: '10000',
      declaredStake: '100000',
      payoutWallet: PAYOUT_WALLET,
      status: 'verifying',
      skipVerification: true,
      agentId: null,
      registryListingId: null,
      lastError: null,
      price: null,
      stake: null,
      reputationBps: null,
      pausedByCreator: false,
      pausedByStake: false,
      ...overrides,
    }
    this.rows.set(row.id, row)
    return row
  }

  get(listingId: string): FakeListingRow {
    const row = this.rows.get(listingId)
    if (!row) throw new Error(`no listing ${listingId}`)
    return row
  }

  /** The AD-2 cache half: `refreshListingFromChain` writes through this. */
  cacheStore(): ListingCacheStore {
    return {
      read: async (listingId): Promise<ListingCacheRow | null> => {
        const row = this.rows.get(listingId)
        if (!row) return null
        return {
          id: row.id,
          creatorAccountId: row.creatorAccountId,
          type: row.type,
          agentId: row.agentId,
          registryListingId: row.registryListingId,
          price: row.price,
          stake: row.stake,
        }
      },
      writeChainOwned: async (listingId, columns) => {
        this.chainOwnedWrites.push({ listingId, columns })
        const row = this.get(listingId)
        this.rows.set(listingId, {
          ...row,
          price: columns.price,
          stake: columns.stake,
          reputationBps: columns.reputationBps,
          pausedByCreator: columns.pausedByCreator,
          pausedByStake: columns.pausedByStake,
          payoutWallet: columns.payoutWallet,
          endpoint: columns.endpoint,
          agentId: columns.agentId,
          registryListingId: columns.registryListingId,
        })
      },
      writeLastError: async (listingId, lastError) => {
        this.rows.set(listingId, { ...this.get(listingId), lastError })
      },
    }
  }

  /**
   * Story 3.6's half: the same two pipeline columns, reached through the
   * `listing.write` port. `read` hands over the chain-owned columns as well,
   * because the ten-times minimum is checked against them — and never lets them
   * be written, which is the AD-2 line this port draws.
   */
  writeStore(): ListingWriteStore {
    return {
      read: async (listingId): Promise<ListingWriteRow | null> => {
        const row = this.rows.get(listingId)
        if (!row) return null
        return {
          id: row.id,
          creatorAccountId: row.creatorAccountId,
          status: row.status,
          registryListingId: row.registryListingId,
          price: row.price,
          stake: row.stake,
          pausedByCreator: row.pausedByCreator,
          pausedByStake: row.pausedByStake,
        }
      },
      creatorWallet: async () => this.wallet,
      patch: async (listingId, patch) => {
        const row = this.get(listingId)
        const next: FakeListingRow = {
          ...row,
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.lastError === undefined ? {} : { lastError: patch.lastError }),
        }
        this.rows.set(listingId, next)
        this.statusWrites.push({ listingId, status: next.status, lastError: next.lastError })
      },
    }
  }

  /** The pipeline half: `status` and `last_error`, and nothing else. */
  pipelineStore(): ListingPipelineStore {
    return {
      read: async (listingId) => this.rows.get(listingId) ?? null,
      creatorWallet: async () => this.wallet,
      writeStatus: async (listingId, status, lastError) => {
        this.statusWrites.push({ listingId, status, lastError })
        this.rows.set(listingId, { ...this.get(listingId), status, lastError })
      },
    }
  }
}

// ------------------------------------------------------------------- receipts

export interface ReceiptSpec {
  status?: 'success' | 'reverted'
  registered?: { agentId: bigint; agentURI: string; owner: string }
  listed?: {
    listingId: bigint
    creator: string
    agentId: bigint
    agentType: string
    price: bigint
    endpoint: string
    payTo: string
    stake: bigint
  }
}

/**
 * A receipt for each transaction, in the order they are sent.
 *
 * `waitFor` takes the next queued spec and stamps it with the hash the signer
 * produced; an empty queue is the 60 s wait running out, which leaves the
 * `chain_tx` row `pending` with its hash. `settleLate` is what a node that
 * answered a moment later would have said, and it is only ever read through
 * `get`, which is the re-check path.
 */
export class FakeReceipts implements ReceiptSource {
  private readonly queue: ReceiptSpec[] = []
  private readonly byHash = new Map<string, RawReceipt>()
  readonly waited: Hex[] = []
  readonly fetched: Hex[] = []
  private block = 1n

  expect(...specs: ReceiptSpec[]): this {
    this.queue.push(...specs)
    return this
  }

  /** Publishes a receipt for a hash whose wait already ran out. */
  settleLate(txHash: Hex, spec: ReceiptSpec): void {
    this.byHash.set(txHash.toLowerCase(), this.build(txHash, spec))
  }

  async waitFor(txHash: Hex): Promise<RawReceipt | null> {
    this.waited.push(txHash)
    const spec = this.queue.shift()
    if (!spec) return null
    const receipt = this.build(txHash, spec)
    this.byHash.set(txHash.toLowerCase(), receipt)
    return receipt
  }

  async get(txHash: Hex): Promise<RawReceipt | null> {
    this.fetched.push(txHash)
    return this.byHash.get(txHash.toLowerCase()) ?? null
  }

  private build(txHash: Hex, spec: ReceiptSpec): RawReceipt {
    const logs: RawLog[] = []
    if (spec.registered) {
      logs.push(log(TEST_ADDRESSES.identityRegistry, identityRegistryAbi, 'Registered', spec.registered))
    }
    if (spec.listed) {
      logs.push(log(TEST_ADDRESSES.registry, registryAbi, 'Listed', spec.listed))
    }
    this.block += 1n
    return {
      transactionHash: txHash,
      status: spec.status ?? 'success',
      blockNumber: this.block,
      timestamp: new Date(Number(this.block) * 1000),
      logs,
    }
  }
}

/**
 * Encoded from the exported ABI, so `decodeReceipt` does real work in the tests
 * and a change to an event signature breaks them. viem 2.56.3 exports the two
 * halves of a log but not the whole, so indexed arguments become topics here and
 * the rest becomes the data, which is exactly the split the ABI declares.
 */
function log(address: string, abi: Abi, eventName: string, args: Record<string, unknown>): RawLog {
  const event = abi.find(
    (item): item is AbiEvent => item.type === 'event' && item.name === eventName,
  )
  if (!event) throw new Error(`no ${eventName} event in this ABI`)

  const topics = encodeEventTopics({ abi, eventName, args } as Parameters<
    typeof encodeEventTopics
  >[0]) as readonly Hex[]

  const unindexed = event.inputs.filter((input) => !input.indexed) as AbiParameter[]
  const data =
    unindexed.length === 0
      ? ('0x' as Hex)
      : encodeAbiParameters(
          unindexed,
          unindexed.map((input) => args[input.name ?? '']),
        )

  return { address, topics, data }
}

// --------------------------------------------------------------------- engine

export interface Harness {
  engine: Engine
  table: FakeListingTable
  chainTx: InMemoryChainTxStore
  receipts: FakeReceipts
  reader: StubChainReader
  signer: StubSigner
}

/**
 * The same four things `createEngine` builds, with the RPC replaced. The
 * pipeline is handed `engine.chain` and `engine.addresses` exactly as
 * `registerListingJobs` hands them over in the worker.
 */
export function createHarness(options: { tusdBalance?: bigint } = {}): Harness {
  const table = new FakeListingTable()
  const chainTx = new InMemoryChainTxStore()
  const receipts = new FakeReceipts()

  const signer = new StubSigner()
  const reader = new StubChainReader()
  reader.balances.set(CREATOR_ADDRESS, parseEther('1'))
  reader.tokens.set(CREATOR_ADDRESS, options.tusdBalance ?? 10_000_000n)

  const signingStore = new StubSigningStore()
  signingStore.seedWallet({
    id: CREATOR_WALLET_ID,
    accountId: CREATOR_ACCOUNT_ID,
    address: CREATOR_ADDRESS,
    encryptedKey: `enc:${CREATOR_ADDRESS}`,
    readyAt: new Date('2026-09-06T09:00:00Z'),
  })

  const signing = createSigningService({
    signer,
    payments: new StubPaymentSigner(),
    store: signingStore,
    chain: reader,
    gasFloorWei: bnbToWei('0.01'),
  })

  const chain = createChainWriter({
    store: chainTx,
    listings: table.cacheStore(),
    reader,
    signing,
    receipts,
    addresses: TEST_ADDRESSES,
  })

  const engine: Engine = {
    signing,
    chain,
    addresses: TEST_ADDRESSES,
    runWalletCreate: () => {
      throw new Error('wallet.create is not part of the listing pipeline')
    },
  }

  return { engine, table, chainTx, receipts, reader, signer }
}

/** What `getListing` answers once the Registry holds the entry. */
export function seedRegistryEntry(
  reader: StubChainReader,
  registryListingId: string,
  overrides: Partial<Parameters<StubChainReader['listings']['set']>[1]> = {},
): void {
  reader.listings.set(registryListingId, {
    creator: CREATOR_ADDRESS,
    payTo: PAYOUT_WALLET,
    agentId: 7n,
    agentType: 'data',
    endpoint: 'http://agent-binance-ticker:4101/',
    price: 10_000n,
    stake: 100_000n,
    reputationBps: 0,
    pausedByCreator: false,
    pausedByStake: false,
    ...overrides,
  })
}
