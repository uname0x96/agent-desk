import { z } from 'zod'
import { addressesFor, createChainReader, createPublicChainClient } from '@agent-desk/adapters/chain'

/**
 * Story 3.1: the System Wallet's tUSD and BNB, read on page load through the
 * chain adapter (AD-1: the read half only — the web app holds no key and signs
 * nothing).
 *
 * A balance is a nice-to-have on a settings page and an RPC node is the least
 * reliable thing in the stack, so a failed read is null and the page says the
 * balances are unavailable. It never takes the page down with it.
 */

export interface WalletBalances {
  /** tUSD, base units (AD-13). */
  tusd: string
  /** BNB, wei. */
  bnb: string
}

const envSchema = z.object({
  CHAIN_ID: z.coerce.number().int().positive().default(97),
  RPC_URLS: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((url) => url.trim()).filter(Boolean)),
})

let parsed: z.infer<typeof envSchema> | undefined

/**
 * Parsed on first use, never at module scope. `next build` imports every route
 * to collect its page data and does that without the runtime environment, so a
 * top-level `parse` would turn a missing variable into a build failure instead
 * of the boot failure it should be.
 */
function env(): z.infer<typeof envSchema> {
  parsed ??= envSchema.parse(process.env)
  return parsed
}

let reader: ReturnType<typeof createChainReader> | undefined

function chainReader() {
  reader ??= createChainReader({
    // AD-10: the tUSD address comes from `deployments/<chain id>.json`, never
    // from an env var; only the RPC endpoints are environment.
    publicClient: createPublicChainClient({ chainId: env().CHAIN_ID, rpcUrls: env().RPC_URLS }),
    addresses: addressesFor(env().CHAIN_ID),
  })
  return reader
}

export async function readWalletBalances(address: string): Promise<WalletBalances | null> {
  try {
    const read = chainReader()
    const [tusd, bnb] = await Promise.all([read.tokenBalance(address), read.nativeBalance(address)])
    return { tusd: tusd.toString(), bnb: bnb.toString() }
  } catch {
    return null
  }
}
