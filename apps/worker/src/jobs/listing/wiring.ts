import type { Database } from '@agent-desk/db'
import type { Engine } from '@agent-desk/scripts/wiring'
import {
  createChainReader,
  createContractCalls,
  createPublicChainClient,
  createReceiptSource,
} from '@agent-desk/adapters/chain'
import { createListingVerifyJob, type VerificationCall } from '@agent-desk/core/listing'
import type { Logger } from '@agent-desk/core/ports'
import { buildX402Config } from '@agent-desk/schemas'
import { safeAddressEquals } from '../run/addresses.ts'
import { createAgentClient } from '../run/agent-client.ts'
import { createListingPipelineStore } from './store.ts'
import { createListingReceiptSource } from './receipts.ts'
import { createVerificationCall } from './verification.ts'
import { createVerificationCallStore } from './verification-store.ts'
import { createListingWriteJob } from './write.ts'
import { createListingWriteStore } from './write-store.ts'

/**
 * Everything `listing.verify` needs, assembled from the `Engine` and a database.
 *
 * It is split out of `registerListingJobs` for one reason: that module reads
 * `../env.ts`, which validates the whole worker environment at import time and
 * exits the process when a key is missing. A test that wants to drive the real
 * wiring against a real chain must be able to import the wiring without
 * importing the boot sequence, so the environment is read at the edge and the
 * values this needs arrive as arguments.
 */

export interface ListingVerifyWiring {
  db: Database
  engine: Engine
  /** `CHAIN_ID` and `RPC_URLS`, read by the caller. */
  chainId: number
  rpcUrls: readonly string[]
  /** `FACILITATOR_URL`; AD-6 derives the whole x402 binding from it. */
  facilitatorUrl: string
  /** `PUBLIC_BASE_URL`. Absent means every `agentURI` decided is a `data:` URI. */
  publicBaseUrl?: string | undefined
  /** `PLATFORM_CHAT_ID`, substituted into the `notify` sample (addendum §1). */
  platformChatId?: string | undefined
  /**
   * Story 3.4 built the real paid Handshake below; this stays an argument so a
   * test can substitute one, which is the same seam Story 1.7 left behind.
   */
  verification?: VerificationCall
  logger?: Logger
}

export function buildListingVerify(config: ListingVerifyWiring) {
  // The engine hands over `chain` and `addresses` but not the RPC client behind
  // them, so the reads this job needs — the Creator's tUSD balance, the events
  // of a receipt a previous run already confirmed, and AD-6's
  // `authorizationState` — get their own client over the same `RPC_URLS`. It is
  // read-only; nothing here can sign.
  const publicClient = createPublicChainClient({ chainId: config.chainId, rpcUrls: config.rpcUrls })
  const reader = createChainReader({ publicClient, addresses: config.engine.addresses })

  return createListingVerifyJob({
    listings: createListingPipelineStore(config.db),
    chain: config.engine.chain,
    calls: createContractCalls(config.engine.addresses),
    receipts: createListingReceiptSource(createReceiptSource(publicClient), config.engine.addresses),
    reader,
    verification: config.verification ?? buildVerificationCall(config, reader),
    config: { publicBaseUrl: config.publicBaseUrl },
    ...(config.logger ? { logger: config.logger } : {}),
  })
}

/**
 * FR-11 / AD-6: the paid verification Call, paid by the Platform Wallet.
 *
 * `createAgentClient` and `safeAddressEquals` are the engine's own, on purpose
 * — AD-6 allows exactly one x402 wire and one address comparison in this
 * process, and a verification that judged a 402 differently from the engine
 * would admit an Agent no Run could then pay.
 */
function buildVerificationCall(
  config: ListingVerifyWiring,
  reader: ReturnType<typeof createChainReader>,
): VerificationCall {
  return createVerificationCall({
    store: createVerificationCallStore(config.db),
    signing: config.engine.signing,
    chain: reader,
    agent: createAgentClient(),
    x402: buildX402Config({ facilitatorUrl: config.facilitatorUrl, chainId: config.chainId }),
    sameAddress: safeAddressEquals,
    ...(config.platformChatId ? { platformChatId: config.platformChatId } : {}),
    ...(config.logger ? { logger: config.logger } : {}),
  })
}

/**
 * Everything `listing.write` needs (Story 3.6, FR-7, FR-9).
 *
 * The same three arguments `listing.verify` takes and no more: the write job
 * signs with the Creator wallet through the engine's own `ChainWriter`, reads
 * the Creator's tUSD through a read-only client over `RPC_URLS`, and touches
 * `status` and `last_error` through a store that cannot reach a chain-owned
 * column.
 */
export interface ListingWriteWiring {
  db: Database
  engine: Engine
  chainId: number
  rpcUrls: readonly string[]
  logger?: Logger
}

export function buildListingWrite(config: ListingWriteWiring) {
  const publicClient = createPublicChainClient({ chainId: config.chainId, rpcUrls: config.rpcUrls })

  return createListingWriteJob({
    listings: createListingWriteStore(config.db),
    chain: config.engine.chain,
    calls: createContractCalls(config.engine.addresses),
    reader: createChainReader({ publicClient, addresses: config.engine.addresses }),
    ...(config.logger ? { logger: config.logger } : {}),
  })
}
