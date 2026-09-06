import type { PgBoss } from 'pg-boss'
import type { Logger as PinoLogger } from 'pino'
import type { Database } from '@agent-desk/db'
import type { Logger } from '@agent-desk/core/ports'
import {
  bnbToWei,
  createSigningService,
  createWalletCreationJob,
  type ChainWriter,
  type SigningService,
  type WalletCreationResult,
} from '@agent-desk/core/signing'
import {
  addressesFor,
  assertDeployed,
  createChainReader,
  createChainWriter,
  createContractCalls,
  createPublicChainClient,
  createReceiptSource,
  type ContractAddresses,
} from '@agent-desk/adapters/chain'
import { createSigner } from '@agent-desk/adapters/signer'
import { createX402PaymentSigner } from '@agent-desk/adapters/x402'
import { QUEUES, walletCreateJob, type WalletCreateJob } from '@agent-desk/schemas'
import { createChainTxStore, createListingCacheStore, createSigningStore, createWalletStore } from './stores.ts'

export * from './stores.ts'

/**
 * The composition root for anything that signs.
 *
 * AD-5: the `Signer` is constructed here, from `MASTER_KEY`, and handed to
 * `core/signing`, which is the only code that decides whether to use it. AD-1
 * is why this file exists at all — it is the single place that holds
 * `@agent-desk/db`, `@agent-desk/adapters`, and `@agent-desk/core` together.
 * `apps/worker` registers the same jobs against the same function.
 */

export interface EngineConfig {
  db: Database
  chainId: number
  rpcUrls: readonly string[]
  masterKey: string
  /** The Platform Wallet's `wallets.id`, from `importPlatformWallet`. */
  platformWalletId: string
  /** Decimal BNB, from the env. */
  walletGasFloor: string
  platformWalletBnbFloor: string
  creatorWalletBnbFloor: string
  /** Base units minted per demo wallet. */
  demoMintAmount: bigint
  logger?: PinoLogger
}

export interface Engine {
  signing: SigningService
  chain: ChainWriter
  addresses: ContractAddresses
  runWalletCreate(job: WalletCreateJob): Promise<WalletCreationResult>
}

export function createEngine(config: EngineConfig): Engine {
  const logger = config.logger ? adaptLogger(config.logger) : undefined
  // AD-10: addresses come from `deployments/<chain id>.json` at runtime, and a
  // host that signs fails at boot rather than at the first transaction. tUSD
  // and the Registry are still the zero address there, so this throws until the
  // contracts are deployed — which is the intended behaviour, not a gap.
  const addresses = assertDeployed(addressesFor(config.chainId))
  const publicClient = createPublicChainClient({ chainId: config.chainId, rpcUrls: config.rpcUrls })

  const signer = createSigner({
    masterKey: config.masterKey,
    chainId: config.chainId,
    rpcUrls: config.rpcUrls,
  })
  const store = createSigningStore(config.db)
  const reader = createChainReader({ publicClient, addresses })

  const signing = createSigningService({
    signer,
    payments: createX402PaymentSigner({ signer }),
    store,
    chain: reader,
    gasFloorWei: bnbToWei(config.creatorWalletBnbFloor),
    ...(logger ? { logger } : {}),
  })

  const chain = createChainWriter({
    store: createChainTxStore(config.db),
    listings: createListingCacheStore(config.db),
    reader,
    signing,
    receipts: createReceiptSource(publicClient),
    addresses,
    ...(logger ? { logger } : {}),
  })

  const runWalletCreate = createWalletCreationJob({
    signer,
    wallets: createWalletStore(config.db),
    store,
    chain,
    reader,
    calls: createContractCalls(addresses),
    config: {
      platformWalletId: config.platformWalletId,
      walletGasFloorWei: bnbToWei(config.walletGasFloor),
      platformGasFloorWei: bnbToWei(config.platformWalletBnbFloor),
      demoMintAmount: config.demoMintAmount,
    },
    ...(logger ? { logger } : {}),
  })

  return { signing, chain, addresses, runWalletCreate }
}

/**
 * The `wallet.create` handler, ready for `apps/worker` to register. The queue is
 * `exclusive` with `account_id` as its singleton key (see `packages/db/queues`),
 * so at most one job per account is ever queued or active; the job body is
 * idempotent regardless, because a redelivery after a crash is the case AD-8
 * exists for.
 */
export function registerWalletCreate(boss: PgBoss, engine: Engine): Promise<string> {
  return boss.work<WalletCreateJob>(QUEUES.walletCreate, async (jobs) => {
    for (const job of jobs) {
      const result = await engine.runWalletCreate(walletCreateJob.parse(job.data))
      // A step that could not finish is a job failure, so pg-boss retries it and
      // the next attempt resumes at the first intent that is not confirmed.
      if (!result.ok) {
        throw new Error(`wallet.create failed at ${result.failedAt}: ${result.reason}`)
      }
    }
  })
}

/** Pino satisfies the port already; this narrows it to the four levels it names. */
function adaptLogger(logger: PinoLogger): Logger {
  return {
    debug: (fields, message) => logger.debug(fields, message),
    info: (fields, message) => logger.info(fields, message),
    warn: (fields, message) => logger.warn(fields, message),
    error: (fields, message) => logger.error(fields, message),
  }
}
