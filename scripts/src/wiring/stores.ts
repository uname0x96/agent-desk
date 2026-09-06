import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  accounts,
  calls,
  chainTx,
  listings,
  platformSettings,
  runs,
  settlements,
  wallets,
  budgetWindowStart,
  countsTowardDailyFeeSpend,
  countsTowardStakeReservation,
  dailyFeeSpendForAccount,
  stakeReservationForListing,
  verificationSpendLast24h,
  type Database,
} from '@agent-desk/db'
import { PAID_CALL_STATUSES } from '@agent-desk/schemas'
import type {
  ChainOwnedListingColumns,
  ChainTxRecord,
  ChainTxSettlement,
  ChainTxStore,
  Hex,
  InsertedChainTx,
  ListingCacheRow,
  ListingCacheStore,
  NewWalletRecord,
  PlatformSettings,
  RecordPaymentAuthorization,
  SigningStore,
  StoredPaymentPayload,
  WalletRecord,
  WalletStore,
} from '@agent-desk/core/ports'

/**
 * The Postgres side of the ports `packages/core/signing` and
 * `packages/adapters/chain` are written against.
 *
 * AD-1 is why these live here and not in either of those packages: `core` may
 * import only `@agent-desk/schemas`, and `packages/adapters` has no
 * `@agent-desk/db` dependency. A host — `scripts/`, and the worker of a later
 * story — is the one place allowed to hold both halves, so it is the one place
 * these are wired.
 *
 * Nothing here re-derives an amount. The three AD-3 spend rules are called from
 * `@agent-desk/db`, which already defines them once.
 */

// ------------------------------------------------------------------ chain_tx

export function createChainTxStore(db: Database): ChainTxStore {
  return {
    async find(intentKey) {
      const [row] = await db.select().from(chainTx).where(eq(chainTx.intentKey, intentKey)).limit(1)
      return row ? toChainTxRecord(row) : null
    },

    /**
     * AD-8: `on conflict do nothing` is what makes two workers agree on one
     * transaction per intent key. The caller that inserted may send; the one
     * that did not gets `inserted: false` and only ever reads.
     */
    async insertPending(intentKey, payload): Promise<InsertedChainTx> {
      const [inserted] = await db
        .insert(chainTx)
        .values({ intentKey, payload, status: 'pending' })
        .onConflictDoNothing({ target: chainTx.intentKey })
        .returning()
      if (inserted) return { record: toChainTxRecord(inserted), inserted: true }

      const [existing] = await db
        .select()
        .from(chainTx)
        .where(eq(chainTx.intentKey, intentKey))
        .limit(1)
      if (!existing) throw new Error(`chain_tx ${intentKey} neither inserted nor found`)
      return { record: toChainTxRecord(existing), inserted: false }
    },

    async attachHash(intentKey, txHash) {
      await db
        .update(chainTx)
        .set({ txHash: txHash.toLowerCase(), updatedAt: new Date() })
        .where(eq(chainTx.intentKey, intentKey))
    },

    async settle(intentKey, status, result: ChainTxSettlement) {
      await db
        .update(chainTx)
        .set({
          status,
          ...(result.txHash ? { txHash: result.txHash.toLowerCase() } : {}),
          confirmedAt: result.confirmedAt,
          updatedAt: new Date(),
        })
        .where(eq(chainTx.intentKey, intentKey))
    },
  }
}

function toChainTxRecord(row: typeof chainTx.$inferSelect): ChainTxRecord {
  return {
    intentKey: row.intentKey,
    payload: row.payload,
    status: row.status,
    txHash: (row.txHash as Hex | null) ?? null,
    confirmedAt: row.confirmedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// ------------------------------------------------------------------ listings

/**
 * AD-2: `writeChainOwned` is reachable from exactly one caller,
 * `refreshListingFromChain`. Nothing else in this repository writes the nine
 * columns it sets — `rg 'writeChainOwned'` finds this definition, the port, the
 * refresh function, and the tests, and nothing else.
 */
export function createListingCacheStore(db: Database): ListingCacheStore {
  return {
    async read(listingId): Promise<ListingCacheRow | null> {
      const [row] = await db
        .select({
          id: listings.id,
          creatorAccountId: listings.creatorAccountId,
          type: listings.type,
          agentId: listings.agentId,
          registryListingId: listings.registryListingId,
          price: listings.price,
          stake: listings.stake,
        })
        .from(listings)
        .where(eq(listings.id, listingId))
        .limit(1)
      return row ?? null
    },

    async writeChainOwned(listingId, columns: ChainOwnedListingColumns) {
      await db
        .update(listings)
        .set({
          price: columns.price,
          stake: columns.stake,
          reputationBps: columns.reputationBps,
          pausedByCreator: columns.pausedByCreator,
          pausedByStake: columns.pausedByStake,
          payoutWallet: columns.payoutWallet.toLowerCase(),
          endpoint: columns.endpoint,
          agentId: columns.agentId,
          registryListingId: columns.registryListingId,
          updatedAt: new Date(),
        })
        .where(eq(listings.id, listingId))
    },

    async writeLastError(listingId, lastError) {
      await db
        .update(listings)
        .set({ lastError, updatedAt: new Date() })
        .where(eq(listings.id, listingId))
    },
  }
}

// ------------------------------------------------------------------- wallets

export function createWalletStore(db: Database): WalletStore {
  return {
    async findByAccount(accountId) {
      const [row] = await db
        .select()
        .from(wallets)
        .where(eq(wallets.accountId, accountId))
        .limit(1)
      return row ? toWalletRecord(row) : null
    },

    async insert(wallet: NewWalletRecord) {
      const [row] = await db
        .insert(wallets)
        .values({
          id: wallet.id,
          accountId: wallet.accountId,
          address: wallet.address.toLowerCase(),
          encryptedKey: wallet.encryptedKey,
        })
        .returning()
      if (!row) throw new Error(`wallet ${wallet.id} was not inserted`)
      return toWalletRecord(row)
    },

    /** AD-5: `ready_at` comes from the approve receipt and is never cleared. */
    async markReady(walletId, readyAt) {
      await db
        .update(wallets)
        .set({ readyAt })
        .where(and(eq(wallets.id, walletId), isNull(wallets.readyAt)))
    },
  }
}

function toWalletRecord(row: typeof wallets.$inferSelect): WalletRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    address: row.address,
    encryptedKey: row.encryptedKey,
    readyAt: row.readyAt,
  }
}

