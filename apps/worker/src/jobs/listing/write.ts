import {
  intentPrefixOf,
  listingIdOfIntent,
  toDecimalUsdt,
  type ListingStatus,
  type ListingWriteJob,
} from '@agent-desk/schemas'
import type { ChainReader, ContractCalls, Logger } from '@agent-desk/core/ports'
import { silentLogger } from '@agent-desk/core/ports'
import { checkCreatorStakeMinimum } from '@agent-desk/core/signing'
import type { ChainWriteResult, ChainWriter } from '@agent-desk/core/signing'
import type { ListingWriteRow, ListingWriteStore, ListingWriteWallet } from './write-ports.ts'

/**
 * AD-2 / AD-8, FR-7, FR-8, FR-9: the body of the pg-boss job
 * `listing.write { listing_id, intent_key, payload }`.
 *
 * Three intents share one job because they share every rule around them: they
 * all name a Listing that is already on the Registry, they are all signed by the
 * Creator wallet through `sendTx` under that wallet's lock (AD-5), and they all
 * end the same way — a confirmed receipt refreshes the chain-owned columns
 * through `refreshListingFromChain` (AD-2) and a refusal or a revert writes
 * `listings.last_error` and stops.
 *
 *   `price:<id>:<n>`  `AgentDeskRegistry.setPrice(listingId, price)`
 *   `stake:<id>:<n>`  `AgentDeskRegistry.addStake(listingId, amount)`
 *   `pause:<id>:<n>`  `AgentDeskRegistry.setPaused(listingId, paused)`
 *
 * The intent key arrives on the payload; `<n>` was allocated by the web handler
 * at enqueue and is never computed here (AD-8). That is what makes a redelivered
 * job free: `chainWrite` finds the existing `chain_tx` row and re-checks its
 * receipt instead of sending a second transaction.
 *
 * `after` carries only the field the Creator changed, which is why a stake
 * top-up arrives as the resulting total rather than as an amount — the argument
 * `addStake` takes is the difference against `before.stake`, and stating the
 * total is what makes the history row readable next to the `price:` rows around
 * it.
 */

/** The AC's three refusal sentences. The numbers follow; the phrase leads. */
export const REFUSAL = {
  stakeMinimum: 'stake below ten times price',
  topUpBalance: 'insufficient tUSD for top-up',
  gasFloor: 'creator wallet below gas floor',
} as const

export type ListingWriteIntent = 'price' | 'stake' | 'pause'

export type ListingWriteResult =
  | {
      ok: true
      listingId: string
      intentKey: string
      intent: ListingWriteIntent
      /** `sent` put a transaction on chain; `reused` found one already there. */
      outcome: 'sent' | 'reused'
      /** The status the Listing holds after the refreshed pause flags were read. */
      status: ListingStatus
    }
  | {
      ok: false
      listingId: string
      intentKey: string
      /** `refused` is terminal and on the row; `incomplete` asks for a retry. */
      outcome: 'refused' | 'incomplete'
      reason: string
      retryable: boolean
    }

export interface ListingWriteDeps {
  listings: ListingWriteStore
  chain: ChainWriter
  calls: ContractCalls
  /** Only `tokenBalance`: this job reads the Creator's tUSD and nothing else. */
  reader: Pick<ChainReader, 'tokenBalance'>
  logger?: Logger
}

