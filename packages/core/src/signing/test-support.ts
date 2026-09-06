import { PAID_CALL_STATUSES, type AgentType, type CallKind, type CallStatus } from '@agent-desk/schemas'
import type {
  Address,
  BudgetUsage,
  ChainOwnedListingColumns,
  ChainReader,
  ChainTxRecord,
  ChainTxSettlement,
  ChainTxStore,
  Clock,
  GeneratedKey,
  Hex,
  InsertedChainTx,
  ListingCacheRow,
  ListingCacheStore,
  NewWalletRecord,
  PlatformSettings,
  RecordPaymentAuthorization,
  RegistryListing,
  SendRawTxRequest,
  SignTypedDataRequest,
  SignedPaymentAuthorization,
  Signer,
  SigningStore,
  StakeUsage,
  StoredPaymentPayload,
  VerificationUsage,
  WalletRecord,
  WalletStore,
  X402PaymentSigner,
} from '../ports/index.ts'

/**
 * In-memory doubles for every port the signing layer depends on.
 *
 * They are deliberately thin: each one records what it was asked to do so a
 * test can assert the *sequence* — one signature per Call, one transaction per
 * intent key, one write of the chain-owned columns — which is the substance of
 * AD-5 and AD-8. Nothing here simulates a chain; the real chain paths are
 * proven against these doubles and, once the contracts are deployed, against
 * testnet by `pnpm doctor` and the rehearsal Runs.
 */

export function fixedClock(iso: string): Clock & { set(next: string): void } {
  let now = new Date(iso)
  return {
    now: () => now,
    set: (next: string) => {
      now = new Date(next)
    },
  }
}

// ------------------------------------------------------------------ signer

/**
 * A signer with no cryptography: the "encrypted key" is `enc:<address>`, so a
 * test can read which wallet signed without decrypting anything. The real
 * AES-256-GCM behaviour is proven in `packages/adapters/src/signer`.
 */
export class StubSigner implements Signer {
  readonly signedTypedData: SignTypedDataRequest[] = []
  readonly sentTransactions: SendRawTxRequest[] = []
  /** Set to make the next `sendRawTx` throw, as an RPC failure would. */
  sendError: Error | null = null
  private counter = 0

  async generateKey(): Promise<GeneratedKey> {
    this.counter += 1
    const address = `0x${this.counter.toString(16).padStart(40, '0')}`
    return { address, encryptedKey: `enc:${address}` }
  }

  async decryptKey(encryptedKey: string): Promise<Hex> {
    return `0x${encryptedKey.replace('enc:0x', '').padStart(64, '0')}` as Hex
  }

  async signTypedData(request: SignTypedDataRequest): Promise<Hex> {
    this.signedTypedData.push(request)
    return `0x${'11'.repeat(65)}` as Hex
  }

  async sendRawTx(request: SendRawTxRequest): Promise<Hex> {
    if (this.sendError) throw this.sendError
    this.sentTransactions.push(request)
    const index = this.sentTransactions.length
    return `0x${index.toString(16).padStart(64, '0')}` as Hex
  }
}

/** Counts signatures so a test can prove a retry never produced a second one. */
export class StubPaymentSigner implements X402PaymentSigner {
  signatures = 0

  async signPaymentAuthorization(request: {
    wallet: { address: Address; encryptedKey: string }
    requirements: { amount: string; payTo: string }
  }): Promise<SignedPaymentAuthorization> {
    this.signatures += 1
    const nonce = `0x${this.signatures.toString(16).padStart(64, '0')}` as Hex
    return {
      header: `header-${this.signatures}`,
      authorization: {
        from: request.wallet.address,
        to: request.requirements.payTo,
        value: request.requirements.amount,
        validAfter: '0',
        validBefore: '1793000000',
        nonce,
      },
      signature: `0x${'22'.repeat(65)}` as Hex,
    }
  }
}

// ------------------------------------------------------------- chain reads

export class StubChainReader implements ChainReader {
  balances = new Map<string, bigint>()
  tokens = new Map<string, bigint>()
  allowances = new Map<string, bigint>()
  usedAuthorizations = new Set<string>()
  listings = new Map<string, RegistryListing>()
  readonly getListingCalls: string[] = []

