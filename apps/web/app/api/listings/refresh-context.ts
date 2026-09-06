import { z } from 'zod'
import { db, type Database } from '@agent-desk/db'
import {
  addressesFor,
  createChainReader,
  createChainWriter,
  createPublicChainClient,
} from '@agent-desk/adapters/chain'
import type {
  ChainOwnedListingColumns,
  ChainTxStore,
  ListingCacheRow,
  ListingCacheStore,
} from '@agent-desk/core/ports'
import type { ListingRefreshResult, SigningService } from '@agent-desk/core/signing'

/**
 * `POST /api/listings/<id>/refresh` — the second caller of
 * `refreshListingFromChain` that AD-2 names (Story 3.6).
 *
 * AD-2 allows exactly two callers of that function and exactly one
 * implementation of it. So this does not re-read `getListing` and write nine
 * columns of its own: it constructs the real `createChainWriter` from
 * `packages/adapters/chain` — the same code the worker runs — and calls its
 * `refreshListingFromChain`. The three dependencies that only `chainWrite`
 * needs (the `chain_tx` table, a signer, a receipt source) are deliberately
 * unreachable stubs: AD-1 says the web app holds no key and signs nothing, and
 * a refresh never sends a transaction, so reaching one of them would be a bug
 * and should say so rather than quietly work.
 *
 * ┌─ what this file would rather not own ──────────────────────────────────┐
 * │ `createListingCacheStore` already exists, in `scripts/src/wiring`, and  │
 * │ its comment is the AD-2 invariant: `writeChainOwned` has one            │
 * │ definition. `@agent-desk/scripts` is not a dependency of `apps/web` and │
 * │ adding one needs a `package.json` change this story does not own, so    │
 * │ the store is repeated here. Exporting `createListingCacheStore` from    │
 * │ `@agent-desk/db` — where AD-2 says `refreshListingFromChain` lives —    │
 * │ would delete this half of the file.                                    │
 * └────────────────────────────────────────────────────────────────────────┘
 */

const envSchema = z.object({
  CHAIN_ID: z.coerce.number().int().positive().default(97),
  RPC_URLS: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((url) => url.trim()).filter(Boolean)),
})

let parsed: z.infer<typeof envSchema> | undefined

/** Parsed on first use, never at module scope; `next build` has no runtime env. */
function env(): z.infer<typeof envSchema> {
  parsed ??= envSchema.parse(process.env)
  return parsed
}

let refresher: ((listingId: string) => Promise<ListingRefreshResult>) | undefined

export function refreshListingFromChain(listingId: string): Promise<ListingRefreshResult> {
  refresher ??= build()
  return refresher(listingId)
}

/**
 * AD-2 fixes four statuses off chain and two pause flags on it, and `status` is
 * not one of the nine columns `refreshListingFromChain` owns — so the same rule
 * `listing.write` applies after a confirmed receipt is applied here after a
 * manual refresh, which is the case where that receipt was missed. Only a
 * Listing already on the marketplace moves; `verifying` and `failed` belong to
 * the listing pipeline.
 */
export async function reconcileListingStatus(listingId: string): Promise<void> {
  const sql = db().$client
  await sql`
    update listings
       set status = case when paused_by_creator or paused_by_stake then 'paused' else 'active' end,
           updated_at = now()
     where id = ${listingId}
       and status in ('active', 'paused')
       and status <> case when paused_by_creator or paused_by_stake then 'paused' else 'active' end
  `
}

function build(): (listingId: string) => Promise<ListingRefreshResult> {
  const addresses = addressesFor(env().CHAIN_ID)
  const writer = createChainWriter({
    store: unreachable<ChainTxStore>('chain_tx'),
    listings: createListingCacheStore(db()),
    reader: createChainReader({
      publicClient: createPublicChainClient({ chainId: env().CHAIN_ID, rpcUrls: env().RPC_URLS }),
      addresses,
    }),
    signing: unreachable<Pick<SigningService, 'sendTx'>>('the signer'),
    receipts: unreachable<Parameters<typeof createChainWriter>[0]['receipts']>('receipts'),
    addresses,
  })
  return (listingId) => writer.refreshListingFromChain(listingId)
}

/**
 * A dependency `refreshListingFromChain` never touches. Every property throws,
 * so a future change that made this route send a transaction fails loudly here
 * instead of finding a key in the web process (AD-1).
 */
function unreachable<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      throw new Error(
        `apps/web reached ${what}.${String(property)}; only refreshListingFromChain may run here (AD-1)`,
      )
    },
  })
}

/**
 * AD-2: the nine chain-owned columns, written from one place. This is the same
 * store as `scripts/src/wiring/stores.ts`; see the note above for why it is
 * repeated rather than imported.
 */
function createListingCacheStore(database: Database): ListingCacheStore {
  const sql = database.$client
  return {
    async read(listingId): Promise<ListingCacheRow | null> {
      const row = await database.query.listings.findFirst({
        where: (listing, { eq }) => eq(listing.id, listingId),
        columns: {
          id: true,
          creatorAccountId: true,
          type: true,
          agentId: true,
          registryListingId: true,
          price: true,
          stake: true,
        },
      })
      return row ?? null
    },

    async writeChainOwned(listingId, columns: ChainOwnedListingColumns) {
      // `apps/web` depends on `@agent-desk/db` but not on `drizzle-orm`, so
      // there is no `eq` to build a `where` with; the statement goes through the
      // postgres-js client under Drizzle, where every value — including the id
      // from the URL — is a bound parameter, exactly as `applyMePatch` does.
      await sql`
        update listings set
          price = ${columns.price},
          stake = ${columns.stake},
          reputation_bps = ${columns.reputationBps},
          paused_by_creator = ${columns.pausedByCreator},
          paused_by_stake = ${columns.pausedByStake},
          payout_wallet = ${columns.payoutWallet.toLowerCase()},
          endpoint = ${columns.endpoint},
          agent_id = ${columns.agentId},
          registry_listing_id = ${columns.registryListingId},
          updated_at = now()
        where id = ${listingId}
      `
    },

    async writeLastError(listingId, lastError) {
      await sql`update listings set last_error = ${lastError}, updated_at = now() where id = ${listingId}`
    },
  }
}
