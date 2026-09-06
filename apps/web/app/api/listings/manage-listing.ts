import type { Database } from '@agent-desk/db'
import { intentKeys, type ListingWriteJob } from '@agent-desk/schemas'
import type { Refusal } from './create-listing.ts'
import { decidePause, decidePrice, decideTopUp, isPaused, type ListingTerms } from './manage-rules.ts'

/**
 * `POST /api/listings/<id>/price`, `/stake` and `/pause` — the Creator's three
 * changes to a Listing that is already on the Registry (Story 3.6, FR-7, FR-8,
 * FR-9).
 *
 * All three do exactly the same four things, which is why they are one
 * function: check that the caller owns a Listing that is on chain, apply the
 * pure rule, allocate the AD-8 intent key, and publish `listing.write`. Nothing
 * here signs and nothing here writes a `listings` column — AD-1 keeps the key in
 * the worker, and AD-2 keeps `price`, `stake` and the pause flags in
 * `refreshListingFromChain`'s hands. The 202 carries the intent key so the page
 * can watch that exact transaction land.
 *
 * `<n>` is `Date.now()`, allocated here and carried in the payload, never
 * computed by the job (AD-8): a redelivered job must rebuild the same key or it
 * would send a second transaction.
 */

export interface ManageListingDeps {
  db: Database
  /** AD-4/AD-8: `listing.write`, singleton-keyed on the intent key. */
  publish(job: ListingWriteJob): Promise<void>
}

export type ManageRequest =
  | { intent: 'price'; price: string }
  | { intent: 'stake'; amount: string }
  | { intent: 'pause'; paused: boolean }

export type ManageResult =
  | { ok: true; intentKey: string; job: ListingWriteJob }
  | { ok: false; refusal: Refusal }

export async function requestListingWrite(
  deps: ManageListingDeps,
  accountId: string,
  listingId: string,
  request: ManageRequest,
  now: number = Date.now(),
): Promise<ManageResult> {
  const row = await deps.db.query.listings.findFirst({
    where: (listing, { eq }) => eq(listing.id, listingId),
    columns: {
      id: true,
      creatorAccountId: true,
      status: true,
      registryListingId: true,
      price: true,
      stake: true,
      pausedByCreator: true,
      pausedByStake: true,
    },
  })

  // A Listing this session does not own is 404, never 403, so the route never
  // confirms that an id it refuses to serve exists — the rule the listing page
  // and `requireWorkflowOwner` already apply.
  if (!row || row.creatorAccountId !== accountId) {
    return { ok: false, refusal: { code: 'not_found', message: `no listing ${listingId}` } }
  }

  // AD-2: `active` and `paused` are the two statuses with a Registry entry
  // behind them. A `verifying` Listing has nothing to change yet and a `failed`
  // one never will.
  if (row.registryListingId === null || (row.status !== 'active' && row.status !== 'paused')) {
    return {
      ok: false,
      refusal: {
        code: 'conflict',
        message: `this Listing is ${row.status}, so it has no Registry entry to change yet`,
        details: { status: row.status },
      },
    }
  }

  const terms: ListingTerms = {
    price: BigInt(row.price ?? '0'),
    stake: BigInt(row.stake ?? '0'),
    pausedByCreator: row.pausedByCreator,
    pausedByStake: row.pausedByStake,
  }

  // AD-8: `before` is the cache as it stands at enqueue, and `after` carries
  // only the field this intent changes. A stake top-up states the resulting
  // total, so the history row reads like the price rows around it and the job
  // can take the difference `addStake` actually needs.
  const before = {
    price: terms.price.toString(),
    stake: terms.stake.toString(),
    paused: isPaused(terms),
  }

  const change = decide(request, terms)
  if (!change.ok) return change

  const n = now
  const intentKey = change.intentKey(listingId, n)
  const job: ListingWriteJob = {
    listing_id: listingId,
    intent_key: intentKey,
    payload: { listing_id: listingId, before, after: change.after },
  }

  await deps.publish(job)
  return { ok: true, intentKey, job }
}

type Change = {
  ok: true
  intentKey: (listingId: string, n: number) => string
  after: ListingWriteJob['payload']['after']
}

function decide(request: ManageRequest, terms: ListingTerms): Change | { ok: false; refusal: Refusal } {
  if (request.intent === 'price') {
    const decision = decidePrice(request.price, terms)
    if (!decision.ok) return decision
    return { ok: true, intentKey: intentKeys.price, after: { price: decision.value.toString() } }
  }

  if (request.intent === 'stake') {
    const decision = decideTopUp(request.amount)
    if (!decision.ok) return decision
    return {
      ok: true,
      intentKey: intentKeys.stake,
      after: { stake: (terms.stake + decision.value).toString() },
    }
  }

  const decision = decidePause(request.paused, terms)
  if (!decision.ok) return decision
  return { ok: true, intentKey: intentKeys.pause, after: { paused: decision.value } }
}
