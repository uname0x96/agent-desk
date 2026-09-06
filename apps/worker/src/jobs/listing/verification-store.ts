import { and, desc, eq, sql } from 'drizzle-orm'
import {
  calls,
  platformSettings,
  verificationSpendLast24h,
  wallets,
  type Database,
} from '@agent-desk/db'
import type { StoredPaymentPayload } from '@agent-desk/core/ports'
import { PLATFORM_SETTINGS_ID } from '@agent-desk/db'
import type {
  VerificationCallPatch,
  VerificationCallRow,
  VerificationCallStore,
} from './verification-ports.ts'

/**
 * The Postgres side of the verification Call (Story 3.4).
 *
 * AD-1 is why it lives in the worker rather than in `packages/core`: core may
 * not see `@agent-desk/db`. AD-3 is why every amount here is a query and never a
 * counter — the Platform Wallet's verification spend is
 * `verificationSpendLast24h`, the very function the signing policy calls inside
 * the lock, so the pre-check and the authoritative check can never disagree
 * about what has been spent.
 */
export function createVerificationCallStore(db: Database): VerificationCallStore {
  return {
    /**
     * The newest verification Call of this Listing. There is normally at most
     * one; ordering by id descending (ULIDs are time-ordered, AD-13) makes the
     * answer deterministic if a hand-written row ever makes it two.
     */
    async findForListing(listingId): Promise<VerificationCallRow | null> {
      const [row] = await db
        .select({
          id: calls.id,
          status: calls.status,
          attempt: calls.attempt,
          request: calls.request,
          failureReason: calls.failureReason,
          paymentTxHash: calls.paymentTxHash,
          hasPaymentPayload: sql<boolean>`${calls.paymentPayload} is not null`.as(
            'has_payment_payload',
          ),
        })
        .from(calls)
        .where(and(eq(calls.listingId, listingId), eq(calls.kind, 'verification')))
        .orderBy(desc(calls.id))
        .limit(1)
      return row ?? null
    },

    async insert(call): Promise<void> {
      await db.insert(calls).values({
        id: call.id,
        // AD-3: a verification Call belongs to a Listing, not to a Run.
        runId: null,
        kind: 'verification',
        listingId: call.listingId,
        // `calls.node_index` is not null in the schema and a verification Call
        // has no position in a Workflow; zero is the only honest answer, and
        // `run_id is null` is what tells the two kinds apart everywhere else.
        nodeIndex: 0,
        nodeType: call.nodeType,
        status: 'pending',
        lockedPrice: call.lockedPrice,
        lockedPayTo: call.lockedPayTo,
        lockedAsset: call.lockedAsset,
        lockedNetwork: call.lockedNetwork,
        request: call.request,
        startedAt: call.startedAt,
      })
    },

    async update(callId, patch: VerificationCallPatch): Promise<void> {
      await db
        .update(calls)
        .set({
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.response === undefined ? {} : { response: patch.response }),
          ...(patch.paymentRequired === undefined
            ? {}
            : { paymentRequired: patch.paymentRequired }),
          ...(patch.paymentTxHash === undefined ? {} : { paymentTxHash: patch.paymentTxHash }),
          ...(patch.attempt === undefined ? {} : { attempt: patch.attempt }),
          ...(patch.failureReason === undefined ? {} : { failureReason: patch.failureReason }),
          ...(patch.endedAt === undefined ? {} : { endedAt: patch.endedAt }),
        })
        .where(eq(calls.id, callId))
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

    async capUsage(now) {
      const [settings] = await db
        .select({ cap: platformSettings.verificationCapDaily })
        .from(platformSettings)
        .where(eq(platformSettings.id, PLATFORM_SETTINGS_ID))
        .limit(1)
      if (!settings) {
        throw new Error(`platform_settings row ${PLATFORM_SETTINGS_ID} is missing`)
      }
      return { spent: await verificationSpendLast24h(db, now), cap: BigInt(settings.cap) }
    },

    /**
     * AD-5: `PLATFORM_WALLET_KEY` has one reader in the repository and it is not
     * this process. The Platform Wallet is looked up the way the worker's boot
     * looks it up — by the `platform_settings.platform_account_id` that seeding
     * wrote — and re-read per job rather than captured, so a worker started
     * before `pnpm seed` recovers without a restart.
     */
    async platformWalletId(): Promise<string> {
      const [settings] = await db
        .select({ accountId: platformSettings.platformAccountId })
        .from(platformSettings)
        .where(eq(platformSettings.id, PLATFORM_SETTINGS_ID))
        .limit(1)
      if (!settings?.accountId) {
        throw new Error(
          'platform_settings.platform_account_id is not set, so no Platform Wallet can pay for ' +
            'the verification Call. Run `pnpm seed`.',
        )
      }
      const [wallet] = await db
        .select({ id: wallets.id })
        .from(wallets)
        .where(eq(wallets.accountId, settings.accountId))
        .limit(1)
      if (!wallet) {
        throw new Error(
          `the Platform Account ${settings.accountId} has no wallet row. Run \`pnpm seed\`.`,
        )
      }
      return wallet.id
    },
  }
}
