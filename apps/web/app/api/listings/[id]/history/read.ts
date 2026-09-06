import { db } from '@agent-desk/db'
import {
  intentKeys,
  type AgentType,
  type AgentVerificationCall,
  type ListingStatus,
} from '@agent-desk/schemas'
import type { ChainTxView } from '../../listing-progress.ts'

/**
 * The read behind `GET /api/listings/<id>/history`.
 *
 * ┌─ AD-2 ─────────────────────────────────────────────────────────────────┐
 * │ Nothing here reads the chain. Every value on this page is either a     │
 * │ `chain_tx` row AD-8 wrote before it sent the transaction, or a column  │
 * │ of the `listings` cache whose only writer is                           │
 * │ `refreshListingFromChain`. An Agent's record is therefore the          │
 * │ Registry's own record, without an RPC round trip per visitor.          │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * `apps/web` depends on `@agent-desk/db` but not on `drizzle-orm`, so these go
 * through the relational query API, whose operators arrive as callback
 * arguments — which is also why the Call ids are a separate small read rather
 * than a correlated subquery.
 */

export interface ListingHistorySource {
  listingId: string
  type: AgentType
  status: ListingStatus
  creatorAccountId: string
  chainTx: ChainTxView[]
  verification: AgentVerificationCall | null
}

/** The four keys that are matched by prefix; `<n>` is an epoch millisecond (AD-8). */
const PREFIX_INTENTS = ['price', 'stake', 'pause', 'reputation'] as const

export async function readListingHistory(listingId: string): Promise<ListingHistorySource | null> {
  const listing = await db().query.listings.findFirst({
    where: (row, { eq }) => eq(row.id, listingId),
    columns: { id: true, type: true, status: true, creatorAccountId: true },
  })
  if (!listing) return null

  const [callIds, verification] = await Promise.all([
    readCallIds(listingId),
    readVerificationCall(listingId),
  ])

  return {
    listingId: listing.id,
    type: listing.type,
    status: listing.status,
    creatorAccountId: listing.creatorAccountId,
    chainTx: await readChainTx(listingId, callIds),
    verification,
  }
}

/**
 * AD-8 keys a Slash by the Call it settles, `slash:<call_id>`, not by the
 * Listing, so the Listing's Calls are what name its Slashes. Only a `research`
 * or `risk` Call is ever scored (AD-9), and a Listing has at most one Slash per
 * Call, so this stays small in the MVP.
 */
async function readCallIds(listingId: string): Promise<string[]> {
  const rows = await db().query.calls.findMany({
    where: (row, { eq }) => eq(row.listingId, listingId),
    columns: { id: true },
  })
  return rows.map((row) => row.id)
}

/**
 * AD-3: one `calls` row with `kind = 'verification'`, no `run_id`, and this
 * `listing_id`. AD-9 never scores it, so it is the verification record and never
 * a settlement.
 */
async function readVerificationCall(listingId: string): Promise<AgentVerificationCall | null> {
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
      request: true,
      response: true,
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
    request: call.request ?? null,
    response: call.response ?? null,
    payment_tx_hash: call.paymentTxHash,
    started_at: call.startedAt?.toISOString() ?? null,
    ended_at: call.endedAt?.toISOString() ?? null,
  }
}

/**
 * The six intents of the record. `list:` and each `slash:<call_id>` are exact
 * keys; the four Creator- and settlement-allocated intents end in an epoch
 * millisecond or a settlement id and are matched by prefix, which is exactly
 * what `chain_tx_intent_key_pattern_idx` serves.
 *
 * `identity:` is left out on purpose: it is a step of the Creator's listing
 * pipeline, which `/listings/<id>` narrates, not a change to the Agent's terms.
 */
async function readChainTx(listingId: string, callIds: readonly string[]): Promise<ChainTxView[]> {
  const exactKeys = [intentKeys.list(listingId), ...callIds.map((id) => intentKeys.slash(id))]
  const prefixes = PREFIX_INTENTS.map((prefix) => `${prefix}:${listingId}:%`)

  const rows = await db().query.chainTx.findMany({
    where: (row, { inArray, like, or }) =>
      or(inArray(row.intentKey, exactKeys), ...prefixes.map((prefix) => like(row.intentKey, prefix))),
    orderBy: (row, { asc }) => [asc(row.createdAt), asc(row.intentKey)],
  })

  return rows.map((row) => ({
    intent_key: row.intentKey,
    status: row.status,
    tx_hash: row.txHash,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    created_at: row.createdAt.toISOString(),
    confirmed_at: row.confirmedAt?.toISOString() ?? null,
  }))
}
