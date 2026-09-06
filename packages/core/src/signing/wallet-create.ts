import { intentKeys, newId, type WalletCreateJob } from '@agent-desk/schemas'
import type {
  Address,
  ChainReader,
  Clock,
  ContractCalls,
  Logger,
  Signer,
  SigningStore,
  WalletRecord,
  WalletStore,
} from '../ports/index.ts'
import { silentLogger, systemClock } from '../ports/index.ts'
import type { ChainWriteResult, ChainWriter } from './chain-writer.ts'
import type { PolicyRefusal } from './policy.ts'

/**
 * AD-5 / FR-2: the body of the pg-boss job `wallet.create { account_id }`
 * (singleton key `account_id`). The worker of a later story registers this;
 * `scripts/` calls it directly from `pnpm seed`.
 *
 * Four steps, in this order, every one of them idempotent:
 *
 *   1. the key — generated and stored encrypted, with the `wallets` row;
 *   2. `gas:<wallet_id>`   — BNB from the Platform Wallet up to `WALLET_GAS_FLOOR`;
 *   3. `mint:<wallet_id>`  — tUSD, demo mode only (AD-5);
 *   4. `approve:<wallet_id>` — `tUSD.approve(registry, max)` signed by the new
 *      wallet, whose receipt sets `wallets.ready_at`.
 *
 * A job redelivered after a crash resumes at the first intent that is not
 * `confirmed`: steps 2 to 4 go through `chainWrite`, which finds the existing
 * `chain_tx` row and sends nothing (AD-8), and step 1 finds the existing
 * `wallets` row. Nothing here counts attempts or holds state between runs; the
 * rows are the state.
 *
 * Listings, Runs, and `listing.write` answer 409 `wallet_not_ready` until step 4
 * lands, so a first Run can never fail on a missing approval (FR-2).
 */

/** ERC-20 infinite allowance: approve once, never again. */
export const MAX_UINT256 = (1n << 256n) - 1n

export type WalletCreationStep = 'gas' | 'mint' | 'approve'

export type StepOutcome =
  /** A transaction was built and confirmed in this run. */
  | 'sent'
  /** A `chain_tx` row already existed; nothing was sent (AD-8). */
  | 'reused'
  /** Not needed: the wallet was already at the floor, or the mode is production. */
  | 'skipped'

export interface WalletCreationDeps {
  /** FR-2: the key is generated inside the Signer port and stored encrypted. */
  signer: Pick<Signer, 'generateKey'>
  wallets: WalletStore
  store: SigningStore
  chain: ChainWriter
  reader: ChainReader
  calls: ContractCalls
  clock?: Clock
  logger?: Logger
  config: WalletCreationConfig
}

export interface WalletCreationConfig {
  /** The Platform Wallet's `wallets.id`; it funds every new wallet's gas. */
  platformWalletId: string
  /** `WALLET_GAS_FLOOR` in wei: how much BNB a new wallet is topped up to. */
  walletGasFloorWei: bigint
  /** `PLATFORM_WALLET_BNB_FLOOR` in wei: the floor the funding wallet is held to. */
  platformGasFloorWei: bigint
  /**
   * Base units minted in demo mode. `TUSD.MINT_CAP` is 1,000 tUSD per call, so
   * this may not exceed 1_000_000_000.
   */
  demoMintAmount: bigint
}

export type WalletCreationResult =
  | {
      ok: true
      walletId: string
      address: Address
      /** True when this run generated the key, false when it resumed. */
      created: boolean
      readyAt: Date
      steps: Record<WalletCreationStep, StepOutcome>
    }
  | {
      ok: false
      walletId: string
      address: Address
      created: boolean
      failedAt: WalletCreationStep
      reason: string
      refusal?: PolicyRefusal
      steps: Partial<Record<WalletCreationStep, StepOutcome>>
    }

