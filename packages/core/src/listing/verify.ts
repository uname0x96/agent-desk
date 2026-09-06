import {
  intentKeys,
  toDecimalUsdt,
  type ListingStatus,
  type ListingVerifyJob,
} from '@agent-desk/schemas'
import type { ChainReader, Clock, ContractCalls, Logger } from '../ports/index.ts'
import { silentLogger, systemClock } from '../ports/index.ts'
import type { ChainWriteResult, ChainWriter } from '../signing/chain-writer.ts'
import { checkCreatorStakeMinimum } from '../signing/policy.ts'
import { decideAgentUri } from './agent-uri.ts'
import type {
  CreatorWallet,
  ListingPipelineRow,
  ListingPipelineStore,
  ListingReceiptSource,
  VerificationCall,
} from './ports.ts'

/**
 * AD-2 / FR-5..FR-7, FR-12: the body of the pg-boss job
 * `listing.verify { listing_id }` (exclusive queue, singleton key `listing_id`).
 *
 * One pipeline, three steps, each one reached only because the previous one
 * succeeded:
 *
 *   1. the verification Call — skipped only when `skip_verification` is set,
 *      which is a flag the seed script alone may write. Story 3.4 fills the
 *      `VerificationCall` port with the real paid Handshake;
 *   2. `identity:<listing_id>` — `IdentityRegistry.register(agentURI)` signed by
 *      the Creator wallet, whose `Registered` event carries the `agentId`;
 *   3. `list:<listing_id>` — `AgentDeskRegistry.list(agentId, type, price,
 *      endpoint, payTo, stake)`, also signed by the Creator wallet, which pulls
 *      the Stake in tUSD.
 *
 * The order is the substance. An identity is an ERC-8004 token minted around an
 * `agentURI`; minting one for an Agent that then fails verification would leave
 * a token nobody can withdraw and a Listing that cannot be listed under a second
 * identity. So step 1 resolves completely — and the two conditions the Registry
 * reverts on are checked — before `chainWrite` is called even once.
 *
 * After the confirmed `list:` receipt, `refreshListingFromChain` (AD-2's sole
 * writer of the chain-owned columns) has filled the cache and the Listing
 * becomes `active`. Every refusal along the way sets `status = 'failed'` with
 * `last_error` saying why, in words a Creator can act on.
 *
 * Redelivery is safe at every point: steps 2 and 3 go through `chainWrite`,
 * which finds the existing `chain_tx` row and re-checks its receipt rather than
 * sending (AD-8), and the `agentURI` a previous run decided lives in that row's
 * payload, so it can never be decided a second time.
 */

export const LISTING_VERIFY_STEPS = ['verification', 'identity', 'list'] as const
export type ListingVerifyStep = (typeof LISTING_VERIFY_STEPS)[number]

export type StepOutcome =
  /** A transaction (or a Call) was made in this run. */
  | 'sent'
  /** A `chain_tx` row already existed; nothing was sent (AD-8). */
  | 'reused'
  /** `skip_verification`; the only step that may be skipped. */
  | 'skipped'

export type ListingVerifySteps = Partial<Record<ListingVerifyStep, StepOutcome>>

export type ListingVerifyResult =
  | {
      ok: true
      listingId: string
      /** `listed` means this run put it on chain; `already_listed` is a redelivery. */
      outcome: 'listed' | 'already_listed'
      status: ListingStatus
      agentId: string | null
      registryListingId: string | null
      /** The frozen `agentURI`, read back from the `identity:` payload. */
      agentUri: string | null
      steps: ListingVerifySteps
    }
  | {
      ok: false
      listingId: string
      /** `failed` is terminal and written to the row; `incomplete` asks for a retry. */
      outcome: 'failed' | 'incomplete'
      failedAt: ListingVerifyStep
      reason: string
      /** True when re-running the job can still succeed (a receipt that is late). */
      retryable: boolean
      steps: ListingVerifySteps
    }

export interface ListingVerifyConfig {
  /**
   * AD-2: `PUBLIC_BASE_URL`. Empty or absent means every `agentURI` decided from
   * now on is a `data:` URI. It is read per build, never cached, so an Operator
   * who sets it only has to restart the worker.
   */
  publicBaseUrl?: string | undefined
}

export interface ListingVerifyDeps {
  listings: ListingPipelineStore
  chain: ChainWriter
  calls: ContractCalls
  receipts: ListingReceiptSource
  /** Only `tokenBalance`: this job reads the Creator's tUSD and nothing else. */
  reader: Pick<ChainReader, 'tokenBalance'>
  /** The Story 3.4 seam. Reached only for a listing without `skip_verification`. */
  verification: VerificationCall
  config: ListingVerifyConfig
  clock?: Clock
  logger?: Logger
}

