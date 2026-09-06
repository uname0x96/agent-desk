import { formatEther } from 'viem'
import type { FacilitatorConfig } from './config.ts'

/**
 * `GET /health` answers 200 with the relayer address, its BNB balance and the
 * number of transactions it has in flight, and 503 when the RPC is unreachable.
 * The relayer key is never part of any response.
 */
export interface HealthProbe {
  address: `0x${string}`
  getBalance(): Promise<bigint>
  /** Nonce including transactions still in the mempool. */
  getPendingNonce(): Promise<number>
  /** Nonce of the last mined transaction. */
  getLatestNonce(): Promise<number>
}

export interface HealthResult {
  status: 200 | 503
  body: Record<string, unknown>
}

export async function readHealth(config: FacilitatorConfig, probe: HealthProbe): Promise<HealthResult> {
  const asset = {
    address: config.x402.asset,
    name: config.x402.extra.name,
    version: config.x402.extra.version,
    decimals: config.x402.decimals,
    deployed: config.assetDeployed,
  }
  try {
    const [balanceWei, pendingNonce, latestNonce] = await Promise.all([
      probe.getBalance(),
      probe.getPendingNonce(),
      probe.getLatestNonce(),
    ])
    return {
      status: 200,
      body: {
        status: 'ok',
        chainId: config.chainId,
        network: config.x402.network,
        relayer: {
          address: probe.address,
          bnbBalanceWei: balanceWei.toString(),
          bnbBalance: formatEther(balanceWei),
          pendingNonceCount: Math.max(0, pendingNonce - latestNonce),
        },
        asset,
      },
    }
  } catch (error) {
    return {
      status: 503,
      body: {
        status: 'rpc_unreachable',
        chainId: config.chainId,
        network: config.x402.network,
        relayer: { address: probe.address },
        asset,
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}
