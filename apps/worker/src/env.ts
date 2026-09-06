import { defineEnv, csv } from '@agent-desk/schemas/env'
import { z } from 'zod'

/**
 * AD-5: `MASTER_KEY` appears in exactly one process env schema, this one. The
 * web app never signs, so it never sees it.
 */
export const env = defineEnv(
  z.object({
    DATABASE_URL: z.string().min(1),
    CHAIN_ID: z.coerce.number().int().positive().default(97),
    RPC_URLS: z.string().min(1).transform(csv),
    MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'MASTER_KEY must be 32 bytes of hex'),
    FACILITATOR_URL: z.string().url(),
    WALLET_GAS_FLOOR: z.string().default('0.02'),
    PLATFORM_WALLET_BNB_FLOOR: z.string().default('0.1'),
    CREATOR_WALLET_BNB_FLOOR: z.string().default('0.01'),
    DEMO_MINT_AMOUNT: z.string().default('100000000'),
    PUBLIC_BASE_URL: z.string().url().optional(),
  }),
)

export type WorkerEnv = typeof env
