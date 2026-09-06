import { describe, expect, it } from "vitest"
import { intentKeys } from "@agent-desk/schemas"
import type { ChainTxView, ListingDetailResponse } from "../api/listings/listing-progress.ts"
import { listingQueryKey } from "./listing-query.ts"
import { MANAGE_POLL_MS, manageHref, manageRefetchInterval } from "./manage-query.ts"
import {
  canSubmitPrice,
  canSubmitTopUp,
  pauseAction,
  pauseSummary,
  priceError,
  stakeAfter,
  stakeFloor,
  termsOf,
  topUpError,
} from "./manage-state.ts"

/**
 * The manage page as decisions rather than as markup (Story 3.6).
 *
 * What is asserted here is what the Creator sees before they press anything:
 * which button is offered, what it would do, what the Stake would become, and
 * the sentence a refused price is refused with — the same sentence the route
 * would answer with, because both sides call `manage-rules.ts`.
 */

const LISTING_ID = "lst_01M1V3XSV6XQ2BDQAZJXW6Q9FJ"

function listing(overrides: Partial<ListingDetailResponse> = {}): ListingDetailResponse {
  return {
    id: LISTING_ID,
    status: "active",
    price: "30000",
    stake: "300000",
    paused_by_creator: false,
    paused_by_stake: false,
    chain_tx: [],
    ...overrides,
  } as ListingDetailResponse
}

const LIVE = termsOf(listing())

describe("the terms the page reads off the Listing", () => {
  it("are the chain-owned columns, as base units (AD-2, AD-13)", () => {
    expect(termsOf(listing({ paused_by_stake: true }))).toEqual({
      price: 30_000n,
      stake: 300_000n,
      pausedByCreator: false,
      pausedByStake: true,
    })
  })

  it("state the Stake the current price needs", () => {
    expect(stakeFloor(LIVE)).toBe("0.3")
  })

  it("say which of the two flags is holding the Listing back", () => {
    expect(pauseSummary(LIVE)).toBe("live")
    expect(pauseSummary({ ...LIVE, pausedByCreator: true })).toBe("paused by you")
    expect(pauseSummary({ ...LIVE, pausedByStake: true })).toBe("paused by Stake")
    expect(pauseSummary({ ...LIVE, pausedByCreator: true, pausedByStake: true })).toBe(
      "paused by you and by Stake",
    )
  })
})

describe("the price field", () => {
  it("says nothing until something is typed", () => {
    expect(priceError("", LIVE)).toBeNull()
    expect(canSubmitPrice("", LIVE)).toBe(false)
  })

  it("refuses a price the Stake cannot carry, in the route's own words", () => {
    expect(priceError("0.05", LIVE)).toContain("Top up 0.2 tUSD")
    expect(canSubmitPrice("0.05", LIVE)).toBe(false)
  })

  it("accepts a price the Stake covers", () => {
    expect(priceError("0.02", LIVE)).toBeNull()
    expect(canSubmitPrice("0.02", LIVE)).toBe(true)
  })
})

describe("the top-up field", () => {
  it("shows what the Stake would become", () => {
    expect(stakeAfter("0.2", LIVE)).toBe("0.5")
    expect(stakeAfter("", LIVE)).toBeNull()
  })

  it("refuses nothing and refuses what is not an amount", () => {
    expect(topUpError("0")).toContain("more than 0")
    expect(topUpError("abc")).toContain("not an amount")
    expect(canSubmitTopUp("0.1")).toBe(true)
    expect(canSubmitTopUp("")).toBe(false)
  })
})

describe("the availability button", () => {
  it("offers Pause on a live Listing and says what pausing costs a Builder", () => {
    const action = pauseAction(LIVE)
    expect(action).toMatchObject({ label: "Pause", next: true, disabled: false })
    expect(action.detail).toContain("locked price")
  })

  it("offers Resume once the Creator has paused it", () => {
    expect(pauseAction({ ...LIVE, pausedByCreator: true })).toMatchObject({
      label: "Resume",
      next: false,
      disabled: false,
    })
  })

  it("does not offer Resume for a pause the Creator did not make (FR-8)", () => {
    const action = pauseAction({ ...LIVE, pausedByStake: true })
    expect(action.label).toBe("Pause")
    expect(action.detail).toContain("top-up to ten times the price resumes it")
  })

  it("still lets a Creator pause a Listing the Stake already paused", () => {
    expect(pauseAction({ ...LIVE, pausedByStake: true }).disabled).toBe(false)
  })
})

// ------------------------------------------------------------------- polling

function tx(status: string): ChainTxView {
  return {
    intent_key: intentKeys.price(LISTING_ID, 1_757_000_000_000),
    status,
    tx_hash: null,
    payload: {},
    created_at: "2026-09-06T09:00:00.000Z",
    confirmed_at: null,
  }
}

describe("the two-second beat the manage page keeps (AD-12)", () => {
  it("polls while a transaction of this Listing is pending, and stops when none is", () => {
    expect(manageRefetchInterval(listing({ chain_tx: [tx("pending")] }))).toBe(MANAGE_POLL_MS)
    expect(manageRefetchInterval(listing({ chain_tx: [tx("confirmed")] }))).toBe(false)
    expect(manageRefetchInterval(listing({ chain_tx: [] }))).toBe(false)
  })

  it("polls while the Listing is still going on chain, whatever its rows say", () => {
    expect(manageRefetchInterval(listing({ status: "verifying" }))).toBe(MANAGE_POLL_MS)
  })

  it("polls until the first answer arrives", () => {
    expect(manageRefetchInterval(undefined)).toBe(MANAGE_POLL_MS)
  })

  it("shares one cache entry with the listing page, so neither shows stale terms", () => {
    expect(manageHref(LISTING_ID)).toBe(`/listings/${LISTING_ID}/manage`)
    expect(listingQueryKey(LISTING_ID)).toEqual(["listing", LISTING_ID])
  })
})
