import { z } from 'zod'
import { agentTypeSchema } from './types/index.ts'

/**
 * AD-4 / FR-23. Snapshotted when a Run starts and never changed; the engine
 * compares every 402 against it (FR-26) and pays nothing on a difference.
 */

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, 'must be a lower-case 0x address')

export const priceLockNode = z.object({
  node_index: z.number().int().min(0),
  node_type: agentTypeSchema,
  listing_id: z.string().min(1),
  provider: z.string().min(1),
  /** Base units, AD-13. */
  price: z.string().regex(/^(?:0|[1-9]\d*)$/),
  asset: addressSchema,
  network: z.string().min(1),
  pay_to: addressSchema,
})

export const priceLock = z.object({
  nodes: z.array(priceLockNode).min(1),
  /** Base units; the sum of every node price. */
  total: z.string().regex(/^(?:0|[1-9]\d*)$/),
  locked_at: z.iso.datetime({ offset: false }),
})

export type PriceLockNode = z.infer<typeof priceLockNode>
export type PriceLock = z.infer<typeof priceLock>
