import {
  baseUnitsToString,
  toDecimalUsdt,
  type AgentType,
  type CallKind,
  type ErrorCode,
} from '@agent-desk/schemas'
import type { BudgetUsage, StakeUsage, VerificationUsage } from '../ports/index.ts'

/**
 * AD-5: the five checks that run inside the wallet lock, as pure functions over
 * two numbers each. They are pure on purpose — the store ports fetch the pair
 * (amount used, limit) and these decide, so a refusal is reproducible in a unit
 * test without a database and the rule text has exactly one implementation.
 *
 * Order, from AD-5 and the Story 1.6 acceptance criteria: Daily Fee Budget,
 * FR-25 stake reservation, Creator ten-times minimum, Platform Wallet
 * verification cap, Creator gas floor. `signPayment` runs the first, second and
 * fourth (whichever apply to the Call's kind); `sendTx` runs the third and
 * fifth. All of them run *before* anything is signed.
 *
 * Four of the five are read-and-decide against a limit only that wallet can
 * move, so the wallet lock is the whole critical section. The FR-25 reservation
 * is not: its limit belongs to the Listing and every Builder paying that
 * Listing spends it, so `createSigningService` holds a second lock keyed by
 * Listing around this one check and the write that follows it.
 */

export const POLICY_CHECKS = [
  'daily_fee_budget',
  'stake_reservation',
  'creator_stake_minimum',
  'verification_cap',
  'gas_floor',
] as const
export type PolicyCheck = (typeof POLICY_CHECKS)[number]

/**
 * AD-14 fixes the error codes; a refusal may only speak in them.
 *
 * `refused_budget` and `refused_stake` are the two the story names. The gas
 * floor is a wallet balance shortfall, not a budget or a stake one, so it
 * answers `refused_balance` — the code AD-14 already reserves for exactly that
 * and the one the Run view can render truthfully.
 */
export type RefusalCode = Extract<ErrorCode, 'refused_budget' | 'refused_stake' | 'refused_balance'>

export interface PolicyRefusal {
  code: RefusalCode
  check: PolicyCheck
  /** Written into `calls.failure_reason` and returned to the caller verbatim. */
  message: string
  details: Record<string, string>
}

/** FR-25 and AD-9 score these two Types, so only they reserve Stake. */
export const STAKE_RESERVING_TYPES: readonly AgentType[] = ['research', 'risk']

/** The two facts FR-25 needs about a Call before it can price the reservation. */
export interface StakeReservingCall {
  kind: CallKind
  nodeType: AgentType
}

/**
 * FR-25, with AD-3 and AD-9 qualified to `kind = 'run'` as the team reconciled
 * them. Two clauses, both necessary:
 *
 *   - only `research` and `risk` are scored, so only they can be slashed;
 *   - only a `run` Call is scored. A `verification` Call never gets a
 *     Settlement, so a reservation taken for one could never be released, and
 *     the Listing being verified has not written its Stake to the cache yet —
 *     `listings.stake` is null until the first confirmed receipt (AD-2). A
 *     verification Call that reserved Stake would therefore refuse every new
 *     Listing its own going-live Call and no Agent could ever be listed.
 */
export function reservesStake(call: StakeReservingCall): boolean {
  return call.kind === 'run' && STAKE_RESERVING_TYPES.includes(call.nodeType)
}

/** FR-7: a Listing's stake must be at least ten times its price per call. */
export const STAKE_MULTIPLE = 10n

const usdt = (base: bigint) => toDecimalUsdt(base < 0n ? 0n : base)

// ------------------------------------------------------- daily fee budget

/**
 * FR-3 / AD-3. `usage.spend` is the one AD-3 spend query; `callCounted` says
 * whether this Call's own row is already inside it, which it is while the Call
 * is `pending` in a still-`running` Run. Adding the amount a second time in
 * that case would refuse a Run the API already admitted.
 */
export function checkDailyFeeBudget(usage: BudgetUsage, amount: bigint): PolicyRefusal | null {
  const required = usage.callCounted ? usage.spend : usage.spend + amount
  if (required <= usage.budget) return null
  const shortfall = required - usage.budget
  return {
    code: 'refused_budget',
    check: 'daily_fee_budget',
    message: `refused: budget. ${usdt(shortfall)} tUSD over the remaining Daily Fee Budget.`,
    details: {
      spend: baseUnitsToString(usage.spend),
      budget: baseUnitsToString(usage.budget),
      amount: baseUnitsToString(amount),
      shortfall: baseUnitsToString(shortfall),
    },
  }
}

// --------------------------------------------------- FR-25 stake reservation

/**
 * FR-25: before paying a `research` or `risk` Agent, its Stake minus the locked
 * prices of its unscored Calls must cover this Call's locked price. Applies to
 * those two Types only — a `data`, `execution`, or `notify` Call is never
 * scored, so it can never be slashed and reserves nothing — and to `kind =
 * 'run'` only, per `reservesStake` above.
 *
 * `usage.reserved` is the AD-3 reservation *query*, not a counter: the Settlement
 * row is what releases a Call's share of it, so a scored Call stops reserving
 * the moment `settlements` has its row, whatever the result. That makes the
 * arithmetic here pure — the caller serialises the read against the write that
 * changes it, which for two Runs on one Listing is `createSigningService`'s
 * per-Listing lock, not the per-wallet one.
 */
