import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { parseEther, toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  addressesFor,
  assertDeployed,
  createChainReader,
  createPublicChainClient,
  identityRegistryAbi,
  type ContractAddresses,
} from '@agent-desk/adapters/chain'
import { accounts, chainTx, createDb, listings, platformSettings, type Database } from '@agent-desk/db'
import { createEngine, type Engine } from '@agent-desk/scripts/wiring'
import { importPlatformWallet } from '@agent-desk/scripts/platform-wallet'
import { intentKeys, newId } from '@agent-desk/schemas'
import { buildListingVerify } from './wiring.ts'

/**
 * AD-2 end to end, against a real chain and a real database.
 *
 * `pipeline.test.ts` next to this file proves the shape of the pipeline with the
 * RPC faked: the ordering guarantee, the `skip_verification` gate, the frozen
 * `agentURI`, the revert path, redelivery. What no fake can answer is whether
 * `IdentityRegistry.register` and `AgentDeskRegistry.list` accept this calldata,
 * whether the Stake actually moves, and whether the nine chain-owned columns
 * really equal `getListing`. That is what this file is for, and it is the only
 * test here that sends a transaction.
 *
 * It needs a development node: the fixture funds a Platform Wallet of its own
 * with `anvil_setBalance` rather than spending the one in `.env`, and creates the
 * Creator wallet through `wallet.create` — the real seeding path, gas, demo mint
 * and tUSD approval included. When any of that is missing the suite skips with
 * the reason in its name, because CI has no chain.
 *
 * Run it against `pnpm local:chain up`:
 *   TEST_RPC_URL=http://127.0.0.1:8545 pnpm exec vitest run pipeline.integration
 */

const RPC_URL = process.env.TEST_RPC_URL ?? 'http://127.0.0.1:8545'
const CHAIN_ID = Number(process.env.TEST_CHAIN_ID ?? '97')
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://agentdesk:agentdesk@localhost:5432/agentdesk_story16'

/**
 * The same key `scripts/src/test-db.ts` uses, and it has to stay the same: every
 * integration test in this repository truncates the same tables in the same
 * database, vitest runs files in parallel, and this is what makes them wait for
 * each other. `scripts` does not export that module, so the constant is repeated
 * rather than imported.
 */
const LOCK_KEY = 1_620_000_016

/** Sending 1 wei nowhere is the cheapest proof that this node lets us fund. */
const PROBE_ADDRESS = `0x${'0'.repeat(36)}dead`

/** 0.01 tUSD a call, staked at the Registry's minimum of ten times the price. */
const PRICE = '10000'
const STAKE = '100000'
/** 100 tUSD, the `DEMO_MINT_AMOUNT` default. */
const DEMO_MINT = 100_000_000n

const MASTER_KEY = randomBytes(32).toString('hex')

const SKIP_REASON = await unavailableReason()
const db: Database = createDb({ url: TEST_DATABASE_URL, max: 4 })
const holder: Database = createDb({ url: TEST_DATABASE_URL, max: 1 })

