import type { AgentType, CallKind, ChainTxStatus, PlatformMode } from '@agent-desk/schemas'

/**
 * AD-1: the domain depends on interfaces, never on a vendor SDK. Everything the
 * signing policy, the chain writer, and the wallet-creation job need from the
 * outside world is declared here and implemented in `packages/adapters` or, for
 * the persistence ports, in a host (`apps/worker`, `scripts/`) that may see
 * both `@agent-desk/db` and `@agent-desk/adapters`.
 *
 * Every port is deliberately small. A port that grows a method whenever a
 * caller finds a query convenient stops being a boundary, so the persistence
 * ports below expose the *decisions* the domain makes (`BudgetUsage`,
 * `StakeUsage`) rather than raw tables, and the three AD-3 derived amounts stay
 * defined once, in `packages/db`, behind them.
 */

// --------------------------------------------------------------- primitives

/** Lower-case `0x` address (AD-13). */
export type Address = string
/** `0x`-prefixed hex, e.g. calldata, a signature, or a transaction hash. */
export type Hex = `0x${string}`

/** Wall-clock, injectable so tests never sleep. */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

// ------------------------------------------------------------------- signer

/**
 * AD-5: the only thing in the system that touches a private key. The key is
 * always handed in encrypted; the port decrypts it in memory for the length of
 * one operation and never returns it to the caller except through
 * {@link Signer.decryptKey}, which exists for the two callers that must hand a
 * key to a vendor SDK (the x402 payment signer and the seed script).
 *
 * `MASTER_KEY` is a construction parameter of the implementation, so it appears
 * only in the env schema of the process that builds one — the worker and
 * `scripts/` — and nowhere else (AD-1).
 */
export interface Signer {
  /** A fresh EVM key. The private key never leaves the implementation. */
  generateKey(): Promise<GeneratedKey>
  /** AES-256-GCM decryption under `MASTER_KEY`. Throws when the key is wrong. */
  decryptKey(encryptedKey: string): Promise<Hex>
  /** EIP-712. Used for the x402 EIP-3009 authorization and nothing else so far. */
  signTypedData(request: SignTypedDataRequest): Promise<Hex>
  /**
   * Signs `tx` with the wallet's key and broadcasts it. Returns the hash as
   * soon as the node accepts the raw transaction; awaiting the receipt is
   * `chainWrite`'s job (AD-8), not the signer's.
   */
  sendRawTx(request: SendRawTxRequest): Promise<Hex>
}

export interface GeneratedKey {
  /** Lower-case (AD-13). */
  address: Address
  /** AES-256-GCM ciphertext, safe to store in `wallets.encrypted_key`. */
  encryptedKey: string
}

export interface SignTypedDataRequest {
  encryptedKey: string
  domain: {
    name: string
    version: string
    chainId: number
    verifyingContract: Address
  }
  types: Record<string, readonly { name: string; type: string }[]>
  primaryType: string
  message: Record<string, unknown>
}

export interface SendRawTxRequest {
  encryptedKey: string
  to: Address
  /** Calldata; `0x` for a plain value transfer. */
  data: Hex
  /** Wei. Omitted means zero. */
  value?: bigint
  /** Explicit gas limit; the implementation estimates when this is absent. */
  gas?: bigint
}

// ----------------------------------------------------------- x402 payments

/**
 * AD-6: one x402 binding for the engine, the agents, and the facilitator. The
 * domain decides *whether* to pay; this port owns the wire format of the
 * payment itself, so no second implementation of the EIP-3009 authorization or
 * of the `PAYMENT-SIGNATURE` encoding can appear in core.
 */
export interface X402PaymentSigner {
  signPaymentAuthorization(request: SignPaymentAuthorizationRequest): Promise<SignedPaymentAuthorization>
}

export interface SignPaymentAuthorizationRequest {
  /** The paying wallet: its address and the key material the signer decrypts. */
  wallet: { address: Address; encryptedKey: string }
  /** The `accepts` entry the engine already matched against the Price Lock. */
  requirements: PaymentRequirementsSnapshot
}

