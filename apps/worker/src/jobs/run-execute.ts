import { createChainReader, createPublicChainClient } from '@agent-desk/adapters/chain'
import { createMarketData } from '@agent-desk/adapters/market-data'
import type { Logger } from '@agent-desk/core/ports'
import { QUEUES, runExecuteJob, type RunExecuteJob } from '@agent-desk/schemas'
import type { Logger as PinoLogger } from 'pino'
import { env } from '../env.ts'
import type { JobDeps } from './listing-verify.ts'
import { safeAddressEquals } from './run/addresses.ts'
import { createAgentClient } from './run/agent-client.ts'
import { createRunEngine } from './run/engine.ts'
import { createRunStore } from './run/store.ts'

/**
 * Registers `run.execute`.
 *
 * AD-4: this handler is the only writer of Run and Call state. It walks the
 * Run's Calls in `node_index` order, does the x402 handshake against the Price
 * Lock, signs through `core/signing`, and compare-and-sets the Run's end.
 *
 * The queue is `exclusive` with `workflow_id` as its singleton key (see
 * `packages/db/queues`), so two Runs of one Workflow are never executed at
 * once. Within that, the handler is resumable: a redelivery after a crash loads
 * the Run and continues from the first non-terminal Call, and a Call already
 * `paid_awaiting_result` is resent with the header on its row rather than
 * signed again (AD-5, FR-25).
 */

/** AD-4: concurrency 4 across Workflows. One worker instance runs in the MVP. */
export const RUN_EXECUTE_CONCURRENCY = 4

export async function registerRunJobs(deps: JobDeps): Promise<void> {
  // The engine hands over the signing service and the addresses but not the RPC
  // client behind them, and `apps/worker/src/index.ts` belongs to another story,
  // so the one read this job needs — AD-6's `tUSD.authorizationState` — gets its
  // own read-only client over the same `RPC_URLS`.
  const publicClient = createPublicChainClient({ chainId: env.CHAIN_ID, rpcUrls: env.RPC_URLS })

  const engine = createRunEngine({
    store: createRunStore(deps.db),
    signing: deps.engine.signing,
    chain: createChainReader({ publicClient, addresses: deps.engine.addresses }),
    // AD-9 / addendum §4: Binance *production* public market data, never the
    // paid `data` Agent and never the Spot Testnet book. The adapter carries no
    // credentials and defaults to `data-api.binance.vision`.
    marketData: createMarketData(),
    agent: createAgentClient(),
    logger: adaptLogger(deps.logger),
    // AD-13: addresses are compared with viem's `isAddressEqual`. It throws on a
    // malformed address, and a malformed address in a 402 is a price mismatch,
    // not a crash.
    sameAddress: safeAddressEquals,
  })

  await deps.boss.work<RunExecuteJob>(
    QUEUES.runExecute,
    { batchSize: 1, localConcurrency: RUN_EXECUTE_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        await engine.execute(runExecuteJob.parse(job.data))
      }
    },
  )

  deps.logger.info({ queue: QUEUES.runExecute }, 'run jobs registered')
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