const title = 'listing.verify against a real chain'
describe.skipIf(SKIP_REASON !== null)(
  SKIP_REASON === null ? `${title} at ${RPC_URL}` : `${title} — skipped: ${SKIP_REASON}`,
  () => {
    // Built in `beforeAll`, not here: vitest walks the body of a skipped suite
    // to collect its names, and `assertDeployed` throws when the deployments
    // file still carries the zero address — which is the case this must skip on.
    let addresses: ContractAddresses
    let publicClient: ReturnType<typeof createPublicChainClient>
    let reader: ReturnType<typeof createChainReader>
    let engine: Engine
    let creatorAccountId: string
    let creatorAddress: string
    let runListingVerify: ReturnType<typeof buildListingVerify>

    beforeAll(async () => {
      addresses = assertDeployed(addressesFor(CHAIN_ID))
      publicClient = createPublicChainClient({ chainId: CHAIN_ID, rpcUrls: [RPC_URL] })
      reader = createChainReader({ publicClient, addresses })

      await holder.execute(sql`select pg_advisory_lock(${LOCK_KEY})`)
      // `demo` is what makes `wallet.create` mint the tUSD this pipeline stakes.
      await resetDatabase('demo')

      // A Platform Wallet of this test's own, funded on the node. Spending the
      // one in `.env` would make the test depend on a balance somebody else
      // maintains, and leave the seed script's wallet poorer every run.
      const platformKey = generatePrivateKey()
      await rpc('anvil_setBalance', [
        privateKeyToAccount(platformKey).address,
        toHex(parseEther('1000')),
      ])
      const platform = await importPlatformWallet({
        db,
        platformWalletKey: platformKey,
        masterKey: MASTER_KEY,
      })

      engine = createEngine({
        db,
        chainId: CHAIN_ID,
        rpcUrls: [RPC_URL],
        masterKey: MASTER_KEY,
        platformWalletId: platform.walletId,
        walletGasFloor: '0.05',
        platformWalletBnbFloor: '0.1',
        creatorWalletBnbFloor: '0.01',
        demoMintAmount: DEMO_MINT,
      })

      runListingVerify = buildListingVerify({
        db,
        engine,
        chainId: CHAIN_ID,
        rpcUrls: [RPC_URL],
        publicBaseUrl: 'https://desk.example',
      })

      // FR-2: gas, the demo mint, and `tUSD.approve(registry, max)`. `list(...)`
      // pulls the Stake through that allowance, so the pipeline cannot be tested
      // without it — and this is the path that grants it in production too.
      creatorAccountId = await insertAccount()
      let wallet = await engine.runWalletCreate({ account_id: creatorAccountId })
      if (!wallet.ok && wallet.failedAt === 'approve') {
        // A defect in `wallet.create`, not in this pipeline, and worth writing
        // down: the gas step tops the new wallet up to exactly
        // `WALLET_GAS_FLOOR`, the demo mint then spends some of it, and the
        // approve is held to that same floor — so on any chain where gas costs
        // anything, the approve refuses on the first pass in demo mode. The
        // fixture funds the wallet and resumes, which is also the redelivery
        // path `wallet.create` promises.
        await rpc('anvil_setBalance', [wallet.address, toHex(parseEther('1'))])
        // The refusal left `approve:<wallet_id>` `pending` with no hash, and
        // AD-8 holds such a row for two minutes before it will rebuild it.
        // Nothing was signed and nothing was spent, so dropping the row is
        // safe, and it is faster than sleeping through the stale window.
        await db.delete(chainTx).where(eq(chainTx.intentKey, intentKeys.approve(wallet.walletId)))
        wallet = await engine.runWalletCreate({ account_id: creatorAccountId })
      }
      expect(wallet, `wallet.create failed: ${JSON.stringify(wallet)}`).toMatchObject({ ok: true })
      if (!wallet.ok) throw new Error(wallet.reason)
      creatorAddress = wallet.address
    }, 180_000)

    afterAll(async () => {
      // Back to what the migration leaves behind, for whichever file runs next.
      await resetDatabase('production')
      await holder.execute(sql`select pg_advisory_unlock(${LOCK_KEY})`)
    })

    describe('a Listing seeded with skip_verification', () => {
      let listingId: string
      let payoutWallet: string
      let first: Awaited<ReturnType<typeof runListingVerify>>
      let registryBalanceBefore: bigint
      let creatorBalanceBefore: bigint

      beforeAll(async () => {
        payoutWallet = privateKeyToAccount(generatePrivateKey()).address.toLowerCase()
        listingId = await insertListing({ payoutWallet, stake: STAKE })
        registryBalanceBefore = await reader.tokenBalance(addresses.registry)
        creatorBalanceBefore = await reader.tokenBalance(creatorAddress)
        first = await runListingVerify({ listing_id: listingId })
      }, 180_000)

      it('reaches active through the three steps in order', () => {
        expect(first).toMatchObject({
          ok: true,
          outcome: 'listed',
          status: 'active',
          // `skip_verification` is the only way this step may be skipped, and
          // the two writes were made in this run rather than resumed.
          steps: { verification: 'skipped', identity: 'sent', list: 'sent' },
        })
        if (!first.ok) throw new Error(first.reason)
        expect(first.agentId).toMatch(/^\d+$/)
        expect(first.registryListingId).toMatch(/^\d+$/)
        expect(first.agentUri).toBe(`https://desk.example/api/listings/${listingId}/agent.json`)
      })

      it('writes chain-owned columns that are getListing, value for value', async () => {
        const row = await readListing(listingId)
        expect(row.status).toBe('active')
        expect(row.lastError).toBeNull()
        expect(row.registryListingId).not.toBeNull()

        const onChain = await reader.getListing(BigInt(row.registryListingId!))

        // AD-2: this is the claim the marketplace card rests on. `GET
        // /api/listings` serves these columns and never re-reads the chain, so
        // "the card matches `getListing`" is only true if this is.
        expect({
          price: row.price,
          stake: row.stake,
          reputationBps: row.reputationBps,
          pausedByCreator: row.pausedByCreator,
          pausedByStake: row.pausedByStake,
          payoutWallet: row.payoutWallet,
          endpoint: row.endpoint,
          agentId: row.agentId,
        }).toEqual({
          price: onChain.price.toString(),
          stake: onChain.stake.toString(),
          reputationBps: onChain.reputationBps,
          pausedByCreator: onChain.pausedByCreator,
          pausedByStake: onChain.pausedByStake,
          payoutWallet: onChain.payTo.toLowerCase(),
          endpoint: onChain.endpoint,
          agentId: onChain.agentId.toString(),
        })

        // And what reached the chain is what the Creator declared.
        expect(onChain.price).toBe(BigInt(PRICE))
        expect(onChain.stake).toBe(BigInt(STAKE))
        expect(onChain.payTo.toLowerCase()).toBe(payoutWallet)
        expect(onChain.creator.toLowerCase()).toBe(creatorAddress)
        expect(onChain.agentType).toBe('data')
      })

      it('minted an ERC-8004 identity around the agentURI it froze', async () => {
        if (!first.ok || !first.agentId) throw new Error('no agentId')
        const agentId = BigInt(first.agentId)

        const owner = (await publicClient.readContract({
          address: addresses.identityRegistry as Hex,
          abi: identityRegistryAbi,
          functionName: 'ownerOf',
          args: [agentId],
        })) as string
        const tokenUri = (await publicClient.readContract({
          address: addresses.identityRegistry as Hex,
          abi: identityRegistryAbi,
          functionName: 'tokenURI',
          args: [agentId],
        })) as string

        // The Creator wallet signs `register`, so the Creator owns the token.
        expect(owner.toLowerCase()).toBe(creatorAddress)
        // The URI on chain is the one the `identity:` payload froze — the same
        // string `GET /api/listings/<id>/agent.json` answers on.
        expect(tokenUri).toBe(first.agentUri)
      })

      it('moved the Stake in tUSD from the Creator to the Registry', async () => {
        const registryAfter = await reader.tokenBalance(addresses.registry)
        const creatorAfter = await reader.tokenBalance(creatorAddress)

        expect(registryAfter - registryBalanceBefore).toBe(BigInt(STAKE))
        expect(creatorBalanceBefore - creatorAfter).toBe(BigInt(STAKE))
        // The demo mint funded it and nothing else was spent.
        expect(creatorBalanceBefore).toBe(DEMO_MINT)
      })

      it('leaves exactly the two intents AD-8 names, both confirmed on chain', async () => {
        const rows = await db.select().from(chainTx)
        const forListing = rows.filter((row) => row.intentKey.endsWith(listingId))
        expect(forListing.map((row) => row.intentKey).sort()).toEqual([
          intentKeys.identity(listingId),
          intentKeys.list(listingId),
        ])

        for (const row of forListing) {
          expect(row.status).toBe('confirmed')
          expect(row.txHash).toMatch(/^0x[0-9a-f]{64}$/)
          const receipt = await publicClient.getTransactionReceipt({ hash: row.txHash as Hex })
          expect(receipt.status).toBe('success')
        }

        // AD-2: the `agentURI` lives in the payload, decided once, before the
        // transaction was signed.
        const identity = forListing.find((row) => row.intentKey.startsWith('identity:'))
        expect(identity?.payload).toMatchObject({
          listing_id: listingId,
          agent_uri: `https://desk.example/api/listings/${listingId}/agent.json`,
        })
      })

      it('sends nothing on redelivery', async () => {
        const before = await db.select().from(chainTx)
        const again = await runListingVerify({ listing_id: listingId })

        expect(again).toMatchObject({ ok: true, outcome: 'already_listed', status: 'active' })
        if (!again.ok || !first.ok) throw new Error('not listed')
        expect(again.agentId).toBe(first.agentId)
        expect(again.registryListingId).toBe(first.registryListingId)

        const after = await db.select().from(chainTx)
        expect(after.map((row) => row.txHash).sort()).toEqual(before.map((row) => row.txHash).sort())
      }, 60_000)
    })

    describe('a Listing whose Stake is more tUSD than the Creator holds', () => {
      it('fails without minting an identity', async () => {
        const listingId = await insertListing({
          payoutWallet: privateKeyToAccount(generatePrivateKey()).address.toLowerCase(),
          // Ten times the price, so the Registry's own rule is satisfied and the
          // balance is the only thing left to fail on.
          stake: (DEMO_MINT * 2n).toString(),
        })

        const result = await runListingVerify({ listing_id: listingId })

        expect(result).toMatchObject({ ok: false, outcome: 'failed', failedAt: 'list' })
        if (result.ok) throw new Error('expected a refusal')
        expect(result.reason).toContain('insufficient tUSD for the Stake')

        const row = await readListing(listingId)
        expect(row.status).toBe('failed')
        expect(row.lastError).toContain('insufficient tUSD')

        // The point of the whole ordering: the balance was read from the real
        // chain and the identity was never minted, so nothing is stranded.
        const rows = await db.select().from(chainTx)
        expect(rows.filter((row) => row.intentKey.endsWith(listingId))).toEqual([])
        expect(row.agentId).toBeNull()
      }, 60_000)
    })

    // ------------------------------------------------------------- fixtures

    async function insertAccount(): Promise<string> {
      const id = newId('account')
      await db.insert(accounts).values({ id, email: `${id}@test.local`, passwordHash: '!' })
      return id
    }

    async function insertListing(options: {
      payoutWallet: string
      stake: string
    }): Promise<string> {
      const id = newId('listing')
      await db.insert(listings).values({
        id,
        creatorAccountId,
        name: 'Binance Ticker',
        description: 'Spot price for a symbol.',
        type: 'data',
        endpoint: 'https://agents.example/binance-ticker',
        declaredPrice: PRICE,
        declaredStake: options.stake,
        payoutWallet: options.payoutWallet,
        status: 'verifying',
        // Story 3.4 replaces the seam with a paid Call; until then this flag is
        // the only way past step 1, and the seed script alone may set it.
        skipVerification: true,
      })
      return id
    }

    async function readListing(listingId: string) {
      const [row] = await db.select().from(listings).where(eq(listings.id, listingId)).limit(1)
      if (!row) throw new Error(`listing ${listingId} disappeared`)
      return row
    }
  },
)

