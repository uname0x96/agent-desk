import { decodeEventLog, type PublicClient } from 'viem'
import { listingIdOfIntent } from '@agent-desk/schemas'
import type {
  ChainReader,
  ChainTxRecord,
  ChainTxStore,
  Clock,
  Hex,
  ListingCacheStore,
  Logger,
} from '@agent-desk/core/ports'
import { silentLogger, systemClock } from '@agent-desk/core/ports'
import type {
  BuildTx,
  ChainReceipt,
  ChainWriteResult,
  ChainWriter,
  ListingRefreshHints,
  ListingRefreshResult,
  SigningService,
} from '@agent-desk/core/signing'
import { identityRegistryAbi, registryAbi } from './abi.ts'
import { RECEIPT_TIMEOUT_MS, type ContractAddresses } from './clients.ts'

/**
 * AD-8: chain writes are intent-first and idempotent.
 *
 * `chainWrite(intentKey, buildTx)`
 *   1. looks the intent key up; a row that already exists is never sent again,
 *      it is re-checked;
 *   2. builds the transaction and inserts the `chain_tx` row `pending` with the
 *      payload — before anything is signed;
 *   3. signs and broadcasts through `core/signing`, so the wallet's mutex, the
 *      gas floor, and the ten-times stake minimum all apply (AD-5);
 *   4. records the hash immediately, then awaits the receipt for up to 60 s;
 *   5. writes `confirmed`, `reverted`, or `failed` with `tx_hash` and
 *      `confirmed_at`, and, for an intent that names a Listing, either refreshes
 *      the chain-owned columns (AD-2) or records `listings.last_error`.
 *
 * A receipt that does not arrive inside 60 s leaves the row `pending` with its
 * hash, which the conventions require: the next call re-checks it and nothing
 * is ever sent twice for one intent key.
 */

export interface ChainWriterDeps {
  store: ChainTxStore
  listings: ListingCacheStore
  reader: Pick<ChainReader, 'getListing'>
  signing: Pick<SigningService, 'sendTx'>
  receipts: ReceiptSource
  addresses: ContractAddresses
  clock?: Clock
  logger?: Logger
  /**
   * How long a `pending` row with no transaction hash is believed to belong to
   * a send that is still in flight. Past it, the process that inserted the row
   * is assumed dead and the intent may be built and sent again; without this a
   * crash between the insert and the broadcast would wedge the intent key for
   * good. Two minutes is far longer than any send round trip.
   */
  staleSendAfterMs?: number
}

/** The receipt half of the chain, isolated so a unit test can drive it. */
export interface ReceiptSource {
  /** Waits up to 60 s. `null` means the wait ran out, not that the send failed. */
  waitFor(txHash: Hex): Promise<RawReceipt | null>
  /** One-shot lookup for the re-check path. `null` means the node has none yet. */
  get(txHash: Hex): Promise<RawReceipt | null>
}

export interface RawReceipt {
  transactionHash: Hex
  status: 'success' | 'reverted'
  blockNumber: bigint
  /** The block's timestamp; `chain_tx.confirmed_at` records it. */
  timestamp: Date
  logs: readonly RawLog[]
}

export interface RawLog {
  address: string
  topics: readonly Hex[]
  data: Hex
}

export const DEFAULT_STALE_SEND_MS = 120_000

