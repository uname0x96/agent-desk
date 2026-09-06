import { createLogger } from '@agent-desk/schemas/logger'
import { createDb, startBoss } from '@agent-desk/db'
import { createEngine, registerWalletCreate } from '@agent-desk/scripts/wiring'
import { findPlatformWalletId } from './platform-wallet.ts'
import { env } from './env.ts'
import { startHeartbeat } from './heartbeat.ts'
import { registerListingJobs, type JobDeps } from './jobs/listing-verify.ts'
import { registerRunJobs } from './jobs/run-execute.ts'
import { registerSettlementJobs } from './jobs/settlement.ts'

/**
 * AD-4: this process is the only writer of Run state. The web app inserts a Run
 * whole and then publishes `run.execute`; every transition after that happens
 * here.
 */
async function main(): Promise<void> {
  const logger = createLogger('worker')
  const db = createDb({ url: env.DATABASE_URL })

  // The heartbeat starts before anything that can block, so `pnpm doctor` sees
  // a live worker even while the engine is still wiring up.
  const stopHeartbeat = startHeartbeat(db, (error) => logger.error({ error }, 'heartbeat failed'))

  const platformWalletId = await findPlatformWalletId(db)
  const engine = createEngine({
    db,
    chainId: env.CHAIN_ID,
    rpcUrls: env.RPC_URLS,
    masterKey: env.MASTER_KEY,
    platformWalletId,
    walletGasFloor: env.WALLET_GAS_FLOOR,
    platformWalletBnbFloor: env.PLATFORM_WALLET_BNB_FLOOR,
    creatorWalletBnbFloor: env.CREATOR_WALLET_BNB_FLOOR,
    demoMintAmount: BigInt(env.DEMO_MINT_AMOUNT),
    logger,
  })

  const boss = await startBoss(env.DATABASE_URL)
  const deps: JobDeps = {
    db,
    engine,
    boss,
    logger,
    facilitatorUrl: env.FACILITATOR_URL,
    publicBaseUrl: env.PUBLIC_BASE_URL,
  }

  await registerWalletCreate(boss, engine)
  await registerListingJobs(deps)
  await registerRunJobs(deps)
  // AD-9 / Stories 2.9 and 4.1-4.4: the one in-process settlement loop. Each
  // iteration re-reads the mode, runs Story 2.9's AD-4 timeout sweep, then
  // scores every due research and risk Call and carries its slash and
  // reputation writes. Independent of the heartbeat, deliberately.
  const settlement = await registerSettlementJobs({ db, boss, engine, logger, platformWalletId })
  logger.info({ chainId: env.CHAIN_ID }, 'worker ready')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down')
    stopHeartbeat()
    settlement.stop()
    await boss.stop({ graceful: true })
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