// --------------------------------------------------------------- environment

/**
 * `platform_settings.platform_account_id` references `accounts`, so a cascading
 * truncate takes the AD-10 single row with it and the migration's row is put
 * back verbatim, the mode aside: only `demo` makes `wallet.create` mint (AD-5).
 */
async function resetDatabase(mode: 'demo' | 'production'): Promise<void> {
  await db.execute(sql`
    truncate chain_tx, settlements, calls, runs, workflow_nodes, workflows, listings, wallets, accounts
    restart identity cascade
  `)
  await db
    .insert(platformSettings)
    .values({
      id: 1,
      mode,
      emergencyStop: false,
      orderCeilingUsdt: '1000',
      defaultDailyFeeBudget: '1000000',
      verificationCapDaily: '5000000',
    })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { mode, emergencyStop: false, platformAccountId: null },
    })
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
  const body = (await response.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result as T
}

/**
 * Everything this suite needs, checked before it runs, so a missing chain reads
 * as one skipped suite naming what is missing rather than a wall of failures.
 */
async function unavailableReason(): Promise<string | null> {
  let addresses: ContractAddresses
  try {
    addresses = assertDeployed(addressesFor(CHAIN_ID))
  } catch (error) {
    return message(error)
  }

  try {
    const chainId = Number(await rpc<string>('eth_chainId', []))
    if (chainId !== CHAIN_ID) {
      return `the node at ${RPC_URL} is chain ${chainId}, not ${CHAIN_ID}`
    }
    for (const [name, address] of Object.entries(addresses)) {
      if ((await rpc<string>('eth_getCode', [address, 'latest'])) === '0x') {
        return `no contract code for ${name} at ${address} on ${RPC_URL}`
      }
    }
    // A real network would refuse this, and so it should: the fixture funds its
    // own wallets and this test must never run against one.
    await rpc('anvil_setBalance', [PROBE_ADDRESS, '0x1'])
  } catch (error) {
    return `${RPC_URL} is not a usable development node: ${message(error)}`
  }

  try {
    const probe = createDb({ url: TEST_DATABASE_URL, max: 1 })
    await probe.execute(sql`select 1`)
  } catch {
    return `no database at ${TEST_DATABASE_URL}`
  }

  return null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