/** The subset of an x402 `accepts` entry that a payment is signed against. */
export interface PaymentRequirementsSnapshot {
  scheme: string
  /** CAIP-2, compared as an exact string (AD-6). */
  network: string
  /** Lower-case tUSD address. */
  asset: Address
  /** Base units, AD-13. */
  amount: string
  payTo: Address
  maxTimeoutSeconds: number
  /** The EIP-712 domain the token verifies against; a 402 without it is refused. */
  extra: { name: string; version: string }
}

export interface SignedPaymentAuthorization {
  /** The value of the `PAYMENT-SIGNATURE` header, ready to send. */
  header: string
  /** AD-3: what `calls.payment_payload` records. */
  authorization: {
    from: Address
    to: Address
    /** Base units. */
    value: string
    validAfter: string
    validBefore: string
    nonce: Hex
  }
  signature: Hex
}

// ------------------------------------------------------------- chain reads

/**
 * Read-only chain access. Split from the writer because the signing policy
 * needs balances but must never be able to send anything.
 */
export interface ChainReader {
  /** BNB balance in wei. */
  nativeBalance(address: Address): Promise<bigint>
  /** tUSD balance in base units. */
  tokenBalance(address: Address): Promise<bigint>
  /** tUSD allowance of `owner` for the registry, base units. */
  registryAllowance(owner: Address): Promise<bigint>
  /** AD-6: `unused` means a payment never landed. */
  authorizationUsed(authorizer: Address, nonce: Hex): Promise<boolean>
  /** AD-2: the whole Registry entry, the one source `refreshListingFromChain` reads. */
  getListing(registryListingId: bigint): Promise<RegistryListing>
}

/** `AgentDeskRegistry.getListing`, decoded. */
export interface RegistryListing {
  creator: Address
  payTo: Address
  agentId: bigint
  agentType: string
  endpoint: string
  /** Base units. */
  price: bigint
  /** Base units. */
  stake: bigint
  reputationBps: number
  pausedByCreator: boolean
  pausedByStake: boolean
}

// ------------------------------------------------------------ encoded calls

/**
 * AD-8: adapters import only the ABI JSON exported by the contracts build, and
 * core imports no ABI at all. Every call this system makes is named here once
 * and encoded in `packages/adapters/chain`, so a wrong argument order is a
 * compile error rather than a reverted transaction on testnet.
 */
export interface ChainCall {
  to: Address
  data: Hex
  /** Wei, for the one call that moves BNB rather than calldata. */
  value?: bigint
}

export interface ContractCalls {
  /** A plain BNB transfer; the `gas:<wallet_id>` intent. */
  nativeTransfer(to: Address, valueWei: bigint): ChainCall
  /** `TUSD.mint(to, amount)`, permissionless on the testnet faucet token. */
  tusdMint(to: Address, amount: bigint): ChainCall
  /** `TUSD.approve(spender, value)`; the `approve:<wallet_id>` intent. */
  tusdApprove(spender: Address, value: bigint): ChainCall
  /** ERC-8004 `IdentityRegistry.register(agentURI)`. */
  identityRegister(agentUri: string): ChainCall
  /** ERC-8004 `IdentityRegistry.setAgentURI(agentId, agentURI)`. */
  identitySetAgentUri(agentId: bigint, agentUri: string): ChainCall
  /** `AgentDeskRegistry.list(agentId, agentType, price, endpoint, payTo, stake)`. */
  registryList(args: RegistryListArgs): ChainCall
  /** `AgentDeskRegistry.addStake(listingId, amount)`. */
  registryAddStake(registryListingId: bigint, amount: bigint): ChainCall
  /** `AgentDeskRegistry.setPrice(listingId, newPrice)`. */
  registrySetPrice(registryListingId: bigint, price: bigint): ChainCall
  /** `AgentDeskRegistry.setPaused(listingId, paused)`. */
  registrySetPaused(registryListingId: bigint, paused: boolean): ChainCall
  /** `AgentDeskRegistry.slash(listingId, callRef, amount, to)`. */
  registrySlash(args: RegistrySlashArgs): ChainCall
  /** `AgentDeskRegistry.setReputation(listingId, bps)`. */
  registrySetReputation(registryListingId: bigint, bps: number): ChainCall
  /** AD-8: `callRef` is `keccak256(call_id)`. */
  callRef(callId: string): Hex
  /** The addresses these calls are aimed at, resolved from the deployments file. */
  readonly addresses: { tusd: Address; registry: Address; identityRegistry: Address }
}

