import { z } from 'zod'
import {
  addressSchema,
  agentTypeSchema,
  callStatusSchema,
  chainTxView,
  intentKeys,
  listingResponse,
  toDecimalUsdt,
  type ListingStatus,
} from '@agent-desk/schemas'

/**
 * `GET /api/listings/<id>` — the body the listing page polls, and the narration
 * it draws (Story 3.3, FR-12, AD-12).
 *
 * A Creator watching a brand-new Listing is watching three things happen in
 * order: the platform pays their endpoint, an ERC-8004 identity is minted, and
 * the Registry entry locks their Stake. A spinner says none of that. So the
 * route answers each step with its own state and one line of detail, derived
 * here from the rows the pipeline already writes — the verification `calls` row
 * and the `identity:` and `list:` `chain_tx` rows — rather than from a fourth
 * column somebody would have to keep in step with them.
 *
 * The derivation is pure and lives next to the schema so the page, the route and
 * the test all read the same rules.
 *
 * ┌─ AD-14 ────────────────────────────────────────────────────────────────┐
 * │ These schemas belong in `packages/schemas/src/api`, which this story    │
 * │ does not own. They are declared here so the route and its client parse  │
 * │ one definition; moving them is a one-line import change on both sides.  │
 * └────────────────────────────────────────────────────────────────────────┘
 */

const baseUnits = z.string().regex(/^(?:0|[1-9]\d*)$/)
const txHash = z.string().regex(/^0x[0-9a-f]{64}$/)
const isoDate = z.iso.datetime({ offset: false })

export const LISTING_STEPS = ['verification', 'identity', 'list'] as const
export type ListingStep = (typeof LISTING_STEPS)[number]

/**
 * `waiting` is "not started"; `skipped` is the one step that may legitimately
 * never run. There is no `reverted`: a reverted transaction is a failed step,
 * and the reason says which.
 */
export const LISTING_STEP_STATES = ['waiting', 'running', 'done', 'failed', 'skipped'] as const
export type ListingStepState = (typeof LISTING_STEP_STATES)[number]

export const listingStepView = z.object({
  step: z.enum(LISTING_STEPS),
  state: z.enum(LISTING_STEP_STATES),
  /** One sentence under the step: what landed, or why it did not. */
  detail: z.string().nullable(),
  /** The payment for step 1, the transaction for steps 2 and 3. */
  tx_hash: txHash.nullable(),
})

/** The verification Call itself (AD-3): one row, `kind = 'verification'`. */
export const verificationCallView = z.object({
  id: z.string(),
  status: callStatusSchema,
  node_type: agentTypeSchema,
  locked_price: baseUnits,
  locked_pay_to: addressSchema,
  attempt: z.number().int(),
  failure_reason: z.string().nullable(),
  payment_tx_hash: txHash.nullable(),
  started_at: isoDate.nullable(),
  ended_at: isoDate.nullable(),
})

export const listingDetailResponse = listingResponse.extend({
  /** What the form declared, which is what the pipeline is trying to put on chain. */
  declared_price: baseUnits,
  declared_stake: baseUnits,
  /** FR-11: true only for an execution Agent, and only the platform lists one. */
  skip_verification: z.boolean(),
  /** Whether this session may resubmit it (Story 3.6 adds the manage actions). */
  is_creator: z.boolean(),
  verification: verificationCallView.nullable(),
  chain_tx: z.array(chainTxView),
  steps: z.array(listingStepView),
  updated_at: isoDate,
})

/** The 201 body of `POST /api/listings`; the form parses it before navigating. */
export const createListingResponse = z.object({ listing_id: z.string() })

export type ListingStepView = z.infer<typeof listingStepView>
export type VerificationCallView = z.infer<typeof verificationCallView>
export type ChainTxView = z.infer<typeof chainTxView>
export type ListingDetailResponse = z.infer<typeof listingDetailResponse>

// ------------------------------------------------------------- derivation

export interface ProgressSource {
  listingId: string
  status: ListingStatus
  lastError: string | null
  skipVerification: boolean
  declaredStake: string
  agentId: string | null
  registryListingId: string | null
  verification: VerificationCallView | null
  chainTx: readonly ChainTxView[]
}

/**
 * FR-11: an execution Agent is listed without a sample Call, because the sample
 * would place a real order. Said in the UI rather than left blank.
 */
const SKIPPED_DETAIL =
  'skipped: a sample Call to an execution Agent would place a real order, so the platform does not make one'