export function createChainWriter(deps: ChainWriterDeps): ChainWriter {
  const clock = deps.clock ?? systemClock
  const logger = deps.logger ?? silentLogger
  const staleSendAfterMs = deps.staleSendAfterMs ?? DEFAULT_STALE_SEND_MS

  async function chainWrite(intentKey: string, buildTx: BuildTx): Promise<ChainWriteResult> {
    const existing = await deps.store.find(intentKey)
    if (existing) return resume(intentKey, existing, buildTx)

    const request = await buildTx()
    const { record, inserted } = await deps.store.insertPending(intentKey, request.payload)
    if (!inserted) {
      // Another worker inserted the same intent key between the lookup and the
      // insert. It owns the send; this call only ever reads from here on.
      logger.debug({ intent_key: intentKey }, 'chain_tx row already existed; not sending')
      return resume(intentKey, record, buildTx)
    }

    return send(intentKey, record, request)
  }

  /** An intent key that already has a row: re-check, never re-send blindly. */
  async function resume(
    intentKey: string,
    record: ChainTxRecord,
    buildTx: BuildTx,
  ): Promise<ChainWriteResult> {
    if (record.status !== 'pending') {
      return { intentKey, record, reused: true }
    }

    if (record.txHash) {
      const receipt = await deps.receipts.get(record.txHash).catch((error: unknown) => {
        logger.warn({ intent_key: intentKey, err: String(error) }, 'receipt re-check failed')
        return null
      })
      if (!receipt) return { intentKey, record, reused: true }
      return settleFromReceipt(intentKey, record, receipt, true)
    }

    const ageMs = clock.now().getTime() - record.createdAt.getTime()
    if (ageMs < staleSendAfterMs) {
      // A send is very likely still in flight in this or another process.
      return { intentKey, record, reused: true }
    }

    logger.warn(
      { intent_key: intentKey, age_ms: ageMs },
      'chain_tx has been pending without a hash past the stale window; rebuilding and sending',
    )
    return send(intentKey, record, await buildTx())
  }

  async function send(
    intentKey: string,
    record: ChainTxRecord,
    request: Awaited<ReturnType<BuildTx>>,
  ): Promise<ChainWriteResult> {
    const sent = await deps.signing.sendTx(request.walletId, {
      intentKey,
      to: request.to,
      data: request.data,
      ...(request.value === undefined ? {} : { value: request.value }),
      ...(request.gas === undefined ? {} : { gas: request.gas }),
      ...(request.gasFloorWei === undefined ? {} : { gasFloorWei: request.gasFloorWei }),
      ...(request.stakeCheck === undefined ? {} : { stakeCheck: request.stakeCheck }),
    }).catch((error: unknown) => ({ thrown: error }) as const)

    if ('thrown' in sent) {
      // The node refused the raw transaction, or the RPC was unreachable past
      // its retries. Nothing landed that we know of, so the intent is `failed`
      // and a Listing that named it learns why (AD-8).
      const message = errorMessage(sent.thrown)
      logger.error({ intent_key: intentKey, err: message }, 'chain send failed')
      await deps.store.settle(intentKey, 'failed', { txHash: null, confirmedAt: null })
      await noteListingFailure(intentKey, `${intentKey} failed to send: ${message}`)
      return {
        intentKey,
        record: { ...record, status: 'failed', updatedAt: clock.now() },
        reused: false,
      }
    }

    if (!sent.ok) {
      // A policy refusal is not a chain failure: nothing was signed and nothing
      // was spent. The row stays `pending` so the same intent key can be sent
      // once the wallet is topped up or the Stake is raised, which is why the
      // stale window above exists.
      await noteListingFailure(intentKey, sent.refusal.message)
      return { intentKey, record, reused: false, refusal: sent.refusal }
    }

    await deps.store.attachHash(intentKey, sent.txHash)
    const withHash: ChainTxRecord = { ...record, txHash: sent.txHash, updatedAt: clock.now() }

    const receipt = await deps.receipts.waitFor(sent.txHash).catch((error: unknown) => {
      logger.warn({ intent_key: intentKey, tx_hash: sent.txHash, err: String(error) }, 'receipt wait failed')
      return null
    })
    if (!receipt) {
      // Conventions: after 60 s the row stays `pending` and the next iteration
      // re-checks. The hash is already recorded, so nothing is lost.
      logger.warn(
        { intent_key: intentKey, tx_hash: sent.txHash, timeout_ms: RECEIPT_TIMEOUT_MS },
        'no receipt inside the wait; chain_tx stays pending',
      )
      return { intentKey, record: withHash, reused: false }
    }

    return settleFromReceipt(intentKey, withHash, receipt, false)
  }

  async function settleFromReceipt(
    intentKey: string,
    record: ChainTxRecord,
    receipt: RawReceipt,
    reused: boolean,
  ): Promise<ChainWriteResult> {
    const decoded = decodeReceipt(receipt, deps.addresses)
    const confirmed = receipt.status === 'success'
    const status = confirmed ? 'confirmed' : 'reverted'

    await deps.store.settle(intentKey, status, {
      txHash: receipt.transactionHash,
      confirmedAt: receipt.timestamp,
    })
    const settled: ChainTxRecord = {
      ...record,
      status,
      txHash: receipt.transactionHash,
      confirmedAt: receipt.timestamp,
      updatedAt: clock.now(),
    }

    const listingId = listingIdOfIntent(intentKey)
    if (!confirmed) {
      logger.warn({ intent_key: intentKey, tx_hash: receipt.transactionHash }, 'transaction reverted')
      await noteListingFailure(intentKey, `${intentKey} reverted on chain (${receipt.transactionHash})`)
    } else if (listingId) {
      // AD-2: every confirmed receipt whose intent names a Listing refreshes it.
      await refreshListingFromChain(listingId, {
        ...(decoded.listed ? { registryListingId: decoded.listed.registryListingId } : {}),
        ...(decoded.registered ? { agentId: decoded.registered.agentId } : {}),
      })
    }

    logger.info(
      { intent_key: intentKey, tx_hash: receipt.transactionHash, status },
      'chain write settled',
    )
    return { intentKey, record: settled, reused, receipt: decoded }
  }

  /** AD-8: a `reverted` or `failed` listing intent writes `listings.last_error`. */
  async function noteListingFailure(intentKey: string, message: string): Promise<void> {
    const listingId = listingIdOfIntent(intentKey)
    if (!listingId) return
    await deps.listings.writeLastError(listingId, message)
  }

  /**
   * AD-2: the only writer of `price`, `stake`, `reputation_bps`,
   * `paused_by_creator`, `paused_by_stake`, `payout_wallet`, `endpoint`,
   * `agent_id`, and `registry_listing_id`. Nothing else in the codebase writes
   * any of them — not a route handler, not a job, not a repository.
   */
  async function refreshListingFromChain(
    listingId: string,
    hints: ListingRefreshHints = {},
  ): Promise<ListingRefreshResult> {
    const row = await deps.listings.read(listingId)
    if (!row) return { refreshed: false, reason: 'listing_not_found' }

    const registryListingId = hints.registryListingId ?? row.registryListingId
    if (!registryListingId) {
      // An `identity:` receipt arrives before `list:` does, so there is no
      // Registry entry to read yet. Nothing is written; the `list:` receipt
      // brings both the id and every column with it.
      return { refreshed: false, reason: 'no_registry_listing_id' }
    }

    const onChain = await deps.reader.getListing(BigInt(registryListingId))
    const agentId = onChain.agentId !== 0n ? onChain.agentId.toString() : (hints.agentId ?? row.agentId ?? '0')

    await deps.listings.writeChainOwned(listingId, {
      price: onChain.price.toString(),
      stake: onChain.stake.toString(),
      reputationBps: onChain.reputationBps,
      pausedByCreator: onChain.pausedByCreator,
      pausedByStake: onChain.pausedByStake,
      payoutWallet: onChain.payTo.toLowerCase(),
      endpoint: onChain.endpoint,
      agentId,
      registryListingId,
    })

    logger.info({ listing_id: listingId, registry_listing_id: registryListingId }, 'listing refreshed from chain')
    return { refreshed: true, registryListingId }
  }

  return { chainWrite, refreshListingFromChain }
}

