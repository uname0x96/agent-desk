import { z } from 'zod'

/** AD-14: the internal route shapes, guarded by Bearer INTERNAL_TOKEN. */

export const internalBalance = z.object({
  balance_usdt: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
})

export const internalOrder = z.object({
  order_id: z.string(),
  raw: z.unknown(),
})

/** What a platform-operated agent reads before every order (AD-10, AD-11). */
export const internalSettings = z.object({
  emergency_stop: z.boolean(),
  order_ceiling_usdt: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
})

export type InternalBalance = z.infer<typeof internalBalance>
export type InternalOrder = z.infer<typeof internalOrder>
export type InternalSettings = z.infer<typeof internalSettings>