export interface RegistryListArgs {
  agentId: bigint
  agentType: AgentType
  /** Base units. */
  price: bigint
  endpoint: string
  payTo: Address
  /** Base units. */
  stake: bigint
}

export interface RegistrySlashArgs {
  registryListingId: bigint
  callRef: Hex
  /** Base units. */
  amount: bigint
  to: Address
}

// ------------------------------------------------------- chain_tx storage

/**
 * AD-8: the `chain_tx` table, behind a port so `packages/adapters/chain` never
 * imports `@agent-desk/db`. The intent key is the identity of the transaction,
 * which is why every method is keyed by it and there is no surrogate id.
 */
export interface ChainTxStore {
  find(intentKey: string): Promise<ChainTxRecord | null>
  /**
   * Inserts the row in `pending` with its payload, `on conflict do nothing`.
   * `inserted` is false when the row was already there, which is how two racing
   * workers agree on one transaction per intent key: only the caller that
   * actually inserted may send.
   */
  insertPending(intentKey: string, payload: unknown): Promise<InsertedChainTx>
  /** Records the hash the node accepted, before the receipt is awaited. */
  attachHash(intentKey: string, txHash: Hex): Promise<void>
  settle(intentKey: string, status: Exclude<ChainTxStatus, 'pending'>, result: ChainTxSettlement): Promise<void>
}

export interface InsertedChainTx {
  record: ChainTxRecord
  inserted: boolean
}

export interface ChainTxRecord {
  intentKey: string
  payload: unknown
  status: ChainTxStatus
  txHash: Hex | null
  confirmedAt: Date | null
  /** How `chainWrite` tells a crashed send from one that is still in flight. */
  createdAt: Date
  updatedAt: Date
}

export interface ChainTxSettlement {
  txHash: Hex | null
  confirmedAt: Date | null
}

// ------------------------------------------------------- listing cache

/**
 * AD-2: the chain-owned listing columns. `writeChainOwned` is the single write
 * path for all nine of them, and `refreshListingFromChain` is its only caller;
 * `lastError` is a pipeline column and is deliberately a separate method so a
 * failed write can be recorded without touching a chain-owned value.
 */
export interface ListingCacheStore {
  read(listingId: string): Promise<ListingCacheRow | null>
  writeChainOwned(listingId: string, columns: ChainOwnedListingColumns): Promise<void>
  writeLastError(listingId: string, lastError: string): Promise<void>
}

export interface ListingCacheRow {
  id: string
  creatorAccountId: string
  type: AgentType
  agentId: string | null
  registryListingId: string | null
  /** Base units, or null before the first confirmed receipt. */
  price: string | null
  stake: string | null
}

/** Exactly the nine columns AD-2 names, and nothing else. */
export interface ChainOwnedListingColumns {
  /** Base units. */
  price: string
  /** Base units. */
  stake: string
  reputationBps: number
  pausedByCreator: boolean
  pausedByStake: boolean
  payoutWallet: Address
  endpoint: string
  agentId: string
  registryListingId: string
}

// ------------------------------------------------------- signing storage

/**
 * What the signing policy reads and writes. The three AD-3 derived amounts are
 * returned already paired with the limit they are checked against, so the
 * domain compares two numbers and the "one spend query" rule cannot be
 * sidestepped by a caller assembling its own pair.
 */
export interface SigningStore {
  getWallet(walletId: string): Promise<WalletRecord | null>
  /** FR-3: the account's spend against its budget, both in base units. */
  budgetUsage(accountId: string, callId: string, now: Date): Promise<BudgetUsage>
  /** FR-25: the Listing's stake against its unscored reservations. */
  stakeUsage(listingId: string, callId: string): Promise<StakeUsage>
  /** FR-11: the Platform Wallet's 24 h verification spend against its cap. */
  verificationUsage(callId: string, now: Date): Promise<VerificationUsage>
  /** The stored authorization, so a retry finds the header instead of re-signing. */
  readPaymentPayload(callId: string): Promise<StoredPaymentPayload | null>
  /**
   * AD-5: writes `calls.payment_payload` and moves the Call to
   * `paid_awaiting_result` **in one database transaction**. The engine may not
   * send the paid request until this has returned.
   */
  recordPaymentAuthorization(input: RecordPaymentAuthorization): Promise<void>
  /** AD-10: the mode and the two platform-wide limits, re-read per operation. */
  platformSettings(): Promise<PlatformSettings>
}

