import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { privateKeyToAccount } from 'viem/accounts'
import { accounts, platformSettings, wallets, type Database } from '@agent-desk/db'
import { decryptPrivateKey, parseMasterKey } from '@agent-desk/adapters/signer'
import { PLATFORM_ACCOUNT_EMAIL, importPlatformWallet } from './platform-wallet.ts'
import { TEST_DATABASE_URL, databaseLock, databaseReachable, resetDatabase, testDb } from './test-db.ts'

/**
 * FR-1 / AD-5: importing the Platform Wallet is the one place a private key
 * enters this system from outside, and `pnpm seed` may be run any number of
 * times, so idempotence is the property that matters. Every case below is a way
 * a previous run could have stopped part-way.
 */

const HAVE_POSTGRES = await databaseReachable()
const db: Database = testDb()
const lock = databaseLock()

const MASTER_KEY = randomBytes(32).toString('hex')
const PLATFORM_WALLET_KEY = `0x${randomBytes(32).toString('hex')}`
const EXPECTED_ADDRESS = privateKeyToAccount(PLATFORM_WALLET_KEY as `0x${string}`).address.toLowerCase()

const importIt = (key = PLATFORM_WALLET_KEY) =>
  importPlatformWallet({ db, platformWalletKey: key, masterKey: MASTER_KEY })

beforeAll(async () => {
  if (HAVE_POSTGRES) await lock.acquire()
})

afterAll(async () => {
  if (!HAVE_POSTGRES) return
  await resetDatabase(db)
  await lock.release()
})

describe.skipIf(!HAVE_POSTGRES)(`importPlatformWallet against ${TEST_DATABASE_URL}`, () => {
  beforeEach(() => resetDatabase(db))

  it('creates the account, the wallet, and the AD-10 setting on a fresh database', async () => {
    const imported = await importIt()

    expect(imported.created).toBe(true)
    expect(imported.address).toBe(EXPECTED_ADDRESS)
    expect(imported.readyAt).toBeNull()

    const [account] = await db.select().from(accounts)
    expect(account).toMatchObject({ id: imported.accountId, email: PLATFORM_ACCOUNT_EMAIL, isOperator: true })

    const [wallet] = await db.select().from(wallets)
    expect(wallet).toMatchObject({
      id: imported.walletId,
      accountId: imported.accountId,
      address: EXPECTED_ADDRESS,
      readyAt: null,
    })

    const [settings] = await db.select().from(platformSettings).where(eq(platformSettings.id, 1))
    expect(settings?.platformAccountId).toBe(imported.accountId)
  })

  it('stores the key sealed under MASTER_KEY, never in the clear', async () => {
    const imported = await importIt()
    const [wallet] = await db.select().from(wallets)

    expect(wallet?.encryptedKey).not.toContain(PLATFORM_WALLET_KEY.slice(2))
    expect(wallet?.encryptedKey.startsWith('gcm1.')).toBe(true)
    // It is the same key, and it opens only under this MASTER_KEY.
    expect(decryptPrivateKey(wallet!.encryptedKey, parseMasterKey(MASTER_KEY))).toBe(PLATFORM_WALLET_KEY)
    expect(() => decryptPrivateKey(wallet!.encryptedKey, randomBytes(32))).toThrow('wrong MASTER_KEY')
    expect(imported.address).toBe(EXPECTED_ADDRESS)
  })

  it('is a no-op on a second run', async () => {
    const first = await importIt()
    const second = await importIt()

    expect(second.created).toBe(false)
    expect(second.accountId).toBe(first.accountId)
    expect(second.walletId).toBe(first.walletId)
    expect(await db.select().from(wallets)).toHaveLength(1)
    expect(await db.select().from(accounts)).toHaveLength(1)
  })

  it('re-encrypting the same key does not produce a second wallet', async () => {
    // Every envelope is different — a fresh IV each time — so the address, not
    // the ciphertext, has to be what makes this idempotent.
    const first = await importIt()
    const [before] = await db.select().from(wallets)
    const second = await importIt()
    const [after] = await db.select().from(wallets)

    expect(second.walletId).toBe(first.walletId)
    expect(after?.encryptedKey).toBe(before?.encryptedKey)
  })

  it('resumes a run that stopped after the account but before the setting', async () => {
    const first = await importIt()
    await db.update(platformSettings).set({ platformAccountId: null }).where(eq(platformSettings.id, 1))

    const second = await importIt()

    expect(second.accountId).toBe(first.accountId)
    expect(await db.select().from(accounts)).toHaveLength(1)
    const [settings] = await db.select().from(platformSettings).where(eq(platformSettings.id, 1))
    expect(settings?.platformAccountId).toBe(first.accountId)
  })

  it('resumes a run that created the account but never the wallet', async () => {
    const first = await importIt()
    await db.delete(wallets).where(eq(wallets.id, first.walletId))

    const second = await importIt()

    expect(second.created).toBe(true)
    expect(second.accountId).toBe(first.accountId)
    expect(second.address).toBe(EXPECTED_ADDRESS)
  })

  it('keeps ready_at once the approve receipt has set it', async () => {
    const first = await importIt()
    const readyAt = new Date('2026-09-06T12:00:09.000Z')
    await db.update(wallets).set({ readyAt }).where(eq(wallets.id, first.walletId))

    const second = await importIt()

    expect(second.created).toBe(false)
    expect(second.readyAt).toEqual(readyAt)
  })

  it('refuses to import a second Platform Wallet when the key changed', async () => {
    await importIt()
    const otherKey = `0x${randomBytes(32).toString('hex')}`

    await expect(importIt(otherKey)).rejects.toThrow('Refusing to import a second Platform Wallet')
    expect(await db.select().from(wallets)).toHaveLength(1)
  })

  it('refuses when the address already belongs to somebody else', async () => {
    const otherAccountId = 'acc_01JKZ0000000000000000000AA'
    await db.insert(accounts).values({
      id: otherAccountId,
      email: 'someone@else.local',
      passwordHash: '!',
    })
    await db.insert(wallets).values({
      id: 'wal_01JKZ0000000000000000000AA',
      accountId: otherAccountId,
      address: EXPECTED_ADDRESS,
      encryptedKey: 'gcm1.a.b.c',
    })

    await expect(importIt()).rejects.toThrow('already belongs to account')
  })

  it('refuses a key that is not 32 bytes of hex', async () => {
    await expect(importIt('0xdeadbeef')).rejects.toThrow('private key')
  })
})