  async nativeBalance(address: Address): Promise<bigint> {
    return this.balances.get(address.toLowerCase()) ?? 0n
  }

  async tokenBalance(address: Address): Promise<bigint> {
    return this.tokens.get(address.toLowerCase()) ?? 0n
  }

  async registryAllowance(owner: Address): Promise<bigint> {
    return this.allowances.get(owner.toLowerCase()) ?? 0n
  }

  async authorizationUsed(authorizer: Address, nonce: Hex): Promise<boolean> {
    return this.usedAuthorizations.has(`${authorizer.toLowerCase()}:${nonce}`)
  }

  async getListing(registryListingId: bigint): Promise<RegistryListing> {
    const key = registryListingId.toString()
    this.getListingCalls.push(key)
    const listing = this.listings.get(key)
    if (!listing) throw new Error(`UnknownListing(${key})`)
    return listing
  }
}

// ---------------------------------------------------------------- chain_tx

export class InMemoryChainTxStore implements ChainTxStore {
  readonly rows = new Map<string, ChainTxRecord>()
  readonly inserts: string[] = []
  readonly settlements: { intentKey: string; status: string }[] = []
  private readonly clock: Clock

  constructor(clock: Clock = { now: () => new Date() }) {
    this.clock = clock
  }

  async find(intentKey: string): Promise<ChainTxRecord | null> {
    return this.rows.get(intentKey) ?? null
  }

  async insertPending(intentKey: string, payload: unknown): Promise<InsertedChainTx> {
    const existing = this.rows.get(intentKey)
    if (existing) return { record: existing, inserted: false }
    const now = this.clock.now()
    const record: ChainTxRecord = {
      intentKey,
      payload,
      status: 'pending',
      txHash: null,
      confirmedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.rows.set(intentKey, record)
    this.inserts.push(intentKey)
    return { record, inserted: true }
  }

  async attachHash(intentKey: string, txHash: Hex): Promise<void> {
    const row = this.mustFind(intentKey)
    this.rows.set(intentKey, { ...row, txHash, updatedAt: this.clock.now() })
  }

  async settle(
    intentKey: string,
    status: 'confirmed' | 'reverted' | 'failed',
    result: ChainTxSettlement,
  ): Promise<void> {
    const row = this.mustFind(intentKey)
    this.rows.set(intentKey, {
      ...row,
      status,
      txHash: result.txHash ?? row.txHash,
      confirmedAt: result.confirmedAt,
      updatedAt: this.clock.now(),
    })
    this.settlements.push({ intentKey, status })
  }

  /** Test helper: seed a row as a previous, crashed, or finished run left it. */
  seed(record: Partial<ChainTxRecord> & { intentKey: string }): ChainTxRecord {
    const now = this.clock.now()
    const row: ChainTxRecord = {
      payload: {},
      status: 'pending',
      txHash: null,
      confirmedAt: null,
      createdAt: now,
      updatedAt: now,
      ...record,
    }
    this.rows.set(row.intentKey, row)
    return row
  }

  private mustFind(intentKey: string): ChainTxRecord {
    const row = this.rows.get(intentKey)
    if (!row) throw new Error(`no chain_tx row ${intentKey}`)
    return row
  }
}

// ---------------------------------------------------------- listings cache

export class InMemoryListingCache implements ListingCacheStore {
  readonly rows = new Map<string, ListingCacheRow>()
  readonly chainOwnedWrites: { listingId: string; columns: ChainOwnedListingColumns }[] = []
  readonly lastErrors: { listingId: string; lastError: string }[] = []

  seed(row: ListingCacheRow): void {
    this.rows.set(row.id, row)
  }

  async read(listingId: string): Promise<ListingCacheRow | null> {
    return this.rows.get(listingId) ?? null
  }

  async writeChainOwned(listingId: string, columns: ChainOwnedListingColumns): Promise<void> {
    this.chainOwnedWrites.push({ listingId, columns })
    const row = this.rows.get(listingId)
    if (row) {
      this.rows.set(listingId, {
        ...row,
        price: columns.price,
        stake: columns.stake,
        agentId: columns.agentId,
        registryListingId: columns.registryListingId,
      })
    }
  }

