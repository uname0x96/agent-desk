import { eq } from 'drizzle-orm'
import { accounts, platformSettings, wallets, type Database } from '@agent-desk/db'
import { newId } from '@agent-desk/schemas'
import { importKey, parseMasterKey } from '@agent-desk/adapters/signer'

/**
 * FR-1 / AD-5: the Platform Wallet is imported once, from `PLATFORM_WALLET_KEY`,
 * and is an ordinary `wallets` row of the Platform Account from then on. It
 * funds every new wallet's gas, pays for verification Calls, and signs the
 * platform's own execution Listing.
 *
 * `PLATFORM_WALLET_KEY` has exactly one reader in the TypeScript codebase:
 * `scripts/src/env.ts` reads it out of the environment, validates its shape,
 * and hands it to this function as an argument. Nothing else reads it —
 *
 *   rg -n 'PLATFORM_WALLET_KEY' --glob '!node_modules'
 *
 * finds `.env.example`, `contracts/README.md`, `contracts/script/Deploy.s.sol`
 * (Foundry's own deployer, a separate process), that env schema, and this file.
 * The key is sealed with AES-256-GCM under `MASTER_KEY` before it touches the
 * database, exactly like a generated one, so nothing downstream can tell the
 * Platform Wallet from a wallet the system made itself.
 *
 * Idempotent in the way a seed script has to be: it is safe to run on a fresh
 * database, on a database that already has the account but no wallet, and on
 * one that is already complete.
 */

/** The Platform Account's login. Fixed so a re-run finds the same account. */
export const PLATFORM_ACCOUNT_EMAIL = 'platform@agentdesk.local'

/**
 * The Platform Account is not a login. `bcrypt.compare` against anything that
 * is not a bcrypt hash is false, so no password can ever open it.
 */
const UNUSABLE_PASSWORD_HASH = '!'

export interface ImportPlatformWalletConfig {
  db: Database
  /** `PLATFORM_WALLET_KEY`: 0x and 64 hex characters. */
  platformWalletKey: string
  /** `MASTER_KEY`: 32 bytes as hex or base64. */
  masterKey: string
}

export interface ImportedPlatformWallet {
  accountId: string
  walletId: string
  /** Lower-case, AD-13. */
  address: string
  /** False when the account, the wallet, and the setting were all already there. */
  created: boolean
  /**
   * AD-5: null until the `approve:<wallet_id>` receipt lands. `wallet.create`
   * for this account fills it in — it finds this row rather than making one,
   * skips the gas top-up because the wallet is funded from outside, and runs
   * the approve.
   */
  readyAt: Date | null
}

export async function importPlatformWallet(
  config: ImportPlatformWalletConfig,
): Promise<ImportedPlatformWallet> {
  const { db } = config
  const key = importKey(config.platformWalletKey, parseMasterKey(config.masterKey))
  const address = key.address.toLowerCase()

  const accountId = await ensurePlatformAccount(db)

  // The address is unique, so this is what makes a re-run a no-op.
  const [existing] = await db.select().from(wallets).where(eq(wallets.address, address)).limit(1)
  if (existing) {
    if (existing.accountId !== accountId) {
      throw new Error(
        `the Platform Wallet address ${address} already belongs to account ${existing.accountId}, ` +
          `not the Platform Account ${accountId}`,
      )
    }
    await setPlatformAccount(db, accountId)
    return { accountId, walletId: existing.id, address, created: false, readyAt: existing.readyAt }
  }

  // A different key under the same account means someone changed
  // `PLATFORM_WALLET_KEY` after the first run. Inserting would leave two
  // Platform Wallets and `findByAccount` would pick one at random.
  const [other] = await db.select().from(wallets).where(eq(wallets.accountId, accountId)).limit(1)
  if (other) {
    throw new Error(
      `the Platform Account already has wallet ${other.id} at ${other.address}; ` +
        `PLATFORM_WALLET_KEY now points at ${address}. Refusing to import a second Platform Wallet.`,
    )
  }

  const [row] = await db
    .insert(wallets)
    .values({
      id: newId('wallet'),
      accountId,
      address,
      // Sealed under MASTER_KEY here; the plaintext key never reaches the DB.
      encryptedKey: key.encryptedKey,
    })
    .returning()
  if (!row) throw new Error('the Platform Wallet row was not inserted')

  await setPlatformAccount(db, accountId)
  return { accountId, walletId: row.id, address, created: true, readyAt: row.readyAt }
}

/** AD-10: `platform_settings.platform_account_id` names the Platform Account. */
async function ensurePlatformAccount(db: Database): Promise<string> {
  const [settings] = await db
    .select({ platformAccountId: platformSettings.platformAccountId })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)
  if (!settings) throw new Error('platform_settings row 1 is missing; run the migrations')
  if (settings.platformAccountId) return settings.platformAccountId

  // The setting may be unset because a previous run stopped between the two
  // writes, so the email — which is unique — decides, not the setting.
  const [byEmail] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.email, PLATFORM_ACCOUNT_EMAIL))
    .limit(1)
  if (byEmail) return byEmail.id

  const [created] = await db
    .insert(accounts)
    .values({
      id: newId('account'),
      email: PLATFORM_ACCOUNT_EMAIL,
      passwordHash: UNUSABLE_PASSWORD_HASH,
      isOperator: true,
    })
    .returning({ id: accounts.id })
  if (!created) throw new Error('the Platform Account was not inserted')
  return created.id
}

async function setPlatformAccount(db: Database, accountId: string): Promise<void> {
  await db
    .update(platformSettings)
    .set({ platformAccountId: accountId, updatedAt: new Date() })
    .where(eq(platformSettings.id, 1))
}