// ------------------------------------------------------------- event decoding

/**
 * The three events any caller needs out of a receipt, decoded here so no story
 * re-parses a log. Logs are matched by emitting address first: a receipt can
 * carry a log from any contract the transaction touched, and a `Listed` event
 * from somewhere else must never become a Registry id.
 */
export function decodeReceipt(receipt: RawReceipt, addresses: ContractAddresses): ChainReceipt {
  const decoded: ChainReceipt = {
    txHash: receipt.transactionHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    timestamp: receipt.timestamp,
  }

  for (const log of receipt.logs) {
    const from = log.address.toLowerCase()
    if (from === addresses.identityRegistry) {
      const event = tryDecode(identityRegistryAbi, log)
      if (event?.eventName === 'Registered') {
        const args = event.args as { agentId: bigint; agentURI: string; owner: string }
        decoded.registered = {
          agentId: args.agentId.toString(),
          agentURI: args.agentURI,
          owner: args.owner.toLowerCase(),
        }
      }
      continue
    }
    if (from !== addresses.registry) continue

    const event = tryDecode(registryAbi, log)
    if (event?.eventName === 'Listed') {
      const args = event.args as {
        listingId: bigint
        agentId: bigint
        price: bigint
        stake: bigint
      }
      decoded.listed = {
        registryListingId: args.listingId.toString(),
        agentId: args.agentId.toString(),
        price: args.price.toString(),
        stake: args.stake.toString(),
      }
    } else if (event?.eventName === 'Slashed') {
      const args = event.args as { listingId: bigint; callRef: Hex; amount: bigint }
      decoded.slashed = {
        registryListingId: args.listingId.toString(),
        callRef: args.callRef,
        // AD-9: the contract clamps to the remaining stake, so the settlement
        // row records what the event says, never what was asked for.
        amount: args.amount.toString(),
      }
    }
  }

  return decoded
}

function tryDecode(abi: Parameters<typeof decodeEventLog>[0]['abi'], log: RawLog) {
  try {
    return decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
  } catch {
    // A log this ABI does not describe. Not an error: a transaction may emit
    // Transfer, Approval, and anything else along the way.
    return null
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// ----------------------------------------------------------- viem receipts

/** The production {@link ReceiptSource}, over the same client the reads use. */
export function createReceiptSource(
  publicClient: PublicClient,
  timeoutMs: number = RECEIPT_TIMEOUT_MS,
): ReceiptSource {
  const toRaw = async (receipt: {
    transactionHash: Hex
    status: 'success' | 'reverted'
    blockNumber: bigint
    logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[]
  }): Promise<RawReceipt> => {
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
    return {
      transactionHash: receipt.transactionHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      timestamp: new Date(Number(block.timestamp) * 1000),
      logs: receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })),
    }
  }

  return {
    async waitFor(txHash) {
      try {
        return await toRaw(await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs }))
      } catch {
        // Timeout, or an RPC that could not answer inside the window. Either
        // way the row stays `pending` and the next call re-checks.
        return null
      }
    },
    async get(txHash) {
      try {
        return await toRaw(await publicClient.getTransactionReceipt({ hash: txHash }))
      } catch {
        return null
      }
    },
  }
}