/** AD-6: the paid Handshake in the words a Creator can act on. */
const CALL_DETAIL: Record<string, string> = {
  pending: 'asking your endpoint what it charges',
  paid_awaiting_result: 'paid, waiting for the answer',
}

export function deriveSteps(source: ProgressSource): ListingStepView[] {
  const stake = toDecimalUsdt(source.declaredStake)

  const verification = verificationStep(source)
  const identity = chainStep('identity', source, intentKeys.identity(source.listingId), verification, {
    waiting: 'the ERC-8004 identity is minted once the verification Call is paid',
    running: 'minting the ERC-8004 identity around this Listing\u2019s agentURI',
    done:
      source.agentId === null
        ? 'identity minted'
        : `identity #${source.agentId} minted around this Listing\u2019s agentURI`,
  })
  // The Registry entry is reached only because the identity exists, so a missing
  // `list:` row after a failed identity is "never attempted", not "still coming".
  const list = chainStep('list', source, intentKeys.list(source.listingId), identity, {
    waiting: `the Registry entry locks ${stake} tUSD of Stake`,
    running: `locking ${stake} tUSD of Stake in the Registry`,
    done:
      source.registryListingId === null
        ? 'listed on the Registry'
        : `listed as Registry entry #${source.registryListingId}, with ${stake} tUSD of Stake locked`,
  })

  return [verification, identity, list]
}

function verificationStep(source: ProgressSource): ListingStepView {
  if (source.skipVerification) {
    return { step: 'verification', state: 'skipped', detail: SKIPPED_DETAIL, tx_hash: null }
  }

  const call = source.verification
  if (call === null) {
    // The row is inserted by the job itself, so its absence means either the job
    // has not started or it refused before spending anything — the exhausted
    // verification cap, or a Creator wallet that is not ready.
    if (source.status === 'failed') {
      return { step: 'verification', state: 'failed', detail: source.lastError, tx_hash: null }
    }
    return {
      step: 'verification',
      state: 'running',
      detail: 'queued: the platform is about to call your endpoint and pay for the answer',
      tx_hash: null,
    }
  }

  if (call.status === 'succeeded') {
    return {
      step: 'verification',
      state: 'done',
      detail:
        `paid ${toDecimalUsdt(call.locked_price)} tUSD to your payout wallet and the answer ` +
        `matched the ${call.node_type} output schema`,
      tx_hash: call.payment_tx_hash,
    }
  }
  if (call.status === 'pending' || call.status === 'paid_awaiting_result') {
    return {
      step: 'verification',
      state: 'running',
      detail: CALL_DETAIL[call.status] ?? null,
      tx_hash: call.payment_tx_hash,
    }
  }
  if (call.status === 'skipped') {
    return { step: 'verification', state: 'skipped', detail: SKIPPED_DETAIL, tx_hash: null }
  }
  return {
    step: 'verification',
    state: 'failed',
    // `failure_reason` is what FR-12 names; `last_error` is the same sentence
    // copied onto the Listing, and is the fallback for a row written before it.
    detail: call.failure_reason ?? source.lastError,
    tx_hash: call.payment_tx_hash,
  }
}

function chainStep(
  step: ListingStep,
  source: ProgressSource,
  intentKey: string,
  previous: ListingStepView,
  detail: { waiting: string; running: string; done: string },
): ListingStepView {
  const row = source.chainTx.find((candidate) => candidate.intent_key === intentKey)

  if (row === undefined) {
    // AD-2: each step is reached only because the previous one succeeded, so a
    // missing row after a refusal is "never attempted", not "still coming".
    if (previous.state === 'failed' || source.status === 'failed') {
      return { step, state: 'waiting', detail: 'not reached', tx_hash: null }
    }
    return { step, state: 'waiting', detail: emptyToNull(detail.waiting), tx_hash: null }
  }

  if (row.status === 'confirmed') {
    return { step, state: 'done', detail: emptyToNull(detail.done), tx_hash: row.tx_hash }
  }
  if (row.status === 'pending') {
    return { step, state: 'running', detail: emptyToNull(detail.running), tx_hash: row.tx_hash }
  }
  return { step, state: 'failed', detail: source.lastError, tx_hash: row.tx_hash }
}

function emptyToNull(value: string): string | null {
  return value.length === 0 ? null : value
}

/** AD-12: the page polls while the pipeline can still move, and stops after. */
export function isListingSettled(status: ListingStatus): boolean {
  return status !== 'verifying'
}
