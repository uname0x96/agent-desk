import { describe, expect, it } from "vitest"
import { intentKeys } from "@agent-desk/schemas"
import type { ChainTxView, ListingDetailResponse } from "./listing-progress.ts"
import {
  canManage,
  describeChange,
  hasPendingIntent,
  manageHistory,
} from "./manage-history.ts"
import {
  decidePause,
  decidePrice,
  decideTopUp,
  isPaused,
  requiredStake,
  type ListingTerms,
} from "./manage-rules.ts"

/**
 * FR-7, FR-8, FR-9: the rules behind the Creator's three buttons (Story 3.6).
 *
 * These are the sentences a Creator reads, so the assertions are about the
 * words as much as the booleans — a refused price has to name the shortfall, and
 * a Resume the Registry would ignore has to say what would actually clear it.
 * The manage page and the three routes both apply these functions, so anything
 * proven here is proven on both sides of the request.
 */

const LISTING_ID = "lst_01M1V3XSV6XQ2BDQAZJXW6Q9FJ"

/** 0.03 tUSD per call, with the 0.3 tUSD of Stake the Registry demands for it. */
const LIVE: ListingTerms = {
  price: 30_000n,
  stake: 300_000n,
  pausedByCreator: false,
  pausedByStake: false,
}

describe("the ten-times minimum", () => {
  it("is what the Registry itself enforces", () => {
    expect(requiredStake(30_000n)).toBe(300_000n)
    expect(requiredStake(0n)).toBe(0n)
  })

  it("accepts a price the Stake already covers", () => {
    expect(decidePrice("0.02", LIVE)).toEqual({ ok: true, value: 20_000n })
    expect(decidePrice("0.03", LIVE)).toEqual({ ok: true, value: 30_000n })
  })

  it("refuses a price above the Stake and names the top-up that would allow it", () => {
    const decision = decidePrice("0.05", LIVE)

    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.refusal.code).toBe("refused_stake")
    expect(decision.refusal.message).toContain("0.5 tUSD of Stake")
    expect(decision.refusal.message).toContain("Top up 0.2 tUSD")
    expect(decision.refusal.details).toMatchObject({
      price: "50000",
      stake: "300000",
      required: "500000",
      shortfall: "200000",
    })
  })

  it("applies the listing form's own price rule first", () => {
    for (const bad of ["", "0", "-0.01", "1.5", "0.0000001", "abc"]) {
      const decision = decidePrice(bad, LIVE)
      expect(decision.ok).toBe(false)
      if (decision.ok) return
      expect(decision.refusal.code).toBe("validation_failed")
      expect(decision.refusal.details).toMatchObject({ field: "price" })
    }
  })
})

describe("a top-up", () => {
  it("is any amount above nothing; Stake only ever protects a Builder", () => {
    expect(decideTopUp("0.1")).toEqual({ ok: true, value: 100_000n })
    expect(decideTopUp("50")).toEqual({ ok: true, value: 50_000_000n })
    expect(decideTopUp(" 0.000001 ")).toEqual({ ok: true, value: 1n })
  })

  it("refuses nothing, a negative, and anything that is not an amount", () => {
    for (const bad of ["0", "-1", "", "0.0000001", "1e6"]) {
      const decision = decideTopUp(bad)
      expect(decision.ok).toBe(false)
      if (decision.ok) return
      expect(decision.refusal.details).toMatchObject({ field: "amount" })
    }
  })
})

describe("the pause switch", () => {
  it("is the Creator's flag and only theirs", () => {
    expect(decidePause(true, LIVE)).toEqual({ ok: true, value: true })
    expect(decidePause(false, { ...LIVE, pausedByCreator: true })).toEqual({ ok: true, value: false })
  })

  it("refuses a transaction that would change nothing", () => {
    const decision = decidePause(false, LIVE)
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.refusal.message).toBe("this Listing is not paused by you")
  })

  it("tells a Creator that a Stake pause is cleared by a top-up, not by Resume", () => {
    const decision = decidePause(false, { ...LIVE, pausedByStake: true })
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.refusal.message).toContain("a top-up is what resumes it")
  })

  it("reads paused as either flag, which is what a Builder sees", () => {
    expect(isPaused(LIVE)).toBe(false)
    expect(isPaused({ ...LIVE, pausedByCreator: true })).toBe(true)
    expect(isPaused({ ...LIVE, pausedByStake: true })).toBe(true)
  })
})