// ------------------------------------------------------------ signing store

export function createSigningStore(db: Database): SigningStore {
  return {
    async getWallet(walletId) {
      const [row] = await db.select().from(wallets).where(eq(wallets.id, walletId)).limit(1)
      return row ? toWalletRecord(row) : null
    },

    /**
     * FR-3. `callCounted` says whether the AD-3 spend query already contains
     * this Call, which it does while the Call is `pending` inside a `running`
     * Run — the reservation the API made when it admitted the Run. Without it
     * the policy would charge the same Call twice and refuse a Run the API had
     * already accepted.
     */
    async budgetUsage(accountId, callId, now) {
      const [account] = await db
        .select({
          dailyFeeBudget: accounts.dailyFeeBudget,
          budgetWindowStart: accounts.budgetWindowStart,
        })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1)
      const settings = await readPlatformSettings(db)
      const spend = await dailyFeeSpendForAccount(db, accountId, now)
      const budget = BigInt(account?.dailyFeeBudget ?? settings.defaultDailyFeeBudget)

      const [row] = await db
        .select({
          kind: calls.kind,
          status: calls.status,
          locked_price: calls.lockedPrice,
          at: sql<Date>`coalesce(${calls.startedAt}, ${runs.createdAt})`.as('at'),
          run_status: runs.status,
        })
        .from(calls)
        .innerJoin(runs, eq(calls.runId, runs.id))
        .where(eq(calls.id, callId))
        .limit(1)
      const windowStart = budgetWindowStart(account?.budgetWindowStart ?? null, now)

      return {
        spend,
        budget,
        callCounted: row ? countsTowardDailyFeeSpend(row, windowStart) : false,
      }
    },

    /** FR-25. The Stake itself is the chain-owned cache, never a local sum. */
    async stakeUsage(listingId, callId) {
      const [listing] = await db
        .select({ stake: listings.stake })
        .from(listings)
        .where(eq(listings.id, listingId))
        .limit(1)
      const reserved = await stakeReservationForListing(db, listingId)

      const [row] = await db
        .select({
          kind: calls.kind,
          node_type: calls.nodeType,
          status: calls.status,
          locked_price: calls.lockedPrice,
          settled: sql<boolean>`${settlements.id} is not null`.as('settled'),
        })
        .from(calls)
        .leftJoin(settlements, eq(settlements.callId, calls.id))
        .where(eq(calls.id, callId))
        .limit(1)

      return {
        stake: BigInt(listing?.stake ?? '0'),
        reserved,
        callCounted: row ? countsTowardStakeReservation(row) : false,
      }
    },

    /** FR-11: the Platform Wallet's own 24 h cap, not any account's budget. */
    async verificationUsage(callId, now) {
      const settings = await readPlatformSettings(db)
      const spent = await verificationSpendLast24h(db, now)
      const [row] = await db
        .select({ kind: calls.kind, status: calls.status, startedAt: calls.startedAt })
        .from(calls)
        .where(eq(calls.id, callId))
        .limit(1)
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)

      return {
        spent,
        cap: BigInt(settings.verificationCapDaily),
        callCounted:
          row?.kind === 'verification' &&
          PAID_CALL_STATUSES.includes(row.status) &&
          row.startedAt !== null &&
          row.startedAt >= since,
      }
    },

    async readPaymentPayload(callId): Promise<StoredPaymentPayload | null> {
      const [row] = await db
        .select({ paymentPayload: calls.paymentPayload })
        .from(calls)
        .where(eq(calls.id, callId))
        .limit(1)
      const payload = row?.paymentPayload
      if (!payload || typeof payload !== 'object') return null
      return payload as StoredPaymentPayload
    },

    /**
     * AD-5, the load-bearing clause: `calls.payment_payload` and the move to
     * `paid_awaiting_result` are one transaction. A crash between them would
     * leave a signed authorization the engine could spend a second time.
     */
    async recordPaymentAuthorization(input: RecordPaymentAuthorization) {
      await db.transaction(async (tx) => {
        await tx
          .update(calls)
          .set({
            paymentPayload: input.payload,
            status: 'paid_awaiting_result',
            startedAt: sql`coalesce(${calls.startedAt}, ${input.startedAt.toISOString()}::timestamptz)`,
          })
          .where(eq(calls.id, input.callId))
      })
    },

    platformSettings: () => readPlatformSettings(db),
  }
}

/** AD-10: the single row, re-read per operation so a flip needs no restart. */
export async function readPlatformSettings(db: Database): Promise<PlatformSettings> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.id, 1)).limit(1)
  if (!row) throw new Error('platform_settings row 1 is missing; run the migrations')
  return {
    mode: row.mode,
    emergencyStop: row.emergencyStop,
    defaultDailyFeeBudget: row.defaultDailyFeeBudget,
    verificationCapDaily: row.verificationCapDaily,
    platformAccountId: row.platformAccountId,
  }
}
