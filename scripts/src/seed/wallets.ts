import { intentKeys, toDecimalUsdt } from '@agent-desk/schemas'
import type { createContractCalls } from '@agent-desk/adapters/chain'
import { bnbToWei } from '@agent-desk/core/signing'
import type { ScriptsEnv } from '../env.ts'
import type { Engine } from '../wiring/index.ts'
import { SeedRefused } from './refusal.ts'

/**
 * The two wallet steps every seeded Account goes through, lifted out of
 * `run.ts` when Story 2.10 gave the seed six Accounts instead of two.
 *
 * Nothing here is new behaviour; both functions are Story 1.10's, unchanged.
 */

export interface ReadyWallet {
  walletId: string
  address: string
}

/**
 * AD-5: `ready_at` comes from the `approve:<wallet_id>` receipt and from nothing
 * else, so "wait for `ready_at`" is just "run the job and read what it returns".
 * A second run resumes onto the confirmed `chain_tx` rows and sends nothing.
 *
 * `runWalletCreate` is the same function body `apps/worker` registers for the
 * `wallet.create` queue — the seam `packages/core/signing/wallet-create.ts`
 * documents — so a seeded Account's wallet is created by the identical code path
 * a real sign-up takes, not by a shortcut.
 */
export async function ensureWalletReady(
  engine: Engine,
  accountId: string,
  label: string,
  log: (line: string) => void,
): Promise<ReadyWallet> {
  const result = await engine.runWalletCreate({ account_id: accountId })
  if (!result.ok) {
    throw new SeedRefused(`${label}: wallet.create failed at ${result.failedAt}: ${result.reason}`)
  }
  log(
    `${label.padEnd(18)} ${result.walletId}  ${result.address}  ready ${result.readyAt.toISOString()}` +
      `  [gas ${result.steps.gas}, mint ${result.steps.mint}, approve ${result.steps.approve}]`,
  )
  return { walletId: result.walletId, address: result.address }
}

/**
 * FR-44 / AD-5: the Platform Wallet needs tUSD to post a Stake and the Builder
 * needs tUSD to pay for a Run, and in `production` mode `wallet.create` skips
 * its mint step, so the seed does it.
 *
 * The intent key is `mint:<wallet_id>` — the same key `wallet.create` uses in
 * demo mode, so exactly one mint per wallet exists whichever path ran first
 * (AD-8). The signer, though, is always the Platform Wallet: `tUSD.mint` is
 * permissionless and takes the recipient as an argument, and a wallet that was
 * just topped up to `WALLET_GAS_FLOOR` and then spent part of it on its own
 * `approve` no longer clears that floor.
 */
export async function ensureTusd(
  engine: Engine,
  calls: ReturnType<typeof createContractCalls>,
  env: ScriptsEnv,
  walletId: string,
  address: string,
  platformWalletId: string,
  log: (line: string) => void,
): Promise<void> {
  const intentKey = intentKeys.mint(walletId)
  const amount = env.DEMO_MINT_AMOUNT
  const result = await engine.chain.chainWrite(intentKey, () => {
    const call = calls.tusdMint(address, amount)
    return {
      walletId: platformWalletId,
      to: call.to,
      data: call.data,
      gasFloorWei: bnbToWei(env.PLATFORM_WALLET_BNB_FLOOR),
      payload: {
        wallet_id: walletId,
        to: address,
        amount: amount.toString(),
        minted_by: platformWalletId,
      },
    }
  })
  if (result.refusal) throw new SeedRefused(`${intentKey}: ${result.refusal.message}`)
  if (result.record.status !== 'confirmed') {
    throw new SeedRefused(`${intentKey} is ${result.record.status}; tUSD was not minted`)
  }
  log(
    `tUSD               ${toDecimalUsdt(amount)} tUSD to ${address}  ` +
      `(${result.reused ? 'already minted' : 'minted'})`,
  )
}
