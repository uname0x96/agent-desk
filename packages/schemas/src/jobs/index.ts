import { z } from 'zod'

/** AD-14: every pg-boss payload. Queue names are fixed here too. */

export const QUEUES = {
  runExecute: 'run.execute',
  walletCreate: 'wallet.create',
  listingVerify: 'listing.verify',
  listingWrite: 'listing.write',
  settlementTick: 'settlement.tick',
} as const

/** AD-3 / conventions: these four are exclusive-policy, singleton-keyed queues. */
export const EXCLUSIVE_QUEUES = [
  QUEUES.runExecute,
  QUEUES.walletCreate,
  QUEUES.listingVerify,
  QUEUES.listingWrite,
] as const

export const runExecuteJob = z.object({
  run_id: z.string(),
  /** Set by the timeout sweep: run only the notify filter (AD-4). */
  finalize: z.boolean().optional(),
})

export const walletCreateJob = z.object({ account_id: z.string() })

export const listingVerifyJob = z.object({ listing_id: z.string() })

/** AD-8: web allocates the intent key at enqueue; the job never computes it. */
export const listingWriteJob = z.object({
  listing_id: z.string(),
  intent_key: z.string(),
  payload: z.object({
    listing_id: z.string(),
    before: z.object({
      price: z.string(),
      stake: z.string(),
      paused: z.boolean(),
    }),
    after: z.object({
      price: z.string().optional(),
      stake: z.string().optional(),
      paused: z.boolean().optional(),
    }),
  }),
})

export const settlementTickJob = z.object({ call_id: z.string() })

export type RunExecuteJob = z.infer<typeof runExecuteJob>
export type WalletCreateJob = z.infer<typeof walletCreateJob>
export type ListingVerifyJob = z.infer<typeof listingVerifyJob>
export type ListingWriteJob = z.infer<typeof listingWriteJob>
export type SettlementTickJob = z.infer<typeof settlementTickJob>
