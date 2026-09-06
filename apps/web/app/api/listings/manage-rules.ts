import { asDecimalUsdt, toBaseUnits, toDecimalUsdt } from '@agent-desk/schemas'
import { STAKE_MULTIPLE, validatePrice } from './listing-rules.ts'
import type { Refusal } from './create-listing.ts'

/**
 * FR-7, FR-8, FR-9: every rule the manage page enforces, and the sentence each
 * one refuses with (Story 3.6).
 *
 * Pure, and importing nothing but the unit conversions and the form's own price
 * rule, for the same reason `listing-rules.ts` is: the three buttons in the
 * browser and the three routes on the server apply one definition rather than
 * two that drift. `listing.write` then re-checks the same two conditions inside
 * the wallet lock, because the cache can move between the button and the
 * signature and the Creator is the one paying the gas.
 */

/** The Listing's terms as the chain-owned cache holds them (AD-2). */
export interface ListingTerms {
  /** Base units. */
  price: bigint
  stake: bigint
  /** The Creator's own switch, which is the only one this page can toggle. */
  pausedByCreator: boolean
  /** Set by the contract when a slash empties the Stake; cleared by a top-up. */
  pausedByStake: boolean
}

export type Decision<T> = { ok: true; value: T } | { ok: false; refusal: Refusal }

/** True when either flag is set, which is what "paused" means to a Builder. */
export function isPaused(terms: ListingTerms): boolean {
  return terms.pausedByCreator || terms.pausedByStake
}

/** FR-7: the Stake a Listing must hold at `price`. */
export function requiredStake(price: bigint): bigint {
  return price * STAKE_MULTIPLE
}

/**
 * FR-9: a new price per call.
 *
 * The same ceiling and the same precision as the listing form — a price is a
 * price — and then the one rule that only a Listing already on chain can break:
 * `AgentDeskRegistry.setPrice` reverts when ten times the new price is above the
 * Stake it holds. Refusing here, before the job is even enqueued, is what lets
 * the page name the shortfall instead of showing a revert.
 */
export function decidePrice(price: string, terms: ListingTerms): Decision<bigint> {
  const parsed = validatePrice(price)
  if (!parsed.ok) {
    return {
      ok: false,
      refusal: {
        code: 'validation_failed',
        message: parsed.message,
        details: { field: 'price' },
      },
    }
  }

  const required = requiredStake(parsed.baseUnits)
  if (terms.stake < required) {
    const shortfall = required - terms.stake
    return {
      ok: false,
      refusal: {
        code: 'refused_stake',
        message:
          `a price of ${toDecimalUsdt(parsed.baseUnits)} tUSD needs at least ` +
          `${toDecimalUsdt(required)} tUSD of Stake, and this Listing holds ` +
          `${toDecimalUsdt(terms.stake)} tUSD. Top up ${toDecimalUsdt(shortfall)} tUSD first.`,
        details: {
          price: parsed.baseUnits.toString(),
          stake: terms.stake.toString(),
          required: required.toString(),
          shortfall: shortfall.toString(),
        },
      },
    }
  }

  return { ok: true, value: parsed.baseUnits }
}

/**
 * FR-7: a top-up, in tUSD the Creator's System Wallet holds. There is no
 * ceiling — Stake only ever protects a Builder — and no minimum but "more than
 * nothing", which is the Registry's own `ZeroAmount` revert said first.
 *
 * The balance is not checked here: this route holds no chain client (AD-1), and
 * `listing.write` reads it inside the wallet lock, where the answer is still
 * true when the transaction is signed.
 */
export function decideTopUp(amount: string): Decision<bigint> {
  let baseUnits: bigint
  try {
    baseUnits = toBaseUnits(asDecimalUsdt(amount.trim()))
  } catch {
    return {
      ok: false,
      refusal: {
        code: 'validation_failed',
        message: `${amount} is not an amount in tUSD (at most 6 decimal places)`,
        details: { field: 'amount' },
      },
    }
  }
  if (baseUnits <= 0n) {
    return {
      ok: false,
      refusal: {
        code: 'validation_failed',
        message: 'the top-up must be more than 0 tUSD',
        details: { field: 'amount' },
      },
    }
  }
  return { ok: true, value: baseUnits }
}

/**
 * FR-8: the Creator's pause switch, and only that one.
 *
 * `pausedByStake` belongs to the contract: it is set when a slash empties the
 * Stake and cleared by `addStake` once the Stake is back at the floor. A
 * Creator who presses Resume on a Listing the Stake paused would send a
 * transaction that changes nothing, so this says what would actually clear it.
 */
export function decidePause(paused: boolean, terms: ListingTerms): Decision<boolean> {
  if (paused === terms.pausedByCreator) {
    return {
      ok: false,
      refusal: {
        code: 'validation_failed',
        message: paused
          ? 'this Listing is already paused by you'
          : terms.pausedByStake
            ? 'this Listing is paused because its Stake is exhausted; a top-up is what resumes it'
            : 'this Listing is not paused by you',
        details: { field: 'paused' },
      },
    }
  }
  return { ok: true, value: paused }
}
