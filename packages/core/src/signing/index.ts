/**
 * AD-5: the signing layer. Policy and serialisation live here, in the domain;
 * keys, viem, and the x402 wire format live behind the ports in
 * `@agent-desk/core/ports` and are implemented in `packages/adapters`.
 *
 * Only `apps/worker` and `scripts/` may wire an implementation, which is what
 * keeps `MASTER_KEY` out of `apps/web` and out of every agent (AD-1).
 */
export { Mutex, KeyedMutex } from './mutex.ts'
export {
  POLICY_CHECKS,
  STAKE_MULTIPLE,
  STAKE_RESERVING_TYPES,
  bnbToWei,
  checkCreatorStakeMinimum,
  checkDailyFeeBudget,
  checkGasFloor,
  checkStakeReservation,
  checkVerificationCap,
  reservesStake,
  weiToBnb,
  type PolicyCheck,
  type PolicyRefusal,
  type RefusalCode,
  type StakeReservingCall,
} from './policy.ts'
export {
  createSigningService,
  type ChainIntent,
  type PaymentSigningRequest,
  type SentTx,
  type SignedPayment,
  type SigningOutcome,
  type SigningService,
  type SigningServiceDeps,
} from './service.ts'
export type {
  BuildTx,
  ChainReceipt,
  ChainWriteRequest,
  ChainWriteResult,
  ChainWriter,
  ListingRefreshHints,
  ListingRefreshResult,
} from './chain-writer.ts'
export {
  MAX_UINT256,
  WALLET_BOOTSTRAP_GAS_WEI,
  createWalletCreationJob,
  type StepOutcome,
  type WalletCreationConfig,
  type WalletCreationDeps,
  type WalletCreationResult,
  type WalletCreationStep,
} from './wallet-create.ts'