export function createWalletCreationJob(deps: WalletCreationDeps) {
  const clock = deps.clock ?? systemClock
  const logger = deps.logger ?? silentLogger
  const { config, calls } = deps

  if (config.demoMintAmount > 1_000_000_000n) {
    throw new Error(`demoMintAmount ${config.demoMintAmount} exceeds TUSD.MINT_CAP of 1,000 tUSD`)
  }

  return async function runWalletCreate(job: WalletCreateJob): Promise<WalletCreationResult> {
    const accountId = job.account_id
    const { wallet, created } = await ensureWallet(accountId)
    const steps: Partial<Record<WalletCreationStep, StepOutcome>> = {}

    const fail = (
      failedAt: WalletCreationStep,
      reason: string,
      refusal?: PolicyRefusal,
    ): WalletCreationResult => {
      logger.error(
        { account_id: accountId, wallet_id: wallet.id, step: failedAt, reason },
        'wallet.create failed',
      )
      return {
        ok: false,
        walletId: wallet.id,
        address: wallet.address,
        created,
        failedAt,
        reason,
        ...(refusal ? { refusal } : {}),
        steps,
      }
    }

    // ---------------------------------------------------------------- gas
    const gas = await runGasTopUp(wallet)
    if (!gas.ok) return fail('gas', gas.reason, gas.refusal)
    steps.gas = gas.outcome

    // --------------------------------------------------------------- mint
    const settings = await deps.store.platformSettings()
    const mint = await runMint(wallet, settings.mode === 'demo')
    if (!mint.ok) return fail('mint', mint.reason, mint.refusal)
    steps.mint = mint.outcome

    // ------------------------------------------------------------ approve
    const approve = await runApprove(wallet)
    if (!approve.ok) return fail('approve', approve.reason, approve.refusal)
    steps.approve = approve.outcome

    // AD-5: `ready_at` comes from the approve receipt, and from nothing else.
    const readyAt = approve.confirmedAt ?? clock.now()
    await deps.wallets.markReady(wallet.id, readyAt)
    logger.info(
      { account_id: accountId, wallet_id: wallet.id, address: wallet.address, ready_at: readyAt.toISOString() },
      'wallet ready',
    )

    return {
      ok: true,
      walletId: wallet.id,
      address: wallet.address,
      created,
      readyAt,
      steps: steps as Record<WalletCreationStep, StepOutcome>,
    }
  }

  /**
   * Step 1. The account lookup, not the key, is what makes this idempotent: a
   * retry after a crash between `generateKey` and the insert would otherwise
   * strand a funded address nobody owns.
   */
  async function ensureWallet(accountId: string): Promise<{ wallet: WalletRecord; created: boolean }> {
    const existing = await deps.wallets.findByAccount(accountId)
    if (existing) return { wallet: existing, created: false }

    const key = await deps.signer.generateKey()
    const wallet = await deps.wallets.insert({
      id: newId('wallet'),
      accountId,
      address: key.address.toLowerCase(),
      encryptedKey: key.encryptedKey,
    })
    logger.info({ account_id: accountId, wallet_id: wallet.id, address: wallet.address }, 'wallet created')
    return { wallet, created: true }
  }

  /**
   * Step 2. Signed by the Platform Wallet, which is held to its own BNB floor.
   * The top-up is skipped only when no `gas:` row exists *and* the wallet is
   * already at the floor; once a row exists it is the authority, so a resume
   * never reads a balance and never sends a second transaction.
   */
  async function runGasTopUp(wallet: WalletRecord): Promise<StepResult> {
    const intentKey = intentKeys.gas(wallet.id)
    const existing = await deps.chain.chainWrite(intentKey, async () => {
      const balance = await deps.reader.nativeBalance(wallet.address)
      const topUp = config.walletGasFloorWei - balance
      if (topUp <= 0n) throw new AlreadyFunded()
      const call = calls.nativeTransfer(wallet.address, topUp)
      return {
        walletId: config.platformWalletId,
        to: call.to,
        data: call.data,
        value: topUp,
        gasFloorWei: config.platformGasFloorWei,
        payload: {
          wallet_id: wallet.id,
          to: wallet.address,
          top_up_wei: topUp.toString(),
          floor_wei: config.walletGasFloorWei.toString(),
        },
      }
    }).catch(skipWhenAlreadyFunded)

    return toStepResult(intentKey, existing)
  }

  /** Step 3. Demo mode only (AD-5); signed by the new wallet, which now has gas. */
  async function runMint(wallet: WalletRecord, demoMode: boolean): Promise<StepResult> {
    if (!demoMode) return { ok: true, outcome: 'skipped', confirmedAt: null }
    const intentKey = intentKeys.mint(wallet.id)
    const call = calls.tusdMint(wallet.address, config.demoMintAmount)
    const result = await deps.chain.chainWrite(intentKey, () => ({
      walletId: wallet.id,
      to: call.to,
      data: call.data,
      gasFloorWei: config.walletGasFloorWei,
      payload: {
        wallet_id: wallet.id,
        to: wallet.address,
        amount: config.demoMintAmount.toString(),
      },
    }))
    return toStepResult(intentKey, result)
  }

  /**
   * Step 4. `tUSD.approve(registry, max)` signed by the new wallet. It is the
   * approval FR-2 requires so a first Run never fails on it, and its receipt is
   * the only thing that sets `wallets.ready_at`.
   */
  async function runApprove(wallet: WalletRecord): Promise<StepResult> {
    const intentKey = intentKeys.approve(wallet.id)
    const call = calls.tusdApprove(calls.addresses.registry, MAX_UINT256)
    const result = await deps.chain.chainWrite(intentKey, () => ({
      walletId: wallet.id,
      to: call.to,
      data: call.data,
      gasFloorWei: config.walletGasFloorWei,
      payload: {
        wallet_id: wallet.id,
        spender: calls.addresses.registry,
        value: MAX_UINT256.toString(),
      },
    }))
    return toStepResult(intentKey, result)
  }

  function toStepResult(intentKey: string, result: ChainWriteResult | SkippedWrite): StepResult {
    if ('skipped' in result) return { ok: true, outcome: 'skipped', confirmedAt: null }
    if (result.refusal) {
      return { ok: false, reason: result.refusal.message, refusal: result.refusal }
    }
    if (result.record.status === 'confirmed') {
      return {
        ok: true,
        outcome: result.reused ? 'reused' : 'sent',
        confirmedAt: result.record.confirmedAt,
      }
    }
    return {
      ok: false,
      reason: `${intentKey} is ${result.record.status}${result.record.txHash ? ` (${result.record.txHash})` : ''}`,
    }
  }
}

interface SkippedWrite {
  skipped: true
}

type StepResult =
  | { ok: true; outcome: StepOutcome; confirmedAt: Date | null }
  | { ok: false; reason: string; refusal?: PolicyRefusal }

/** Thrown out of `buildTx` when the wallet is already at the BNB floor. */
class AlreadyFunded extends Error {
  constructor() {
    super('wallet already holds the gas floor')
  }
}

function skipWhenAlreadyFunded(error: unknown): SkippedWrite {
  if (error instanceof AlreadyFunded) return { skipped: true }
  throw error
}
