import { toDecimalUsdt } from "@agent-desk/schemas"
import {
  decidePause,
  decidePrice,
  decideTopUp,
  isPaused,
  requiredStake,
  type ListingTerms,
} from "../api/listings/manage-rules.ts"
import type { ListingDetailResponse } from "../api/listings/listing-progress.ts"

/**
 * The manage page's state, as data (Story 3.6, FR-7, FR-8, FR-9).
 *
 * Everything the page decides — whether a price is allowed, what the shortfall
 * would be, what the two buttons say, what a top-up would make the Stake — is a
 * pure function here over `manage-rules.ts`, which is what the three routes
 * apply. So the browser refuses for the same reason and in the same words the
 * server would, and `manage-view.tsx` is only inputs and labels.
 */

/** The Listing's terms as the chain-owned cache holds them, from the API body. */
export function termsOf(listing: ListingDetailResponse): ListingTerms {
  return {
    price: BigInt(listing.price),
    stake: BigInt(listing.stake),
    pausedByCreator: listing.paused_by_creator,
    pausedByStake: listing.paused_by_stake,
  }
}

/** A refusal the page can make before it asks, or null when it may ask. */
export function priceError(price: string, terms: ListingTerms): string | null {
  if (price.trim().length === 0) return null
  const decision = decidePrice(price, terms)
  return decision.ok ? null : decision.refusal.message
}

export function topUpError(amount: string): string | null {
  if (amount.trim().length === 0) return null
  const decision = decideTopUp(amount)
  return decision.ok ? null : decision.refusal.message
}

/** True when the field holds something the routes would accept. */
export function canSubmitPrice(price: string, terms: ListingTerms): boolean {
  return price.trim().length > 0 && decidePrice(price, terms).ok
}

export function canSubmitTopUp(amount: string): boolean {
  return amount.trim().length > 0 && decideTopUp(amount).ok
}

/** FR-8: the pause switch, and what it would do next. */
export interface PauseAction {
  /** The value the route would be sent. */
  next: boolean
  label: string
  /** Why the button is where it is, in one line. */
  detail: string
  /** True when pressing it would send a transaction that changes nothing. */
  disabled: boolean
}

export function pauseAction(terms: ListingTerms): PauseAction {
  const next = !terms.pausedByCreator
  const allowed = decidePause(next, terms).ok

  if (terms.pausedByCreator) {
    return {
      next,
      label: "Resume",
      detail: terms.pausedByStake
        ? "You paused this Listing. Its Stake is exhausted as well, so it stays paused until you top up."
        : "Paused by you. No new Run can select it; a Run already running finishes at its locked price.",
      disabled: !allowed,
    }
  }

  if (terms.pausedByStake) {
    return {
      next,
      label: "Pause",
      detail:
        "This Listing is paused because its Stake is exhausted. A top-up to ten times the price resumes it; the switch below is yours and is currently off.",
      disabled: !allowed,
    }
  }

  return {
    next,
    label: "Pause",
    detail:
      "Live. Pausing takes it out of the Workflow Builder and out of every new Run; a Run already running finishes at its locked price.",
    disabled: !allowed,
  }
}

/** FR-7: what the Stake would be after this top-up, as decimal tUSD. */
export function stakeAfter(amount: string, terms: ListingTerms): string | null {
  const decision = decideTopUp(amount)
  return decision.ok ? toDecimalUsdt(terms.stake + decision.value) : null
}

/** FR-9: the Stake the current price needs, which is what a change is measured against. */
export function stakeFloor(terms: ListingTerms): string {
  return toDecimalUsdt(requiredStake(terms.price))
}

/** The two flags in one word, the way a Builder reads the card. */
export function pauseSummary(terms: ListingTerms): string {
  if (!isPaused(terms)) return "live"
  if (terms.pausedByCreator && terms.pausedByStake) return "paused by you and by Stake"
  return terms.pausedByCreator ? "paused by you" : "paused by Stake"
}
