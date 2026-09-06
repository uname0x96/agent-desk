import type { Query } from '@tanstack/react-query'
import type { MeResponse } from '@agent-desk/schemas'
import { POLL_INTERVAL_MS, shouldKeepPolling } from '../../lib/run-polling.ts'
import { meQueryOptions, type MeFetcher } from '../../lib/session-query.ts'

/**
 * AD-12 / Story 3.1: `/settings` polls `GET /api/me` every 2 s while the System
 * Wallet is being provisioned, and stops the moment `ready_at` is set. Nothing
 * pushes; the same two-second beat the Run view and the header use.
 *
 * The policy is here rather than inline in the component so it can be tested
 * without a DOM, exactly as `lib/run-polling.ts` does for a Run.
 */

export const WALLET_POLL_INTERVAL_MS = POLL_INTERVAL_MS

/**
 * What the page tells the person, in the order it happens:
 *
 *   `creating`     — the account exists, the worker has not written the row yet;
 *   `provisioning` — the address is known, gas / mint / approve are in flight;
 *   `ready`        — the approve receipt landed and the wallet can pay.
 *
 * The middle state is the one worth naming: the address appears about a second
 * after sign-up because the worker inserts the `wallets` row before it sends
 * anything, so most of the wait is spent with an address on screen and no
 * `ready_at` yet (AD-5).
 */
export type WalletStage = 'creating' | 'provisioning' | 'ready'

export function walletStage(me: Pick<MeResponse, 'wallet_address' | 'wallet_ready_at'>): WalletStage {
  if (me.wallet_ready_at !== null) return 'ready'
  return me.wallet_address === null ? 'creating' : 'provisioning'
}

export function isWalletReady(me: Pick<MeResponse, 'wallet_ready_at'> | undefined): boolean {
  return me !== undefined && me.wallet_ready_at !== null
}

/** 2 000 until `ready_at` is set, `false` afterwards. */
export function walletRefetchInterval(me: MeResponse | undefined): number | false {
  if (me === undefined) return WALLET_POLL_INTERVAL_MS
  return isWalletReady(me) ? false : WALLET_POLL_INTERVAL_MS
}

/**
 * `meQueryOptions` with the wallet poll on top, so `/settings` and the header
 * share one query key and one cache entry: whichever of them refetches, both
 * see the new answer.
 */
export function walletMeQueryOptions(fetcher?: MeFetcher) {
  return {
    ...meQueryOptions(fetcher),
    refetchInterval: (query: Query<MeResponse>) =>
      query.state.error !== null && !shouldKeepPolling(query.state.error)
        ? (false as const)
        : walletRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
  }
}
