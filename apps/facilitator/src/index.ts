import { createLogger } from '@agent-desk/schemas/logger'
import { createApp } from './app.ts'
import { buildFacilitatorConfig } from './config.ts'
import { loadFacilitatorEnv } from './env.ts'
import { createFacilitator } from './facilitator.ts'
import { createRelayer } from './relayer.ts'
import type { HealthProbe } from './health.ts'

/**
 * Self-hosted x402 v2 facilitator for eip155:97 (AD-6). The relayer key is read
 * here and nowhere else in the monorepo.
 */
const logger = createLogger('facilitator')
const env = loadFacilitatorEnv()
const config = buildFacilitatorConfig(env)
const relayer = createRelayer(env)
const facilitator = createFacilitator(config, relayer)

const probe: HealthProbe = {
  address: relayer.address,
  getBalance: () => relayer.publicClient.getBalance({ address: relayer.address }),
  getPendingNonce: () => relayer.publicClient.getTransactionCount({ address: relayer.address, blockTag: 'pending' }),
  getLatestNonce: () => relayer.publicClient.getTransactionCount({ address: relayer.address, blockTag: 'latest' }),
}

if (!config.assetDeployed) {
  logger.warn(
    { asset: config.x402.asset },
    'tUSD is not deployed yet in deployments/97.json; verify and settle will reject every request until it is',
  )
}

const app = createApp({ config, facilitator, probe, logger })
app.listen(env.port, () => {
  logger.info(
    {
      port: env.port,
      network: config.x402.network,
      relayer: relayer.address,
      asset: config.x402.asset,
      rpcCount: env.rpcUrls.length,
    },
    'facilitator listening',
  )
})
