import type { ListingResponse } from "@agent-desk/schemas"

/**
 * Marketplace rows as `GET /api/listings` returns them. Test-only: nothing
 * under `app/` imports this.
 *
 * The set is chosen to exercise every branch of the Story 3.5 ordering at
 * once — a scored pair that ties on percentage and separates on scored-Call
 * count, an unscored pair that separates on price, and three Types that are
 * not scored in the MVP, two of them paused for the two different reasons.
 * The ids sort alphabetically A..H, so the final newest-first tie-break is
 * readable in the expectations.
 */

const OWNER_A = "0x7609275f0f166d078f59d69d69511d0612e756cb"
const OWNER_B = "0x8b21c6d4e70f9a3b52c1d8e46f70a9b3c25d18e4"
const OWNER_C = "0x3f70b9c2d81e46a05b7c93d2e18f4a60c5b72d93"

function listing(overrides: Partial<ListingResponse> & Pick<ListingResponse, "id" | "name" | "type">): ListingResponse {
  return {
    description: null,
    endpoint: "http://localhost:4100",
    status: "active",
    last_error: null,
    price: "10000",
    stake: "100000",
    reputation_bps: null,
    scored_call_count: 0,
    paused_by_creator: false,
    paused_by_stake: false,
    payout_wallet: OWNER_A,
    owner_address: OWNER_A,
    creator_account_id: "acc_01M1V0V1493YH1F8AZMMQ42JZ7",
    agent_id: "1",
    registry_listing_id: "1",
    created_at: "2026-09-05T09:00:00Z",
    ...overrides,
  }
}

/** research, 100 % over 3 scored Calls. */
export const alphaResearch = listing({
  id: "lst_00000000000000000000MKTA01",
  name: "Alpha Research",
  type: "research",
  description: "Trend and volatility read over the market snapshot, with a confidence and a rationale.",
  price: "30000",
  stake: "300000",
  reputation_bps: 10000,
  scored_call_count: 3,
  agent_id: "11",
  registry_listing_id: "10",
})

/** research, 67 % over 12 scored Calls — ties with `guardrailRisk` on bps. */
export const sloppyResearch = listing({
  id: "lst_00000000000000000000MKTB01",
  name: "Sloppy Research",
  type: "research",
  description: "The same signal, produced without reading the market snapshot first.",
  price: "30000",
  stake: "300000",
  reputation_bps: 6667,
  scored_call_count: 12,
  owner_address: OWNER_B,
  payout_wallet: OWNER_B,
  agent_id: "12",
  registry_listing_id: "11",
})

/** risk, 67 % over 4 scored Calls. */
export const guardrailRisk = listing({
  id: "lst_00000000000000000000MKTC01",
  name: "Guardrail Risk",
  type: "risk",
  description: "Sizes or rejects a signal against the balance, the Order Cap and the volatility.",
  price: "20000",
  stake: "200000",
  reputation_bps: 6667,
  scored_call_count: 4,
  owner_address: OWNER_B,
  payout_wallet: OWNER_B,
  agent_id: "13",
  registry_listing_id: "12",
})

/** research with nothing settled: "no score yet", not a zero. */
export const freshResearch = listing({
  id: "lst_00000000000000000000MKTD01",
  name: "Newcomer Research",
  type: "research",
  price: "50000",
  stake: "500000",
  reputation_bps: null,
  scored_call_count: 0,
  owner_address: OWNER_C,
  payout_wallet: OWNER_C,
  agent_id: "14",
  registry_listing_id: "13",
})

/** risk whose `reputation_bps` is 0 but which has no scored Call yet. */
export const freshRisk = listing({
  id: "lst_00000000000000000000MKTE01",
  name: "Newcomer Risk",
  type: "risk",
  price: "20000",
  stake: "200000",
  reputation_bps: 0,
  scored_call_count: 0,
  owner_address: OWNER_C,
  payout_wallet: OWNER_C,
  agent_id: "15",
  registry_listing_id: "14",
})

/** data — never scored in the MVP. Matches the seeded Listing. */
export const binanceTicker = listing({
  id: "lst_00000000000000000000MKTF01",
  name: "Binance Ticker",
  type: "data",
  description: "BNBUSDT last price, 24 hour change and 24 hour volatility from Binance public market data.",
  price: "10000",
  stake: "100000",
  reputation_bps: 0,
  agent_id: "28",
  registry_listing_id: "27",
})

/** notify, paused by its creator. */
export const pausedNotifier = listing({
  id: "lst_00000000000000000000MKTG01",
  name: "Telegram Notifier",
  type: "notify",
  status: "paused",
  paused_by_creator: true,
  price: "10000",
  stake: "100000",
  agent_id: "16",
  registry_listing_id: "15",
})

/** execution, paused because its Stake fell below ten times its price. */
export const pausedExecutor = listing({
  id: "lst_00000000000000000000MKTH01",
  name: "Spot Executor",
  type: "execution",
  status: "paused",
  paused_by_stake: true,
  price: "50000",
  stake: "120000",
  agent_id: "17",
  registry_listing_id: "16",
})

/** In the order `GET /api/listings` returns them today: newest id first. */
export const marketplaceFixture: readonly ListingResponse[] = [
  pausedExecutor,
  pausedNotifier,
  binanceTicker,
  freshRisk,
  freshResearch,
  guardrailRisk,
  sloppyResearch,
  alphaResearch,
]