export function checkStakeReservation(
  call: StakeReservingCall,
  usage: StakeUsage,
  amount: bigint,
): PolicyRefusal | null {
  if (!reservesStake(call)) return null
  const reserved = usage.callCounted ? usage.reserved : usage.reserved + amount
  if (reserved <= usage.stake) return null
  const shortfall = reserved - usage.stake
  return {
    code: 'refused_stake',
    check: 'stake_reservation',
    message: `stake exhausted: ${usdt(shortfall)} tUSD more Stake is needed to cover this Call.`,
    details: {
      stake: baseUnitsToString(usage.stake),
      reserved: baseUnitsToString(usage.reserved),
      amount: baseUnitsToString(amount),
      shortfall: baseUnitsToString(shortfall),
    },
  }
}

// ------------------------------------------------ Creator ten-times minimum

/**
 * FR-7 / FR-9: the stake floor is ten times the price per call, checked before
 * a `list`, `setPrice`, or stake write is signed. The contract enforces it too
 * and reverts; refusing here means the Creator does not pay gas to be told so,
 * and the Listing keeps its `last_error` free of a revert string that a human
 * cannot read.
 */
export function checkCreatorStakeMinimum(price: bigint, stake: bigint): PolicyRefusal | null {
  const required = price * STAKE_MULTIPLE
  if (stake >= required) return null
  const shortfall = required - stake
  return {
    code: 'refused_stake',
    check: 'creator_stake_minimum',
    message:
      `stake below the minimum: ${usdt(stake)} tUSD against a floor of ${usdt(required)} tUSD ` +
      `(ten times the ${usdt(price)} tUSD price).`,
    details: {
      price: baseUnitsToString(price),
      stake: baseUnitsToString(stake),
      required: baseUnitsToString(required),
      shortfall: baseUnitsToString(shortfall),
    },
  }
}

// ------------------------------------------- Platform Wallet verification cap

/**
 * FR-11: the Platform Wallet pays every verification Call and has its own daily
 * cap for them, separate from any account's Daily Fee Budget. A verification
 * Call belongs to no Run, so the AD-3 `pending` clause cannot apply to it and
 * `callCounted` is false until the Call is paid.
 */
export function checkVerificationCap(usage: VerificationUsage, amount: bigint): PolicyRefusal | null {
  const required = usage.callCounted ? usage.spent : usage.spent + amount
  if (required <= usage.cap) return null
  const shortfall = required - usage.cap
  return {
    code: 'refused_budget',
    check: 'verification_cap',
    message:
      `refused: budget. The Platform Wallet's 24 h verification cap is exhausted by ` +
      `${usdt(shortfall)} tUSD.`,
    details: {
      spent: baseUnitsToString(usage.spent),
      cap: baseUnitsToString(usage.cap),
      amount: baseUnitsToString(amount),
      shortfall: baseUnitsToString(shortfall),
    },
  }
}

// --------------------------------------------------------- Creator gas floor

/**
 * The signing wallet must hold enough BNB to pay for the transaction it is
 * about to send. The floor is per intent, not global: the Platform Wallet is
 * held to `PLATFORM_WALLET_BNB_FLOOR`, a Creator to `CREATOR_WALLET_BNB_FLOOR`,
 * and a wallet that was just topped up to `WALLET_GAS_FLOOR` is held to that,
 * which is why `wallet.create` passes its own floor for `approve:<wallet_id>`.
 */
export function checkGasFloor(balanceWei: bigint, floorWei: bigint): PolicyRefusal | null {
  if (balanceWei >= floorWei) return null
  const shortfall = floorWei - balanceWei
  return {
    code: 'refused_balance',
    check: 'gas_floor',
    message:
      `refused: insufficient balance. The signing wallet holds ${weiToBnb(balanceWei)} BNB ` +
      `against a floor of ${weiToBnb(floorWei)} BNB.`,
    details: {
      balance_wei: balanceWei.toString(),
      floor_wei: floorWei.toString(),
      shortfall_wei: shortfall.toString(),
    },
  }
}

/** Display only. BNB has 18 decimals; never used for a comparison. */
export function weiToBnb(wei: bigint): string {
  const whole = wei / 10n ** 18n
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return fraction === '' ? `${whole}` : `${whole}.${fraction}`
}

/** "0.005" -> 5000000000000000n. Parses an env-supplied BNB floor. */
export function bnbToWei(decimal: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(decimal)) {
    throw new Error(`not a decimal BNB amount: ${decimal}`)
  }
  const [whole = '0', fraction = ''] = decimal.split('.')
  if (fraction.length > 18) throw new Error(`more than 18 decimal places: ${decimal}`)
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0') || '0')
}
