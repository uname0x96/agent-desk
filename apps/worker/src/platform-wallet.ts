import { and, eq } from 'drizzle-orm'
import { platformSettings, wallets, type Database } from '@agent-desk/db'

/**
 * AD-5: `PLATFORM_WALLET_KEY` has exactly one reader in the codebase,
 * `scripts/src/platform-wallet.ts`, and `pnpm seed` is what calls it. The
 * worker therefore does not import the key; it looks the row up by the
 * `platform_settings.platform_account_id` that seeding wrote.
 */
export async function findPlatformWalletId(db: Database): Promise<string> {
  const [settings] = await db
    .select({ accountId: platformSettings.platformAccountId })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  if (!settings?.accountId) {
    throw new Error(
      'platform_settings.platform_account_id is not set. Run `pnpm seed` before starting the worker.',
    )
  }

  const [wallet] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.accountId, settings.accountId)))
    .limit(1)

  if (!wallet) {
    throw new Error(
      `The Platform Account ${settings.accountId} has no wallet row. Run \`pnpm seed\` before starting the worker.`,
    )
  }
  return wallet.id
}