export function createListingWriteJob(deps: ListingWriteDeps) {
  const logger = deps.logger ?? silentLogger

  return async function runListingWrite(job: ListingWriteJob): Promise<ListingWriteResult> {
    const listingId = job.listing_id
    const intentKey = job.intent_key

    /** Terminal: the row carries the reason and pg-boss must not retry. */
    const refused = async (reason: string, options: { write?: boolean } = {}) => {
      if (options.write !== false) await deps.listings.patch(listingId, { lastError: reason })
      logger.error({ listing_id: listingId, intent_key: intentKey, reason }, 'listing.write refused')
      return { ok: false as const, listingId, intentKey, outcome: 'refused' as const, reason, retryable: false }
    }

    /** Not terminal: nothing is written and the job asks to be redelivered. */
    const incomplete = (reason: string) => {
      logger.warn({ listing_id: listingId, intent_key: intentKey, reason }, 'listing.write incomplete')
      return { ok: false as const, listingId, intentKey, outcome: 'incomplete' as const, reason, retryable: true }
    }

    // AD-8: the key is the identity of the transaction, so a payload whose key
    // names a different Listing describes nothing this job may send.
    const intent = intentOf(intentKey)
    if (intent === null || listingIdOfIntent(intentKey) !== listingId) {
      return refused(
        `${intentKey} is not a price:, stake: or pause: intent for listing ${listingId}`,
        { write: false },
      )
    }

    const listing = await deps.listings.read(listingId)
    if (!listing) {
      // Nothing to write the reason onto, so this is reported and dropped.
      return refused(`listing ${listingId} does not exist`, { write: false })
    }
    if (!listing.registryListingId) {
      return refused(
        'this Listing has no Registry entry yet, so there is nothing on chain to change',
      )
    }

    const wallet = await deps.listings.creatorWallet(listingId)
    if (!wallet) {
      return refused('the Creator account has no System Wallet, so nothing can sign this change')
    }
    if (!wallet.readyAt) {
      return refused('the Creator wallet is not ready yet (its tUSD approval has not confirmed)')
    }

    // The policy re-checks, at job time, everything the web handler checked at
    // enqueue: the cache may have moved since, and the Creator pays the gas.
    const request = await buildRequest(intent, job, listing, wallet)
    if (!request.ok) return request.retryable ? incomplete(request.reason) : refused(request.reason)

    const registryListingId = BigInt(listing.registryListingId)
    const result = await deps.chain.chainWrite(intentKey, () => {
      const call = encode(deps.calls, registryListingId, request.value)
      return {
        walletId: wallet.id,
        to: call.to,
        data: call.data,
        // FR-9: the ten-times minimum is the Registry's own revert condition, so
        // it gets the last word inside the wallet lock as well (AD-5).
        ...(request.value.intent === 'price'
          ? { stakeCheck: { price: request.value.price, stake: BigInt(listing.stake ?? '0') } }
          : {}),
        payload: job.payload,
      }
    })

    if (result.refusal) {
      // Nothing was signed and nothing was spent. `chainWrite` has already put
      // the policy's own sentence on the row; this replaces it with the one the
      // manage page is written around, which names the single thing to change.
      return refused(policyReason(result.refusal.check, result.refusal.message))
    }

    switch (result.record.status) {
      case 'confirmed':
        return settleConfirmed(listing, intentKey, intent, result)
      case 'reverted':
        return refused(revertReason(intentKey, request.value, result))
      case 'failed':
        return refused(`${intentKey} could not be sent; see the chain_tx row for the node's answer`)
      default:
        return incomplete(
          `${intentKey} has no receipt yet${result.record.txHash ? ` (${result.record.txHash})` : ''}`,
        )
    }
  }

  /**
   * AD-2: `chainWrite` refreshed the chain-owned columns from the receipt it
   * settled. A job that resumed onto an already-confirmed row never saw that
   * receipt, so the same function is called again — never a write of our own.
   *
   * `status` is not a chain-owned column, and it is this job's to set: the
   * Registry answers with two pause flags and AD-2 fixes four statuses, so the
   * Listing is `paused` when either flag is set and `active` when neither is.
   * That is also how a top-up clears a stake pause without a second write
   * (FR-8) — `addStake` cleared `pausedByStake` on chain and the refresh brought
   * it back.
   */
  async function settleConfirmed(
    listing: ListingWriteRow,
    intentKey: string,
    intent: ListingWriteIntent,
    result: ChainWriteResult,
  ): Promise<ListingWriteResult> {
    if (result.reused || result.receipt === undefined) {
      await deps.chain.refreshListingFromChain(listing.id)
    }

    const refreshed = (await deps.listings.read(listing.id)) ?? listing
    const status = listingStatusFor(refreshed)
    // Only a Listing that is already on the marketplace may be moved between
    // `active` and `paused`; `verifying` and `failed` belong to the pipeline.
    const settled = refreshed.status === 'active' || refreshed.status === 'paused' ? status : refreshed.status
    await deps.listings.patch(listing.id, { status: settled, lastError: null })

    logger.info(
      {
        listing_id: listing.id,
        intent_key: intentKey,
        tx_hash: result.record.txHash,
        status: settled,
      },
      'listing.write settled',
    )
    return {
      ok: true,
      listingId: listing.id,
      intentKey,
      intent,
      outcome: result.reused ? 'reused' : 'sent',
      status: settled,
    }
  }

  /**
   * The three checks the story names, each against the cache as it stands now
   * rather than as it stood when the Creator pressed the button.
   */
  async function buildRequest(
    intent: ListingWriteIntent,
    job: ListingWriteJob,
    listing: ListingWriteRow,
    wallet: ListingWriteWallet,
  ): Promise<{ ok: true; value: WriteRequest } | { ok: false; reason: string; retryable?: boolean }> {
    const { before, after } = job.payload

    if (intent === 'price') {
      if (after.price === undefined) return { ok: false, reason: 'the price: intent carries no new price' }
      const price = BigInt(after.price)
      const stake = BigInt(listing.stake ?? '0')
      const minimum = checkCreatorStakeMinimum(price, stake)
      if (minimum) return { ok: false, reason: `${REFUSAL.stakeMinimum}: ${minimum.message}` }
      return { ok: true, value: { intent: 'price', price } }
    }

    if (intent === 'stake') {
      if (after.stake === undefined) return { ok: false, reason: 'the stake: intent carries no new Stake' }
      // `addStake` takes the difference, and `before` is what the cache held at
      // enqueue; a top-up that confirmed in between makes this smaller, never
      // larger, so the Creator can never be charged for the same amount twice.
      const amount = BigInt(after.stake) - BigInt(before.stake)
      if (amount <= 0n) {
        return { ok: false, reason: 'the top-up is no longer an increase; the Stake is already there' }
      }

      let balance: bigint
      try {
        balance = await deps.reader.tokenBalance(wallet.address)
      } catch (error) {
        // An RPC that did not answer is not a refusal: nothing is written and
        // the job asks to be redelivered.
        return {
          ok: false,
          retryable: true,
          reason: `could not read the Creator wallet's tUSD balance: ${message(error)}`,
        }
      }
      if (balance < amount) {
        return {
          ok: false,
          reason:
            `${REFUSAL.topUpBalance}: the Creator wallet holds ${toDecimalUsdt(balance)} tUSD ` +
            `and the top-up is ${toDecimalUsdt(amount)} tUSD.`,
        }
      }
      return { ok: true, value: { intent: 'stake', amount } }
    }

    if (after.paused === undefined) return { ok: false, reason: 'the pause: intent carries no pause flag' }
    return { ok: true, value: { intent: 'pause', paused: after.paused } }
  }
}