// ----------------------------------------------------------------- history

function tx(intentKey: string, payload: unknown, overrides: Partial<ChainTxView> = {}): ChainTxView {
  return {
    intent_key: intentKey,
    status: "confirmed",
    tx_hash: `0x${"ab".repeat(32)}`,
    payload: payload as Record<string, unknown>,
    created_at: "2026-09-06T09:00:00.000Z",
    confirmed_at: "2026-09-06T09:00:04.000Z",
    ...overrides,
  }
}

const listed = tx(`list:${LISTING_ID}`, {
  listing_id: LISTING_ID,
  after: { price: "30000", stake: "300000" },
})
const priced = tx(intentKeys.price(LISTING_ID, 1_757_000_000_000), {
  listing_id: LISTING_ID,
  before: { price: "30000", stake: "300000", paused: false },
  after: { price: "50000" },
})

describe("the change history AD-2 says is the chain_tx rows", () => {
  it("puts the newest change first, because that is the one just made", () => {
    const rows = manageHistory([listed, priced])
    expect(rows.map((row) => row.intent)).toEqual(["price", "list"])
  })

  it("states a price change in tUSD, from and to", () => {
    expect(describeChange(priced)).toBe("price 0.03 → 0.05 tUSD")
  })

  it("states a top-up as the new total and the amount that was added", () => {
    const row = tx(intentKeys.stake(LISTING_ID, 2), {
      before: { price: "30000", stake: "300000", paused: false },
      after: { stake: "500000" },
    })
    expect(describeChange(row)).toBe("Stake 0.3 → 0.5 tUSD (+0.2)")
  })

  it("states a pause and a resume in the Creator's own terms", () => {
    const paused = tx(intentKeys.pause(LISTING_ID, 3), { after: { paused: true } })
    const resumed = tx(intentKeys.pause(LISTING_ID, 4), { after: { paused: false } })
    expect(describeChange(paused)).toBe("paused by the creator")
    expect(describeChange(resumed)).toBe("resumed by the creator")
  })

  it("reads the listing pipeline's own rows, which are where a price starts", () => {
    expect(describeChange(listed)).toBe("listed at 0.03 tUSD with 0.3 tUSD of Stake")
    expect(describeChange(tx(`identity:${LISTING_ID}`, {}))).toBe("ERC-8004 identity minted")
  })

  it("survives a payload that does not carry before and after", () => {
    expect(describeChange(tx(intentKeys.price(LISTING_ID, 5), { nothing: true }))).toBe("—")
  })

  it("polls while a transaction can still move, and stops when none can", () => {
    expect(hasPendingIntent([listed, priced])).toBe(false)
    expect(hasPendingIntent([listed, tx(intentKeys.price(LISTING_ID, 6), {}, { status: "pending" })])).toBe(true)
    expect(hasPendingIntent([tx(intentKeys.pause(LISTING_ID, 7), {}, { status: "reverted" })])).toBe(false)
  })
})

describe("who may manage a Listing", () => {
  const listing = (overrides: Partial<ListingDetailResponse>) =>
    ({ is_creator: true, status: "active", ...overrides }) as ListingDetailResponse

  it("is the Creator of a Listing that has a Registry entry", () => {
    expect(canManage(listing({}))).toBe(true)
    expect(canManage(listing({ status: "paused" }))).toBe(true)
  })

  it("is nobody else, and nothing that is not on chain yet", () => {
    expect(canManage(listing({ is_creator: false }))).toBe(false)
    expect(canManage(listing({ status: "verifying" }))).toBe(false)
    expect(canManage(listing({ status: "failed" }))).toBe(false)
  })
})