  async writeLastError(listingId: string, lastError: string): Promise<void> {
    this.lastErrors.push({ listingId, lastError })
  }
}

// ----------------------------------------------------------------- wallets

export class InMemoryWalletStore implements WalletStore {
  readonly byId = new Map<string, WalletRecord>()

  async findByAccount(accountId: string): Promise<WalletRecord | null> {
    for (const wallet of this.byId.values()) {
      if (wallet.accountId === accountId) return wallet
    }
    return null
  }

  async insert(wallet: NewWalletRecord): Promise<WalletRecord> {
    const record: WalletRecord = { ...wallet, readyAt: null }
    this.byId.set(record.id, record)
    return record
  }

  async markReady(walletId: string, readyAt: Date): Promise<void> {
    const wallet = this.byId.get(walletId)
    if (!wallet) throw new Error(`no wallet ${walletId}`)
    this.byId.set(walletId, { ...wallet, readyAt })
  }

  seed(wallet: WalletRecord): WalletRecord {
    this.byId.set(wallet.id, wallet)
    return wallet
  }
}

// ---------------------------------------------------------- stake ledger

/** One `calls` row, as far as the FR-25 reservation query can see it. */
export interface StakeLedgerCall {
  callId: string
  listingId: string
  kind: CallKind
  nodeType: AgentType
  /** Base units. */
  lockedPrice: bigint
  status: CallStatus
  /** True once `settlements` has a row for this Call. That is what releases it. */
  settled: boolean
}

/** AD-9 scores these two Types, so only they reserve Stake. Mirrors `packages/db`. */
const SCORED_NODE_TYPES: readonly AgentType[] = ['research', 'risk']

/**
 * The AD-3 Stake reservation as rows rather than as a number, so a test can
 * watch a reservation appear when a Call is paid and disappear when it is
 * scored — and so two concurrent `signPayment` calls on one Listing read the
 * same mutable state a real Postgres would give them.
 *
 * This is a *model* of the query, not the query: `packages/db`'s
 * `stakeReservationForListing` is the one the worker runs. Both are the same
 * three clauses — `kind = 'run'`, a scored Type, a paid status with no
 * `settlements` row — and both are asserted against the same story fixtures.
 */
export class StakeLedger {
  readonly rows = new Map<string, StakeLedgerCall>()
  readonly stakes = new Map<string, bigint>()
  /** Every reservation read and every reservation write, in order. */
  readonly events: string[] = []
  /**
   * Awaited inside `stakeUsage` *after* the reservation has been read. A test
   * sets it to force the interleaving a second Run would produce if the FR-25
   * lock were not held: read, yield, and only then write.
   */
  onRead: ((callId: string) => Promise<void>) | null = null

  /** `listings.stake`, the chain-owned cache (AD-2). */
  setStake(listingId: string, stake: bigint): void {
    this.stakes.set(listingId, stake)
  }

  /** A `calls` row as `POST /api/runs` inserts it: `pending`, unpaid, unsettled. */
  seed(row: Omit<StakeLedgerCall, 'status' | 'settled'> & Partial<StakeLedgerCall>): void {
    this.rows.set(row.callId, { status: 'pending', settled: false, ...row })
  }

  /**
   * What `recordPaymentAuthorization` does to the row: it becomes a reservation.
   * A Call the test never seeded is not modelled here and is left alone, so a
   * ledger can carry one Listing's Calls while other payments run past it.
   */
  markPaid(callId: string): void {
    const row = this.rows.get(callId)
    if (!row) return
    this.rows.set(callId, { ...row, status: 'paid_awaiting_result' })
    this.events.push(`paid:${callId}`)
  }

  /** What Story 4.2 does when it writes the Settlement: the reservation is released. */
  settle(callId: string): void {
    const row = this.rows.get(callId)
    if (!row) throw new Error(`no modelled call ${callId}`)
    this.rows.set(callId, { ...row, status: 'succeeded', settled: true })
    this.events.push(`settled:${callId}`)
  }

