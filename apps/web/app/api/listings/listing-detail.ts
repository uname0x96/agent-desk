import { db } from '@agent-desk/db'
import { intentKeys } from '@agent-desk/schemas'
import { toListingResponse } from './listings-view.ts'
import {
  deriveSteps,
  type ChainTxView,
  type ListingDetailResponse,
  type VerificationCallView,
} from './listing-progress.ts'
import { selectListingById } from './query.ts'

/**
 * The read behind `GET /api/listings/<id>`.
 *
 * `toListingResponse` supplies every field a marketplace card has, so the
 * listing page and the card can never disagree; this adds the three things only
 * the Creator watching the pipeline needs — what the form declared, the
 * verification Call, and the two `chain_tx` rows — and the derived narration.
 *
 * AD-2: nothing here reads the chain. `price`, `stake` and the rest are the
 * chain-owned cache, whose only writer is `refreshListingFromChain`.
 */

export interface ListingDetail {
  body: ListingDetailResponse
  creatorAccountId: string
  status: ListingDetailResponse['status']
}

export async function readListingDetail(
  listingId: string,
  sessionAccountId: string,
): Promise<ListingDetail | null> {
  const row = await selectListingById(listingId)
  if (!row) return null

  const [declared, verification, chainTx] = await Promise.all([
    // The columns `ListingRow` does not carry. A second read of one row by
    // primary key, rather than a change to `query.ts`, which the marketplace
    // story is editing at the same time.
    db().query.listings.findFirst({
      where: (listing, { eq }) => eq(listing.id, listingId),
      columns: { declaredPrice: true, declaredStake: true, skipVerification: true, updatedAt: true },
    }),
    readVerificationCall(listingId),
    readChainTx(listingId),
  ])
  if (!declared) return null

  const body: ListingDetailResponse = {
    ...toListingResponse(row),
    declared_price: declared.declaredPrice,
    declared_stake: declared.declaredStake,
    skip_verification: declared.skipVerification,
    is_creator: row.creatorAccountId === sessionAccountId,
    verification,
    chain_tx: chainTx,
    steps: deriveSteps({
      listingId,
      status: row.status,
      lastError: row.lastError,
      skipVerification: declared.skipVerification,
      declaredStake: declared.declaredStake,
      agentId: row.agentId,
      registryListingId: row.registryListingId,
      verification,
      chainTx,
    }),
    updated_at: declared.updatedAt.toISOString(),
  }

  return { body, creatorAccountId: row.creatorAccountId, status: row.status }
}

/**
 * AD-3: a verification Call is a `calls` row with `kind = 'verification'`, no
 * `run_id`, and this `listing_id`. The pipeline writes at most one per Listing.
 */
async function readVerificationCall(listingId: string): Promise<VerificationCallView | null> {
  const call = await db().query.calls.findFirst({
    where: (row, { and, eq }) => and(eq(row.listingId, listingId), eq(row.kind, 'verification')),
    columns: {
      id: true,
      status: true,
      nodeType: true,
      lockedPrice: true,
      lockedPayTo: true,
      attempt: true,
      failureReason: true,
      paymentTxHash: true,
      startedAt: true,
      endedAt: true,
    },
  })
  if (!call) return null

  return {
    id: call.id,
    status: call.status,
    node_type: call.nodeType,
    locked_price: call.lockedPrice,
    locked_pay_to: call.lockedPayTo.toLowerCase(),
    attempt: call.attempt,
    failure_reason: call.failureReason,
    payment_tx_hash: call.paymentTxHash,
    started_at: call.startedAt?.toISOString() ?? null,
    ended_at: call.endedAt?.toISOString() ?? null,
  }
}

/** AD-8: exactly the two intents this pipeline may create, in step order. */
async function readChainTx(listingId: string): Promise<ChainTxView[]> {
  const keys = [intentKeys.identity(listingId), intentKeys.list(listingId)]
  const rows = await db().query.chainTx.findMany({
    where: (row, { inArray }) => inArray(row.intentKey, keys),
  })

  return keys.flatMap((key) => {
    const row = rows.find((candidate) => candidate.intentKey === key)
    if (!row) return []
    return [
      {
        intent_key: row.intentKey,
        status: row.status,
        tx_hash: row.txHash,
        payload: (row.payload ?? {}) as Record<string, unknown>,
        created_at: row.createdAt.toISOString(),
        confirmed_at: row.confirmedAt?.toISOString() ?? null,
      },
    ]
  })
}
