import { decodeReceipt, type ContractAddresses, type ReceiptSource } from '@agent-desk/adapters/chain'
import type { ContractCalls, Hex, Logger } from '@agent-desk/core/ports'
import { silentLogger } from '@agent-desk/core/ports'
import type { ChainWriteResult, ChainWriter } from '@agent-desk/core/signing'
import { intentKeys } from '@agent-desk/schemas'
import type {
  ChainOutcome,
  ReputationRequest,
  SettlementChain,
  SettlementStore,
  SlashRequest,
} from './ports.ts'

/**
 * The two Registry writes a Settlement makes, both signed by the Platform
 * Wallet, both through AD-8's `chainWrite` on a fixed intent key:
 *
 *   - `slash:<call_id>` — `slash(listingId, keccak256(call_id), locked_price,
 *     the Run's Builder System Wallet)`. One transaction moves the Stake out and
 *     the Refund in, which is the whole point of FR-35: there is no second
 *     transfer to reconcile, and one tx hash proves both halves.
 *   - `reputation:<listing_id>:<settlement_id>` — `setReputation(listingId, bps)`.
 *
 * Because the key is fixed, a redelivered job, a crashed worker, or a tick that
 * ran twice all reach the same row: `chainWrite` re-checks the receipt and
 * sends nothing. That is what makes "a retried tick with the existing `slash:`
 * row sends nothing" true by construction rather than by a flag.
 *
 * The one wrinkle is worth naming. `chainWrite` decodes the receipt only on the
 * call that read it; a later tick that finds the row already `confirmed` gets
 * no receipt back. The clamped `Slashed` amount lives only in that receipt, so
 * this module re-reads and re-decodes it by hash rather than assuming the
 * amount asked for was the amount paid — which, on a drained Listing, it is not.
 */

export interface SettlementChainDeps {
  chain: ChainWriter
  calls: ContractCalls
  receipts: ReceiptSource
  addresses: ContractAddresses
  /** AD-9: slash and reputation are signed by the Platform Wallet. */
  platformWalletId: string
  /** The Platform Wallet's own BNB floor, not the Creator default. */
  gasFloorWei?: bigint
  store: Pick<SettlementStore, 'noteListingError'>
  logger?: Logger
}

export function createSettlementChain(deps: SettlementChainDeps): SettlementChain {
  const logger = deps.logger ?? silentLogger

  async function slash(request: SlashRequest): Promise<ChainOutcome> {
    const intentKey = intentKeys.slash(request.callId)
    // Story 4.3: the payload is captured before anything is sent, so Story 5.4
    // can render the Stake history without re-reading the chain.
    const payload = {
      listing_id: request.listingId,
      call_id: request.callId,
      settlement_id: request.settlementId,
      amount: request.amount,
      to: request.to,
    }

    const result = await deps.chain.chainWrite(intentKey, () => ({
      walletId: deps.platformWalletId,
      ...deps.calls.registrySlash({
        registryListingId: BigInt(request.registryListingId),
        callRef: deps.calls.callRef(request.callId),
        amount: BigInt(request.amount),
        to: request.to,
      }),
      ...(deps.gasFloorWei === undefined ? {} : { gasFloorWei: deps.gasFloorWei }),
      payload,
    }))

    const outcome = await interpret(intentKey, result, request.listingId, {
      amountFromReceipt: true,
    })

    if (outcome.status === 'confirmed') {
      // AD-2 / Story 4.3: `slash:` names a Call, so `chainWrite` does not
      // refresh the Listing for it. The stake fell and the contract may have
      // set the stake pause, so the cache is refreshed here, on the same
      // receipt, in the same job.
      await deps.chain
        .refreshListingFromChain(request.listingId)
        .catch((error: unknown) =>
          logger.error(
            { listing_id: request.listingId, error: messageOf(error) },
            'listing refresh after a slash failed; the next tick will retry it',
          ),
        )
    }

    return outcome
  }

  async function setReputation(request: ReputationRequest): Promise<ChainOutcome> {
    const intentKey = intentKeys.reputation(request.listingId, request.settlementId)
    // Story 4.4: the history is the ordered `reputation:` rows with their
    // `{ before, after }` payload, so both are captured at enqueue.
    const payload = {
      listing_id: request.listingId,
      settlement_id: request.settlementId,
      before: request.beforeBps,
      after: request.bps,
    }

    const result = await deps.chain.chainWrite(intentKey, () => ({
      walletId: deps.platformWalletId,
      ...deps.calls.registrySetReputation(BigInt(request.registryListingId), request.bps),
      ...(deps.gasFloorWei === undefined ? {} : { gasFloorWei: deps.gasFloorWei }),
      payload,
    }))

    // A `reputation:` intent names its Listing, so `chainWrite` has already
    // refreshed `reputation_bps` from the confirmed receipt and written
    // `last_error` for a reverted one (AD-2, AD-8). Nothing to add here.
    return interpret(intentKey, result, request.listingId, { amountFromReceipt: false })
  }

  async function interpret(
    intentKey: string,
    result: ChainWriteResult,
    listingId: string,
    options: { amountFromReceipt: boolean },
  ): Promise<ChainOutcome> {
    if (result.refusal) {
      // Nothing was signed and nothing was spent, and the `chain_tx` row is
      // still `pending`, so the same key can be sent once the wallet is topped
      // up. The next tick tries again.
      return { status: 'refused', reason: result.refusal.message }
    }

    const record = result.record
    if (record.status === 'pending') {
      return { status: 'pending', txHash: record.txHash }
    }

    if (record.status === 'confirmed') {
      const txHash = record.txHash
      if (!txHash) {
        // A confirmed row always carries its hash; treat the impossible as
        // unfinished rather than recording a Refund nobody can look up.
        return { status: 'pending', txHash: null }
      }
      if (!options.amountFromReceipt) return { status: 'confirmed', txHash }
      const amount = await slashedAmount(result, txHash)
      return amount === null ? { status: 'pending', txHash } : { status: 'confirmed', txHash, amount }
    }

    const reason = `${intentKey} ${record.status === 'reverted' ? 'reverted on chain' : 'could not be sent'}`
    logger.error({ intent_key: intentKey, tx_hash: record.txHash, listing_id: listingId }, reason)
    await deps.store
      .noteListingError(listingId, `${reason}${record.txHash ? ` (${record.txHash})` : ''}`)
      .catch((error: unknown) => logger.error({ error: messageOf(error) }, 'could not record listings.last_error'))
    return { status: 'failed', reason, txHash: record.txHash }
  }

  /**
   * The clamped amount from the `Slashed` event: from the receipt `chainWrite`
   * just decoded when it has one, otherwise by re-reading the hash. Null means
   * the node could not answer yet, which leaves the row for the next tick
   * rather than recording an amount that was never paid.
   */
  async function slashedAmount(result: ChainWriteResult, txHash: string): Promise<string | null> {
    if (result.receipt?.slashed) return result.receipt.slashed.amount

    const raw = await deps.receipts.get(txHash as Hex).catch((error: unknown) => {
      logger.warn({ tx_hash: txHash, error: messageOf(error) }, 'could not re-read the slash receipt')
      return null
    })
    if (!raw) return null
    const decoded = decodeReceipt(raw, deps.addresses)
    if (!decoded.slashed) {
      logger.error({ tx_hash: txHash }, 'a confirmed slash receipt carried no Slashed event')
      return null
    }
    return decoded.slashed.amount
  }

  return { slash, setReputation }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
