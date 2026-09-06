import { count, eq, like } from 'drizzle-orm'
import { privateKeyToAccount } from 'viem/accounts'
import { chainTx, listings, platformSettings, wallets, type Database } from '@agent-desk/db'
import {
  addressesFor,
  assertDeployed,
  createChainReader,
  createPublicChainClient,
} from '@agent-desk/adapters/chain'
import {
  checkFloors,
  checkPublicBaseUrl,
  checkWorkerHeartbeat,
  message,
  probeFacilitator,
  probeRpc,
  type Check,
  type FloorTarget,
} from '../checks.ts'
import type { ScriptsEnv } from '../env.ts'

/**
 * Every check `pnpm doctor` prints, in the order it prints them.
 *
 * One question: can this laptop run the demo right now? Every check prints a
 * number rather than a verdict, because "FAIL  BNB floor: relayer" is not
 * actionable and "0.0031 BNB against a floor of 0.05" is.
 *
 * Nothing here throws. A dead database, an unreachable RPC and a facilitator
 * that never answers are the cases the script exists for, so each of them is a
 * failed check with its reason attached, and the exit code is the only verdict.
 * It is split from `scripts/src/doctor.ts` so a test can import it without the
 * boot sequence that reads the environment and exits the process.
 */

export interface DoctorDeps {
  env: ScriptsEnv
  db: Database
  now?: () => Date
}

export async function collectChecks(deps: DoctorDeps): Promise<Check[]> {
  const { env, db } = deps
  const now = deps.now?.() ?? new Date()
  const checks: Check[] = []

  // ------------------------------------------------------------- database
  let databaseUp = false
  try {
    await db.execute('select 1')
    databaseUp = true
    checks.push({ name: 'database', ok: true, detail: `${redact(env.DATABASE_URL)} answers` })
  } catch (error) {
    checks.push({ name: 'database', ok: false, detail: message(error) })
  }

  // ------------------------------------------------------------------ RPC
  for (const url of env.RPC_URLS) {
    checks.push(await probeRpc(url, env.CHAIN_ID))
  }

  // ---------------------------------------------------------- facilitator
  const facilitator = await probeFacilitator(env.FACILITATOR_URL)
  checks.push(...facilitator.checks)

  // ----------------------------------------------------------- BNB floors
  //
  // The addresses come from three places on purpose: the Platform Wallet from
  // its key, the relayer from the env or the facilitator's `/health` (AD-5
  // keeps that key inside `apps/facilitator`), and the Creators from the
  // database, so a Creator that listed yesterday is checked today.
  const platformAddress = safeAddressOf(env.PLATFORM_WALLET_KEY)
  const targets: FloorTarget[] = []
  if (platformAddress) {
    targets.push({
      label: 'Platform Wallet',
      address: platformAddress,
      floorBnb: env.PLATFORM_WALLET_BNB_FLOOR,
    })
  } else {
    checks.push({
      name: 'BNB floor: Platform Wallet',
      ok: false,
      detail: 'PLATFORM_WALLET_KEY is not a 32-byte hex private key',
    })
  }

  const relayer = env.FACILITATOR_RELAYER_ADDRESS.toLowerCase() || facilitator.relayerAddress
  if (relayer) {
    targets.push({
      label: 'facilitator relayer',
      address: relayer,
      floorBnb: env.FACILITATOR_RELAYER_BNB_FLOOR,
    })
  } else {
    checks.push({
      name: 'BNB floor: facilitator relayer',
      ok: false,
      detail: 'unknown: set FACILITATOR_RELAYER_ADDRESS, or start the facilitator',
    })
  }

  if (databaseUp) {
    for (const address of await creatorAddresses(db, env, platformAddress)) {
      targets.push({ label: `Creator ${address}`, address, floorBnb: env.CREATOR_WALLET_BNB_FLOOR })
    }
  }

  try {
    const reader = createChainReader({
      publicClient: createPublicChainClient({ chainId: env.CHAIN_ID, rpcUrls: env.RPC_URLS }),
      addresses: assertDeployed(addressesFor(env.CHAIN_ID)),
    })
    checks.push(...(await checkFloors(targets, reader.nativeBalance)))
  } catch (error) {
    // AD-10: `assertDeployed` refuses a `deployments/<chain id>.json` still
    // holding the zero address, which is a contract problem, not a funding one.
    checks.push({
      name: 'contracts deployed',
      ok: false,
      detail: `deployments/${env.CHAIN_ID}.json: ${message(error)}`,
    })
  }

  if (!databaseUp) {
    checks.push({
      name: 'worker heartbeat',
      ok: false,
      detail: 'unknown: the database did not answer',
    })
    checks.push({ name: 'PUBLIC_BASE_URL', ok: false, detail: 'unknown: the database did not answer' })
    return checks
  }

  // ----------------------------------------------------- worker heartbeat
  const [settings] = await db
    .select({ workerSeenAt: platformSettings.workerSeenAt })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)
  checks.push(checkWorkerHeartbeat(settings?.workerSeenAt ?? null, now))

  // ------------------------------------------------------ PUBLIC_BASE_URL
  const [identity] = await db
    .select({ rows: count() })
    .from(chainTx)
    .where(like(chainTx.intentKey, 'identity:%'))
  checks.push(checkPublicBaseUrl(env.PUBLIC_BASE_URL, identity?.rows ?? 0))

  return checks
}

/** Every wallet that has put a Listing on chain, plus a Creator key from the env. */
async function creatorAddresses(
  db: Database,
  env: ScriptsEnv,
  platformAddress: string | null,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ address: wallets.address })
    .from(wallets)
    .innerJoin(listings, eq(listings.creatorAccountId, wallets.accountId))
  const found = new Set(rows.map((row) => row.address.toLowerCase()))
  if (env.DEMO_CREATOR_ADDRESS !== '') found.add(env.DEMO_CREATOR_ADDRESS.toLowerCase())
  if (platformAddress) found.delete(platformAddress)
  return [...found].sort()
}

function safeAddressOf(privateKey: string): string | null {
  try {
    return privateKeyToAccount(privateKey as `0x${string}`).address.toLowerCase()
  } catch {
    return null
  }
}

function redact(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl)
    if (url.password) url.password = '***'
    return url.toString()
  } catch {
    return databaseUrl
  }
}