// ------------------------------------------------------------------- helpers

type WriteRequest =
  | { intent: 'price'; price: bigint }
  | { intent: 'stake'; amount: bigint }
  | { intent: 'pause'; paused: boolean }

function encode(calls: ContractCalls, registryListingId: bigint, request: WriteRequest) {
  switch (request.intent) {
    case 'price':
      return calls.registrySetPrice(registryListingId, request.price)
    case 'stake':
      return calls.registryAddStake(registryListingId, request.amount)
    case 'pause':
      return calls.registrySetPaused(registryListingId, request.paused)
  }
}

/**
 * The signing policy's own sentences, prefixed with the phrase the manage page
 * and the story are written around. Both halves matter: the phrase says which
 * rule refused, the message says by how much.
 */
export function policyReason(check: string, message: string): string {
  if (check === 'gas_floor') return `${REFUSAL.gasFloor}: ${message}`
  if (check === 'creator_stake_minimum') return `${REFUSAL.stakeMinimum}: ${message}`
  return message
}

/** AD-2: two pause flags on chain, four statuses off it. */
export function listingStatusFor(flags: {
  pausedByCreator: boolean
  pausedByStake: boolean
}): ListingStatus {
  return flags.pausedByCreator || flags.pausedByStake ? 'paused' : 'active'
}

/** The `price:`, `stake:` and `pause:` prefixes, and nothing else. */
export function intentOf(intentKey: string): ListingWriteIntent | null {
  const prefix = intentPrefixOf(intentKey)
  return prefix === 'price' || prefix === 'stake' || prefix === 'pause' ? prefix : null
}

/**
 * A revert after every check above passed means the chain disagreed with the
 * cache, so the reason names the condition the Registry actually enforces for
 * this intent rather than repeating the transaction hash twice.
 */
function revertReason(intentKey: string, request: WriteRequest, result: ChainWriteResult): string {
  const where = result.record.txHash ? ` (${result.record.txHash})` : ''
  const why =
    request.intent === 'price'
      ? ' The Registry refuses a price whose ten-times minimum is above the Stake it holds.'
      : request.intent === 'stake'
        ? ' The Registry pulls the top-up with transferFrom, which needs both the tUSD and the allowance.'
        : ' The Registry accepts setPaused only from the Listing’s creator.'
  return `${intentKey} reverted on chain${where}.${why}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
