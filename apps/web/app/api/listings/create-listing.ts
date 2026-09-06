import { listings, type Database } from '@agent-desk/db'
import { newId, type CreateListingRequest, type ErrorCode } from '@agent-desk/schemas'
import { validateListing } from './listing-rules.ts'

/**
 * `POST /api/listings` — FR-10 / FR-14, the write behind the listing form
 * (Story 3.3).
 *
 * The field rules live in `listing-rules.ts`, where the browser can apply the
 * same ones; what is here is everything that needs the database: who may list an
 * `execution` Agent, whether the Creator's System Wallet can pay a Stake yet,
 * the row itself, and the one job that moves it.
 *
 * AD-2: this writes the form-owned columns and nothing else. `price`, `stake`,
 * `reputation_bps`, the pause flags, `agent_id` and `registry_listing_id` are
 * chain-owned and stay null until `refreshListingFromChain` fills them from the
 * `list:` receipt. The row starts `verifying`, and `listing.verify` — published
 * with `listing_id` as its singleton key, so a double submit is one pipeline —
 * is what moves it from there.
 *
 * AD-13: amounts are stored as base-unit integer strings and addresses
 * lower-case.
 */

// ----------------------------------------------------------------- the write

export interface CreateListingDeps {
  db: Database
  /** AD-4/AD-8: `listing.verify` with `listing_id` as the singleton key. */
  publish(listingId: string): Promise<void>
}

export interface Refusal {
  code: ErrorCode
  message: string
  details?: Record<string, unknown>
}

export type CreateListingResult =
  | { ok: true; listingId: string }
  | { ok: false; refusal: Refusal }

export async function createListing(
  deps: CreateListingDeps,
  accountId: string,
  input: CreateListingRequest,
): Promise<CreateListingResult> {
  const validated = validateListing(input)
  if (!validated.ok) {
    return {
      ok: false,
      refusal: {
        code: 'validation_failed',
        message: 'the listing form has errors',
        details: { fields: validated.errors },
      },
    }
  }
  const listing = validated.value

  const [wallet, settings] = await Promise.all([
    deps.db.query.wallets.findFirst({
      where: (row, { eq }) => eq(row.accountId, accountId),
      columns: { address: true, readyAt: true },
    }),
    deps.db.query.platformSettings.findFirst({
      where: (row, { eq }) => eq(row.id, 1),
      columns: { platformAccountId: true },
    }),
  ])

  // FR-14: an execution Agent places real orders, so only the Platform Account
  // may list one. This is checked before the wallet, because it is a refusal
  // about who is asking rather than about their wallet.
  if (listing.type === 'execution' && settings?.platformAccountId !== accountId) {
    return {
      ok: false,
      refusal: {
        code: 'refused_execution_type',
        message: 'only the Platform Account may list an execution Agent',
      },
    }
  }

  // AD-5: `ready_at` is set from the `approve:<wallet_id>` receipt, and
  // `list(...)` pulls the Stake through exactly that allowance. Listing before
  // it confirms would fail on chain, so the form says so instead.
  if (!wallet || !wallet.readyAt) {
    return {
      ok: false,
      refusal: {
        code: 'wallet_not_ready',
        message:
          wallet === undefined
            ? 'your System Wallet is still being created; try again in a moment'
            : 'your System Wallet is not ready yet (its tUSD approval has not confirmed)',
      },
    }
  }

  const listingId = newId('listing')
  await deps.db.insert(listings).values({
    id: listingId,
    creatorAccountId: accountId,
    name: listing.name,
    description: listing.description,
    type: listing.type,
    endpoint: listing.endpoint,
    declaredPrice: listing.price,
    declaredStake: listing.stake,
    payoutWallet: listing.payoutWallet ?? wallet.address,
    status: 'verifying',
    // FR-11: a sample Call to an execution Agent would place a real order, so
    // that one Type — and only that one, from a path FR-14 already restricts to
    // the Platform Account — is listed without one. The seed script is the only
    // other writer of this flag.
    skipVerification: listing.type === 'execution',
  })

  try {
    await deps.publish(listingId)
  } catch (error) {
    // The insert above committed, so the Listing exists and the Creator can see
    // it; what is missing is the job that would move it out of `verifying`. The
    // row is left exactly as it is rather than patched to `failed`, because a
    // `send` that reported an error may still have enqueued the job, and two
    // writers racing over one status is worse than one honest 500. In practice
    // this needs Postgres to fail between two statements against it.
    return {
      ok: false,
      refusal: {
        code: 'internal_error',
        message: `the listing could not be queued for verification: ${message(error)}`,
        details: { listing_id: listingId },
      },
    }
  }

  return { ok: true, listingId }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