export function createListingVerifyJob(deps: ListingVerifyDeps) {
  const logger = deps.logger ?? silentLogger
  const clock = deps.clock ?? systemClock

  return async function runListingVerify(job: ListingVerifyJob): Promise<ListingVerifyResult> {
    const listingId = job.listing_id
    const steps: ListingVerifySteps = {}

    /** Terminal: the row records why, and pg-boss must not retry. */
    const failed = async (
      failedAt: ListingVerifyStep,
      reason: string,
      options: { write?: boolean } = {},
    ): Promise<ListingVerifyResult> => {
      if (options.write !== false) await deps.listings.writeStatus(listingId, 'failed', reason)
      logger.error({ listing_id: listingId, step: failedAt, reason }, 'listing.verify failed')
      return { ok: false, listingId, outcome: 'failed', failedAt, reason, retryable: false, steps }
    }

    /** Not terminal: the row stays `verifying` and the job asks to be redelivered. */
    const incomplete = (failedAt: ListingVerifyStep, reason: string): ListingVerifyResult => {
      logger.warn({ listing_id: listingId, step: failedAt, reason }, 'listing.verify incomplete')
      return { ok: false, listingId, outcome: 'incomplete', failedAt, reason, retryable: true, steps }
    }

    const listing = await deps.listings.read(listingId)
    if (!listing) {
      // Nothing to write the reason onto, so this is reported and dropped.
      return failed('verification', `listing ${listingId} does not exist`, { write: false })
    }

    // AD-8: a job redelivered after the Listing reached the chain does nothing.
    // `paused` counts too — Story 3.6 may have paused it since.
    if (listing.status === 'active' || listing.status === 'paused') {
      logger.info({ listing_id: listingId, status: listing.status }, 'listing is already on chain')
      return {
        ok: true,
        listingId,
        outcome: 'already_listed',
        status: listing.status,
        agentId: listing.agentId,
        registryListingId: listing.registryListingId,
        agentUri: null,
        steps,
      }
    }

    const wallet = await deps.listings.creatorWallet(listingId)
    if (!wallet) {
      return failed(
        'verification',
        'the Creator account has no System Wallet yet, so nothing can sign the identity',
      )
    }
    if (!wallet.readyAt) {
      // AD-5: `ready_at` comes from `approve:<wallet_id>`, and `list(...)` pulls
      // the Stake through that very allowance.
      return failed(
        'verification',
        'the Creator wallet is not ready yet (its tUSD approval has not confirmed)',
      )
    }

    // ------------------------------------------------------ 1. verification
    const verification = await runVerification(listing)
    if (!verification.ok) return failed('verification', verification.reason)
    steps.verification = verification.outcome

    // ------------------------------------------- the two `list` revert causes
    //
    // Checked here, before anything is minted. The Registry reverts on both, and
    // a revert after step 2 would strand an identity; refusing now costs the
    // Creator nothing and says which number to change.
    const price = BigInt(listing.declaredPrice)
    const stake = BigInt(listing.declaredStake)

    const minimum = checkCreatorStakeMinimum(price, stake)
    if (minimum) return failed('list', minimum.message)

    let balance: bigint
    try {
      balance = await deps.reader.tokenBalance(wallet.address)
    } catch (error) {
      return incomplete('list', `could not read the Creator wallet's tUSD balance: ${message(error)}`)
    }
    if (balance < stake) {
      return failed(
        'list',
        `insufficient tUSD for the Stake: the Creator wallet holds ${toDecimalUsdt(balance)} tUSD ` +
          `and the Stake is ${toDecimalUsdt(stake)} tUSD.`,
      )
    }

    // ---------------------------------------------------------- 2. identity
    const identity = await runIdentity(listing, wallet)
    if (!identity.ok) {
      return identity.retryable
        ? incomplete('identity', identity.reason)
        : failed('identity', identity.reason)
    }
    steps.identity = identity.outcome

    // -------------------------------------------------------------- 3. list
    const listed = await runList(listing, wallet, identity.agentId, balance)
    if (!listed.ok) {
      return listed.retryable ? incomplete('list', listed.reason) : failed('list', listed.reason)
    }
    steps.list = listed.outcome

    // AD-2: the chain-owned columns are already in place — `chainWrite` called
    // `refreshListingFromChain` on the confirmed receipt, and `runList` made
    // sure of it on the resumed path. `active` is the last thing written, so a
    // Listing is never visible on the marketplace before its Registry entry is
    // in the cache.
    await deps.listings.writeStatus(listingId, 'active', null)
    logger.info(
      {
        listing_id: listingId,
        agent_id: identity.agentId,
        registry_listing_id: listed.registryListingId,
        agent_uri: identity.agentUri,
        at: clock.now().toISOString(),
      },
      'listing is active',
    )

    return {
      ok: true,
      listingId,
      outcome: 'listed',
      status: 'active',
      agentId: identity.agentId,
      registryListingId: listed.registryListingId,
      agentUri: identity.agentUri,
      steps,
    }
  }

  /**
   * Step 1. `skip_verification` is the only way past the Call, it is written by
   * the seed script alone (AD-2), and it is checked here rather than inside the
   * port so that no implementation of `VerificationCall` can grant itself the
   * skip.
   */
  async function runVerification(
    listing: ListingPipelineRow,
  ): Promise<{ ok: true; outcome: StepOutcome } | { ok: false; reason: string }> {
    if (listing.skipVerification) {
      logger.info(
        { listing_id: listing.id },
        'verification Call skipped: skip_verification is set (seed script only)',
      )
      return { ok: true, outcome: 'skipped' }
    }

    const outcome = await deps.verification.run(listing)
    if (!outcome.ok) return { ok: false, reason: outcome.reason }
    logger.info(
      { listing_id: listing.id, call_id: outcome.callId },
      'verification Call succeeded',
    )
    return { ok: true, outcome: 'sent' }
  }

  /**
   * Step 2. The `agentURI` is decided inside `buildTx`, which AD-8 runs exactly
   * once per intent key: the string is written to the `chain_tx` payload before
   * anything is signed, and every later run reads it back from there. That is
   * what makes "decided once per Listing" a property of the data rather than a
   * promise about the code.
   */
  async function runIdentity(
    listing: ListingPipelineRow,
    wallet: CreatorWallet,
  ): Promise<IdentityResult> {
    const intentKey = intentKeys.identity(listing.id)
    const result = await deps.chain.chainWrite(intentKey, () => {
      const agentUri = decideAgentUri(listing, deps.config.publicBaseUrl ?? null)
      const call = deps.calls.identityRegister(agentUri)
      logger.info({ listing_id: listing.id, agent_uri: agentUri }, 'agentURI decided')
      return {
        walletId: wallet.id,
        to: call.to,
        data: call.data,
        payload: { listing_id: listing.id, agent_uri: agentUri },
      }
    })

    const settled = await settle(intentKey, result)
    if (!settled.ok) return settled

    const agentUri = agentUriOf(result)
    const agentId = await resolveAgentId(listing, result)
    if (!agentId) {
      return {
        ok: false,
        retryable: false,
        reason: `${intentKey} confirmed but carried no Registered event, so no agentId was minted`,
      }
    }

    return { ok: true, outcome: settled.outcome, agentId, agentUri }
  }

  /**
   * The `agentId` comes from the `Registered` event of the transaction this run
   * sent. A run that resumed onto an already-confirmed row never saw that
   * receipt, so the event is read again from the hash AD-8 kept.
   */
  async function resolveAgentId(
    listing: ListingPipelineRow,
    result: ChainWriteResult,
  ): Promise<string | null> {
    const fromReceipt = result.receipt?.registered?.agentId
    if (fromReceipt) return fromReceipt
    if (listing.agentId) return listing.agentId
    if (!result.record.txHash) return null
    return deps.receipts.registeredAgentId(result.record.txHash)
  }

  /**
   * Step 3. `stakeCheck` hands the ten-times minimum to the signing policy as
   * well, so the last word on it is spoken inside the wallet lock (AD-5) even
   * though the pipeline already refused above.
   */
  async function runList(
    listing: ListingPipelineRow,
    wallet: CreatorWallet,
    agentId: string,
    balance: bigint,
  ): Promise<ListResult> {
    const intentKey = intentKeys.list(listing.id)
    const price = BigInt(listing.declaredPrice)
    const stake = BigInt(listing.declaredStake)

    const result = await deps.chain.chainWrite(intentKey, () => {
      const call = deps.calls.registryList({
        agentId: BigInt(agentId),
        agentType: listing.type,
        price,
        endpoint: listing.endpoint,
        payTo: listing.payoutWallet,
        stake,
      })
      return {
        walletId: wallet.id,
        to: call.to,
        data: call.data,
        stakeCheck: { price, stake },
        // AD-8: a listing intent payload is `{ listing_id, before, after }`.
        // A first listing has no `before`, which reads as zero rather than as a
        // missing key, so Story 3.6's history table needs no special case.
        payload: {
          listing_id: listing.id,
          before: { price: '0', stake: '0', paused: false },
          after: { price: listing.declaredPrice, stake: listing.declaredStake, paused: false },
          agent_id: agentId,
          agent_type: listing.type,
          endpoint: listing.endpoint,
          pay_to: listing.payoutWallet,
        },
      }
    })

    const settled = await settle(intentKey, result, () => listRevertReason(listing, balance))
    if (!settled.ok) return settled

    const registryListingId = await ensureRegistryEntry(listing, agentId, result)
    if (!registryListingId) {
      return {
        ok: false,
        retryable: true,
        reason: `${intentKey} confirmed but its Listed event has not been read back yet`,
      }
    }
    return { ok: true, outcome: settled.outcome, registryListingId }
  }

  /**
   * AD-2: `refreshListingFromChain` is the one writer of the chain-owned
   * columns, and `chainWrite` already called it for the receipt it settled. This
   * covers the two cases where it cannot have: a resumed job that found the row
   * already `confirmed`, and a crash between the receipt and the refresh. It
   * calls the same function rather than writing anything itself, so there is
   * still exactly one writer.
   */
  async function ensureRegistryEntry(
    listing: ListingPipelineRow,
    agentId: string,
    result: ChainWriteResult,
  ): Promise<string | null> {
    const cached = await deps.listings.read(listing.id)
    if (cached?.registryListingId) return cached.registryListingId

    const fromReceipt = result.receipt?.listed?.registryListingId ?? null
    const registryListingId =
      fromReceipt ??
      (result.record.txHash ? await deps.receipts.listedRegistryListingId(result.record.txHash) : null)
    if (!registryListingId) return null

    const refreshed = await deps.chain.refreshListingFromChain(listing.id, {
      registryListingId,
      agentId,
    })
    return refreshed.refreshed ? refreshed.registryListingId : null
  }

  /**
   * The four ways a `chainWrite` can come back, turned into one answer. A
   * `pending` row is the only retryable one: its receipt simply has not arrived
   * inside the 60 s wait, and the next delivery re-checks the same hash.
   */
  async function settle(
    intentKey: string,
    result: ChainWriteResult,
    revertReason?: () => string,
  ): Promise<{ ok: true; outcome: StepOutcome } | { ok: false; retryable: boolean; reason: string }> {
    if (result.refusal) {
      return { ok: false, retryable: false, reason: result.refusal.message }
    }
    switch (result.record.status) {
      case 'confirmed':
        return { ok: true, outcome: result.reused ? 'reused' : 'sent' }
      case 'reverted': {
        const where = result.record.txHash ? ` (${result.record.txHash})` : ''
        const why = revertReason ? ` ${revertReason()}` : ''
        return { ok: false, retryable: false, reason: `${intentKey} reverted on chain${where}.${why}` }
      }
      case 'failed':
        return {
          ok: false,
          retryable: false,
          reason: `${intentKey} could not be sent; see the chain_tx row for the node's answer`,
        }
      default:
        return {
          ok: false,
          retryable: true,
          reason: `${intentKey} has no receipt yet${result.record.txHash ? ` (${result.record.txHash})` : ''}`,
        }
    }
  }

  /**
   * The Registry reverts `list(...)` when the Stake is below ten times the price
   * or when the Creator cannot pay it. Both were checked before the identity was
   * minted, so reaching here means something else — but the numbers that were
   * checked are still what a Creator needs to see next to the revert.
   */
  function listRevertReason(listing: ListingPipelineRow, balance: bigint): string {
    const price = BigInt(listing.declaredPrice)
    const stake = BigInt(listing.declaredStake)
    return (
      `The Registry refuses a Stake below ten times the price and a Stake the Creator cannot pay: ` +
      `price ${toDecimalUsdt(price)} tUSD, Stake ${toDecimalUsdt(stake)} tUSD, ` +
      `Creator balance ${toDecimalUsdt(balance)} tUSD at the time of the write.`
    )
  }
}

type IdentityResult =
  | { ok: true; outcome: StepOutcome; agentId: string; agentUri: string | null }
  | { ok: false; retryable: boolean; reason: string }

type ListResult =
  | { ok: true; outcome: StepOutcome; registryListingId: string }
  | { ok: false; retryable: boolean; reason: string }

/**
 * The frozen `agentURI`, read back from the `chain_tx` payload rather than
 * recomputed. On a resumed job this is the only copy that exists.
 */
export function agentUriOf(result: ChainWriteResult): string | null {
  const payload = result.record.payload
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as { agent_uri?: unknown }).agent_uri
  return typeof value === 'string' ? value : null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
