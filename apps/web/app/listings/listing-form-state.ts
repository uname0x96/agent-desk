import { AGENT_TYPES, toDecimalUsdt, type AgentType, type CreateListingRequest } from "@agent-desk/schemas"
import {
  STAKE_MULTIPLE,
  validateListing,
  validatePrice,
  validateStake,
  type FieldErrors,
} from "../api/listings/listing-rules.ts"
import type { ListingDetailResponse } from "../api/listings/listing-progress.ts"

/**
 * The listing form's state, as data (Story 3.3, FR-10).
 *
 * Everything the form decides — what the Stake should be, what a submission
 * costs, which fields are wrong, what a failed Listing pre-fills with — is a
 * pure function here, so it is tested without a DOM and so the browser applies
 * the same rules `POST /api/listings` will. `listing-form.tsx` is then only
 * inputs and labels.
 */

export interface ListingFormValues {
  name: string
  type: AgentType
  endpoint: string
  /** Decimal tUSD, as typed. */
  price: string
  /** Decimal tUSD, as typed. Defaults to ten times the price. */
  stake: string
  description: string
  payoutWallet: string
}

/** `data` first: it is the cheapest Type and the one a first Listing usually is. */
export const DEFAULT_TYPE: AgentType = "data"

export const EMPTY_LISTING_FORM: ListingFormValues = {
  name: "",
  type: DEFAULT_TYPE,
  endpoint: "",
  price: "",
  stake: "",
  description: "",
  payoutWallet: "",
}

/**
 * FR-14: an `execution` Agent places real orders, so the Type is offered only to
 * the Platform Account. The page reads `platform_settings.platform_account_id`
 * on the server and says which list this is.
 */
export function offeredTypes(canListExecution: boolean): readonly AgentType[] {
  return canListExecution ? AGENT_TYPES : AGENT_TYPES.filter((type) => type !== "execution")
}

/** Ten times the price, as decimal tUSD; empty while the price is unusable. */
export function stakeSuggestion(price: string): string {
  const parsed = validatePrice(price)
  return parsed.ok ? toDecimalUsdt(parsed.baseUnits * STAKE_MULTIPLE) : ""
}

/**
 * Typing a price moves the Stake with it, until the Creator sets a Stake of
 * their own — after which the number they typed is never overwritten behind
 * their back.
 */
export function withPrice(
  values: ListingFormValues,
  price: string,
  stakeTouched: boolean,
): ListingFormValues {
  if (stakeTouched) return { ...values, price }
  return { ...values, price, stake: stakeSuggestion(price) }
}

/**
 * What the Creator is about to spend, in the two amounts that leave a wallet:
 * the Stake the Registry pulls from their System Wallet, and the one
 * verification Call the platform pays their endpoint at the declared price
 * (FR-11) — the platform's money, and the ceiling on it, not theirs.
 */
export interface ListingCost {
  stake: string | null
  maxVerification: string | null
}

export function listingCost(values: ListingFormValues): ListingCost {
  const price = validatePrice(values.price)
  // The multiple is not checked here: this is what the numbers on screen mean,
  // not whether they are allowed. `formErrors` says that, in its own words.
  const stake = validateStake(values.stake, null)
  return {
    stake: stake.ok ? toDecimalUsdt(stake.baseUnits) : null,
    maxVerification: price.ok ? toDecimalUsdt(price.baseUnits) : null,
  }
}

/** The request body, exactly as `createListingRequest` defines it (AD-14). */
export function toCreateRequest(values: ListingFormValues): CreateListingRequest {
  const description = values.description.trim()
  const payoutWallet = values.payoutWallet.trim()
  return {
    name: values.name.trim(),
    type: values.type,
    endpoint: values.endpoint.trim(),
    price: values.price.trim(),
    stake: values.stake.trim(),
    ...(description === "" ? {} : { description }),
    ...(payoutWallet === "" ? {} : { payout_wallet: payoutWallet }),
  }
}

/**
 * The same refusals the route would answer with, applied before the request is
 * made. Nothing here is a second definition: it is `validateListing` itself.
 */
export function formErrors(values: ListingFormValues): FieldErrors {
  const result = validateListing(toCreateRequest(values))
  return result.ok ? {} : result.errors
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0
}

/**
 * FR-12: "fix and resubmit" opens this form on what the Creator already typed,
 * so the one field that was wrong is the only one they have to touch.
 *
 * The declared amounts are used rather than the chain-owned ones, because a
 * Listing that failed never reached the chain and its `price` column is null.
 */
export function prefillFrom(listing: ListingDetailResponse): ListingFormValues {
  return {
    name: listing.name,
    type: listing.type,
    endpoint: listing.endpoint,
    price: toDecimalUsdt(listing.declared_price),
    stake: toDecimalUsdt(listing.declared_stake),
    description: listing.description ?? "",
    payoutWallet: listing.payout_wallet ?? "",
  }
}
