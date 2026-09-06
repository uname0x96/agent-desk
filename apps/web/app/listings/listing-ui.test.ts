import { describe, expect, it } from "vitest"
import { ApiError } from "../../lib/api.ts"
import type { ListingDetailResponse } from "../api/listings/listing-progress.ts"
import {
  EMPTY_LISTING_FORM,
  formErrors,
  listingCost,
  offeredTypes,
  prefillFrom,
  stakeSuggestion,
  toCreateRequest,
  withPrice,
  type ListingFormValues,
} from "./listing-form-state.ts"
import {
  LISTING_POLL_MS,
  listingQueryOptions,
  listingRefetchInterval,
  resubmitHref,
} from "./listing-query.ts"

/**
 * The listing form and the listing page, as decisions rather than as markup
 * (Story 3.3). Everything asserted here is what a Creator sees: the Stake that
 * appears when they type a price, the two amounts the form warns them about, the
 * field that is wrong, and the two-second beat the progress view keeps.
 */

const FILLED: ListingFormValues = {
  name: "Sloppy Research",
  type: "research",
  endpoint: "http://host.docker.internal:4103",
  price: "0.03",
  stake: "0.3",
  description: "",
  payoutWallet: "",
}

describe("the Type field", () => {
  it("offers execution to nobody but the Platform Account (FR-14)", () => {
    expect(offeredTypes(false)).toEqual(["data", "research", "risk", "notify"])
    expect(offeredTypes(true)).toContain("execution")
  })
})

describe("the Stake the form suggests", () => {
  it("is ten times the price, the moment a price is typed", () => {
    expect(stakeSuggestion("0.03")).toBe("0.3")
    expect(stakeSuggestion("0.005")).toBe("0.05")
  })

  it("is empty while the price is not yet an amount", () => {
    expect(stakeSuggestion("")).toBe("")
    expect(stakeSuggestion("0.")).toBe("")
  })

  it("follows the price until the Creator sets a Stake of their own", () => {
    const typed = withPrice(EMPTY_LISTING_FORM, "0.03", false)
    expect(typed).toMatchObject({ price: "0.03", stake: "0.3" })

    // Once they have touched it, their number survives the next keystroke in
    // the price field.
    const kept = withPrice({ ...typed, stake: "1" }, "0.05", true)
    expect(kept).toMatchObject({ price: "0.05", stake: "1" })
  })
})

describe("what the form tells a Creator it will cost", () => {
  it("shows the Stake the Registry pulls and the most one verification Call can cost", () => {
    expect(listingCost(FILLED)).toEqual({ stake: "0.3", maxVerification: "0.03" })
  })

  it("shows neither until the numbers are amounts", () => {
    expect(listingCost(EMPTY_LISTING_FORM)).toEqual({ stake: null, maxVerification: null })
  })

  it("still shows the numbers when the Stake is too small, and refuses separately", () => {
    const tooSmall = { ...FILLED, stake: "0.1" }

    expect(listingCost(tooSmall)).toEqual({ stake: "0.1", maxVerification: "0.03" })
    expect(formErrors(tooSmall).stake).toContain("at least ten times the price")
  })
})

describe("the request the form sends", () => {
  it("trims, and leaves out what was never filled in", () => {
    expect(
      toCreateRequest({ ...FILLED, name: "  Sloppy Research ", description: "  ", payoutWallet: " " }),
    ).toEqual({
      name: "Sloppy Research",
      type: "research",
      endpoint: "http://host.docker.internal:4103",
      price: "0.03",
      stake: "0.3",
    })
  })

  it("sends a description and a payout wallet when they are filled in", () => {
    expect(
      toCreateRequest({ ...FILLED, description: " Fast and wrong ", payoutWallet: " 0xABC " }),
    ).toMatchObject({ description: "Fast and wrong", payout_wallet: "0xABC" })
  })

  it("applies the route's own rules before making the request", () => {
    expect(formErrors(FILLED)).toEqual({})
    expect(formErrors({ ...FILLED, endpoint: "http://agents.example" }).endpoint).toContain(
      "http:// is accepted only for",
    )
  })
})

describe("fix and resubmit (FR-12)", () => {
  const failed = {
    id: "lst_01JZZZ",
    name: "Sloppy Research",
    description: null,
    type: "research",
    endpoint: "http://host.docker.internal:4103",
    status: "failed",
    last_error: "402 amount 0.05 tUSD differs from declared 0.03 tUSD",
    // AD-2: a Listing that never reached the chain has no chain-owned price.
    price: "0",
    stake: "0",
    declared_price: "30000",
    declared_stake: "300000",
    payout_wallet: "0xf6e3a69beb0f05ced82c99c4dc4989bef8fa82c4",
  } as unknown as ListingDetailResponse

  it("opens the form on the failed Listing", () => {
    expect(resubmitHref("lst_01JZZZ")).toBe("/listings/new?from=lst_01JZZZ")
  })

  it("pre-fills from what the Creator declared, not from the empty chain cache", () => {
    expect(prefillFrom(failed)).toEqual({
      name: "Sloppy Research",
      type: "research",
      endpoint: "http://host.docker.internal:4103",
      price: "0.03",
      stake: "0.3",
      description: "",
      payoutWallet: "0xf6e3a69beb0f05ced82c99c4dc4989bef8fa82c4",
    })
  })
})

describe("the progress poll (AD-12)", () => {
  const listing = (status: string) => ({ status }) as ListingDetailResponse

  it("asks again every two seconds while the Listing is verifying", () => {
    expect(LISTING_POLL_MS).toBe(2_000)
    expect(listingRefetchInterval(undefined)).toBe(2_000)
    expect(listingRefetchInterval(listing("verifying"))).toBe(2_000)
  })

  it("stops the moment the pipeline cannot move it again", () => {
    expect(listingRefetchInterval(listing("active"))).toBe(false)
    expect(listingRefetchInterval(listing("failed"))).toBe(false)
    expect(listingRefetchInterval(listing("paused"))).toBe(false)
  })

  it("keeps trying after a blip, and gives up on a Listing that is not ours", () => {
    const options = listingQueryOptions("lst_01JZZZ")

    const blip = { state: { data: listing("verifying"), error: new ApiError("network_error", "x", 0) } }
    expect(options.refetchInterval(blip as never)).toBe(2_000)

    const gone = { state: { data: undefined, error: new ApiError("not_found", "x", 404) } }
    expect(options.refetchInterval(gone as never)).toBe(false)
    expect(options.retry(1, new ApiError("not_found", "x", 404))).toBe(false)
  })
})