  /** The AD-3 rule, over the rows above. */
  counts(row: StakeLedgerCall): boolean {
    if (row.kind !== 'run') return false
    if (!SCORED_NODE_TYPES.includes(row.nodeType)) return false
    if (!PAID_CALL_STATUSES.includes(row.status)) return false
    return !row.settled
  }

  reservedFor(listingId: string): bigint {
    let total = 0n
    for (const row of this.rows.values()) {
      if (row.listingId === listingId && this.counts(row)) total += row.lockedPrice
    }
    return total
  }

  async usage(listingId: string, callId: string): Promise<StakeUsage> {
    const reserved = this.reservedFor(listingId)
    const row = this.rows.get(callId)
    this.events.push(`read:${callId}`)
    if (this.onRead) await this.onRead(callId)
    return {
      stake: this.stakes.get(listingId) ?? 0n,
      reserved,
      callCounted: row ? this.counts(row) : false,
    }
  }
}

// ------------------------------------------------------------ signing store

export interface StubSigningStoreOptions {
  budget?: Partial<BudgetUsage>
  stake?: Partial<StakeUsage>
  verification?: Partial<VerificationUsage>
  settings?: Partial<PlatformSettings>
}

export class StubSigningStore implements SigningStore {
  readonly wallets = new Map<string, WalletRecord>()
  readonly payments = new Map<string, StoredPaymentPayload>()
  readonly recorded: RecordPaymentAuthorization[] = []
  budget: BudgetUsage
  stake: StakeUsage
  verification: VerificationUsage
  settings: PlatformSettings
  /**
   * When set, the FR-25 reservation is answered from modelled `calls` rows
   * instead of the flat `stake` pair, and every payment recorded here becomes a
   * reservation the next reader sees.
   */
  stakeLedger: StakeLedger | null = null
  /** Runs before `recordPaymentAuthorization` returns; lets a test interleave. */
  onRecord: (() => Promise<void>) | null = null

  constructor(options: StubSigningStoreOptions = {}) {
    this.budget = { spend: 0n, budget: 1_000_000n, callCounted: false, ...options.budget }
    this.stake = { stake: 1_000_000n, reserved: 0n, callCounted: false, ...options.stake }
    this.verification = { spent: 0n, cap: 5_000_000n, callCounted: false, ...options.verification }
    this.settings = {
      mode: 'demo',
      emergencyStop: false,
      defaultDailyFeeBudget: '1000000',
      verificationCapDaily: '5000000',
      platformAccountId: 'acc_platform',
      ...options.settings,
    }
  }

  seedWallet(wallet: WalletRecord): WalletRecord {
    this.wallets.set(wallet.id, wallet)
    return wallet
  }

  async getWallet(walletId: string): Promise<WalletRecord | null> {
    return this.wallets.get(walletId) ?? null
  }

  async budgetUsage(): Promise<BudgetUsage> {
    return this.budget
  }

  async stakeUsage(listingId: string, callId: string): Promise<StakeUsage> {
    if (this.stakeLedger) return this.stakeLedger.usage(listingId, callId)
    return this.stake
  }

  async verificationUsage(): Promise<VerificationUsage> {
    return this.verification
  }

  async readPaymentPayload(callId: string): Promise<StoredPaymentPayload | null> {
    return this.payments.get(callId) ?? null
  }

  async recordPaymentAuthorization(input: RecordPaymentAuthorization): Promise<void> {
    if (this.onRecord) await this.onRecord()
    this.recorded.push(input)
    this.payments.set(input.callId, input.payload)
    // AD-5: the same transaction that stores the payload moves the Call to
    // `paid_awaiting_result`, which is what puts it inside the AD-3 query.
    this.stakeLedger?.markPaid(input.callId)
  }

  async platformSettings(): Promise<PlatformSettings> {
    return this.settings
  }
}

/** A wallet row shaped the way `StubSigner` seals keys. */
export function stubWallet(overrides: Partial<WalletRecord> = {}): WalletRecord {
  const address = overrides.address ?? '0x00000000000000000000000000000000000000aa'
  return {
    id: 'wal_TEST',
    accountId: 'acc_TEST',
    address,
    encryptedKey: `enc:${address}`,
    readyAt: null,
    ...overrides,
  }
}