export interface WalletRecord {
  id: string
  accountId: string
  address: Address
  encryptedKey: string
  readyAt: Date | null
}

export interface BudgetUsage {
  /** AD-3 spend since the window start, base units. */
  spend: bigint
  /** `accounts.daily_fee_budget`, else `platform_settings.default_daily_fee_budget`. */
  budget: bigint
  /** True when this Call's row is already inside `spend` under the AD-3 rule. */
  callCounted: boolean
}

export interface StakeUsage {
  /** `listings.stake`, the chain-owned cache. Zero when the Listing is unlisted. */
  stake: bigint
  /** FR-25: locked prices of the Listing's unscored paid research and risk Calls. */
  reserved: bigint
  callCounted: boolean
}

export interface VerificationUsage {
  spent: bigint
  cap: bigint
  callCounted: boolean
}

export interface StoredPaymentPayload {
  header: string
  nonce: Hex
  validAfter: string
  validBefore: string
  from: Address
  to: Address
  /** Base units. */
  value: string
  signature: Hex
}

export interface RecordPaymentAuthorization {
  callId: string
  payload: StoredPaymentPayload
  /** `calls.started_at`, set only if it is still null. */
  startedAt: Date
}

export interface PlatformSettings {
  mode: PlatformMode
  emergencyStop: boolean
  /** Base units. */
  defaultDailyFeeBudget: string
  /** Base units. */
  verificationCapDaily: string
  platformAccountId: string | null
}

// -------------------------------------------------------- wallet storage

/** AD-5 / FR-2: what the `wallet.create` job needs from the database. */
export interface WalletStore {
  findByAccount(accountId: string): Promise<WalletRecord | null>
  insert(wallet: NewWalletRecord): Promise<WalletRecord>
  /** Set from the `approve:<wallet_id>` receipt, and only from it. */
  markReady(walletId: string, readyAt: Date): Promise<void>
}

export interface NewWalletRecord {
  id: string
  accountId: string
  address: Address
  encryptedKey: string
}

// --------------------------------------------------------------- call rows

/** The Call context the signing policy needs; the engine owns everything else. */
export interface PaymentCallContext {
  callId: string
  kind: CallKind
  /** Null for a `verification` Call, which belongs to a Listing, not a Run. */
  accountId: string | null
  listingId: string
  nodeType: AgentType
}

// ------------------------------------------------------------- market data

/**
 * AD-9 / addendum §4: Binance production public market data is the only price
 * source Settlement may name, so it is a port of its own rather than a call
 * inside the settlement code.
 */
export interface MarketData {
  /** Decimal USDT, e.g. "612.40". */
  lastPrice(symbol: string): Promise<string>
  ticker24h(symbol: string): Promise<Ticker24h>
  klines(request: KlineRequest): Promise<Kline[]>
}

export interface Ticker24h {
  symbol: string
  /** Decimal USDT. */
  lastPrice: string
  /** Percent, e.g. -1.732. */
  change24hPct: number
  highPrice: string
  lowPrice: string
  /** Base asset volume, decimal. */
  volume: string
  /** Milliseconds since the epoch. */
  closeTime: number
}

/** The two granularities the §6 mode table names, plus what the demo may need. */
export const KLINE_INTERVALS = ['1s', '1m', '5m', '15m', '1h', '1d'] as const
export type KlineInterval = (typeof KLINE_INTERVALS)[number]

export interface KlineRequest {
  symbol: string
  interval: KlineInterval
  /** Milliseconds since the epoch, inclusive. */
  startTime?: number
  /** Milliseconds since the epoch, inclusive. */
  endTime?: number
  limit?: number
}

export interface Kline {
  openTime: number
  open: string
  high: string
  low: string
  close: string
  volume: string
  closeTime: number
}

// ------------------------------------------------------------------ logger

/** Conventions: pino JSON logs. The domain only needs these four levels. */
export interface Logger {
  debug(fields: Record<string, unknown>, message: string): void
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
