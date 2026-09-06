import type { Database } from '@agent-desk/db'
import type { Engine } from '@agent-desk/scripts/wiring'
import {
  createChainReader,
  createContractCalls,
  createPublicChainClient,
  createReceiptSource,
} from '@agent-desk/adapters/chain'
import {
  createListingVerifyJob,
  createUnimplementedVerificationCall,
  type VerificationCall,
} from '@agent-desk/core/listing'
import type { Logger } from '@agent-desk/core/ports'
import { createListingPipelineStore } from './store.ts'
import { createListingReceiptSource } from './receipts.ts'

/**
 * Everything `listing.verify` needs, assembled from the `Engine` and a database.
 *
 * It is split out of `registerListingJobs` for one reason: that module reads
 * `../env.ts`, which validates the whole worker environment at import time and
 * exits the process when a key is missing. A test that wants to drive the real
 * wiring against a real chain must be able to import the wiring without
 * importing the boot sequence, so the environment is read at the edge and the
 * two values this needs — the chain id and the RPC URLs — arrive as arguments.
 */

export interface ListingVerifyWiring {
  db: Database
  engine: Engine
  /** `CHAIN_ID` and `RPC_URLS`, read by the caller. */
  chainId: number
  rpcUrls: readonly string[]
  /** `PUBLIC_BASE_URL`. Absent means every `agentURI` decided is a `data:` URI. */
  publicBaseUrl?: string | undefined
  /**
   * The Story 3.4 seam. The default refuses every Listing that does not carry
   * `skip_verification`, so an Agent nobody has called cannot reach the Registry
   * (FR-11); 3.4 passes the real paid Handshake here and changes nothing else.
   */
  verification?: VerificationCall
  logger?: Logger
}

export function buildListingVerify(config: ListingVerifyWiring) {
  // The engine hands over `chain` and `addresses` but not the RPC client behind
  // them, so the two reads this job needs — the Creator's tUSD balance and the
  // events of a receipt a previous run already confirmed — get their own
  // client over the same `RPC_URLS`. It is read-only; nothing here can sign.
  const publicClient = createPublicChainClient({ chainId: config.chainId, rpcUrls: config.rpcUrls })

  return createListingVerifyJob({
    listings: createListingPipelineStore(config.db),
    chain: config.engine.chain,
    calls: createContractCalls(config.engine.addresses),
    receipts: createListingReceiptSource(createReceiptSource(publicClient), config.engine.addresses),
    reader: createChainReader({ publicClient, addresses: config.engine.addresses }),
    verification: config.verification ?? createUnimplementedVerificationCall(),
    config: { publicBaseUrl: config.publicBaseUrl },
    ...(config.logger ? { logger: config.logger } : {}),
  })
}
