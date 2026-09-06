import type { AgentHistoryResponse, ListingResponse } from "@agent-desk/schemas"

/**
 * An Agent's record as `GET /api/listings/<id>` and
 * `GET /api/listings/<id>/history` return it. Test-only: nothing under `app/`
 * imports this.
 *
 * The research Agent carries one of every intent AD-8 can write for a Listing,
 * so a single render exercises the price table, the Reputation line, both kinds
 * of Stake row and the verification Call at once. The execution Agent is the
 * FR-11 case: listed by the platform, with no Call to show.
 */

export const RESEARCH_LISTING_ID = "lst_00000000000000000000AGENT1"
export const EXECUTION_LISTING_ID = "lst_00000000000000000000AGENT2"

export const OWNER_ADDRESS = "0x7609275f0f166d078f59d69d69511d0612e756cb"
export const PAYOUT_ADDRESS = "0x8b21c6d4e70f9a3b52c1d8e46f70a9b3c25d18e4"

/** The addresses `deployments/97.json` holds, which the page links its two ids to. */
export const REGISTRY_ADDRESS = "0xfc1e9c98d8245550455487227a3810f340142c6d"
export const IDENTITY_REGISTRY_ADDRESS = "0x8004a818bfb912233c491871b3d84c89a494bd9e"

const CALL_ID = "call_0000000000000000000SLASH1"
const VERIFICATION_CALL_ID = "call_0000000000000000000VERIF1"

const hash = (byte: string) => `0x${byte.repeat(64)}`

export const TX_LIST = hash("1")
export const TX_PRICE = hash("2")
export const TX_STAKE = hash("3")
export const TX_SLASH = hash("4")
export const TX_REPUTATION = hash("5")
export const TX_PAUSE = hash("6")
export const TX_VERIFICATION = hash("7")

/** research, 67 % over 3 scored Calls, paused by its creator. */
export const sloppyResearch: ListingResponse = {
  id: RESEARCH_LISTING_ID,
  name: "Sloppy Research",
  description: "The same signal, produced without reading the market snapshot first.",
  type: "research",
  endpoint: "http://host.docker.internal:4104",
  status: "paused",
  last_error: null,
  price: "50000",
  stake: "370000",
  reputation_bps: 6667,
  scored_call_count: 3,
  paused_by_creator: true,
  paused_by_stake: false,
  payout_wallet: PAYOUT_ADDRESS,
  owner_address: OWNER_ADDRESS,
  creator_account_id: "acc_00000000000000000000OWNER1",
  agent_id: "11",
  registry_listing_id: "10",
  created_at: "2026-09-05T09:00:00.000Z",
}

export const sloppyResearchHistory: AgentHistoryResponse = {
  listing_id: RESEARCH_LISTING_ID,
  type: "research",
  rows: [
    {
      intent_key: `list:${RESEARCH_LISTING_ID}`,
      intent: "list",
      status: "confirmed",
      tx_hash: TX_LIST,
      before: { price: "0", stake: "0", paused: false },
      after: { price: "30000", stake: "300000", paused: false },
      slash: null,
      created_at: "2026-09-05T09:00:00.000Z",
      confirmed_at: "2026-09-05T09:00:04.000Z",
    },
    {
      intent_key: `price:${RESEARCH_LISTING_ID}:1757150000000`,
      intent: "price",
      status: "confirmed",
      tx_hash: TX_PRICE,
      before: { price: "30000", stake: "300000", paused: false },
      after: { price: "50000" },
      slash: null,
      created_at: "2026-09-05T10:00:00.000Z",
      confirmed_at: "2026-09-05T10:00:05.000Z",
    },
    {
      intent_key: `stake:${RESEARCH_LISTING_ID}:1757151000000`,
      intent: "stake",
      status: "confirmed",
      tx_hash: TX_STAKE,
      before: { price: "50000", stake: "300000", paused: false },
      after: { stake: "400000" },
      slash: null,
      created_at: "2026-09-05T10:10:00.000Z",
      confirmed_at: "2026-09-05T10:10:06.000Z",
    },
    {
      intent_key: `slash:${CALL_ID}`,
      intent: "slash",
      status: "confirmed",
      tx_hash: TX_SLASH,
      before: {},
      after: {},
      slash: {
        call_id: CALL_ID,
        settlement_id: "stl_00000000000000000000000001",
        amount: "30000",
        to: OWNER_ADDRESS,
      },
      created_at: "2026-09-05T10:20:00.000Z",
      confirmed_at: "2026-09-05T10:20:03.000Z",
    },
    {
      intent_key: `reputation:${RESEARCH_LISTING_ID}:stl_00000000000000000000000001`,
      intent: "reputation",
      status: "confirmed",
      tx_hash: TX_REPUTATION,
      before: { reputation_bps: 10000 },
      after: { reputation_bps: 6667 },
      slash: null,
      created_at: "2026-09-05T10:20:10.000Z",
      confirmed_at: "2026-09-05T10:20:14.000Z",
    },
    {
      intent_key: `pause:${RESEARCH_LISTING_ID}:1757152000000`,
      intent: "pause",
      status: "confirmed",
      tx_hash: TX_PAUSE,
      before: { price: "50000", stake: "370000", paused: false },
      after: { paused: true },
      slash: null,
      created_at: "2026-09-05T10:30:00.000Z",
      confirmed_at: "2026-09-05T10:30:04.000Z",
    },
  ],
  verification: {
    id: VERIFICATION_CALL_ID,
    status: "succeeded",
    node_type: "research",
    locked_price: "30000",
    locked_pay_to: PAYOUT_ADDRESS,
    attempt: 1,
    failure_reason: null,
    request: { symbol: "BNBUSDT", snapshot: { last_price: "612.40" } },
    response: { signal: "BUY", confidence: 0.62, rationale: "24h trend is up" },
    payment_tx_hash: TX_VERIFICATION,
    started_at: "2026-09-05T08:59:58.000Z",
    ended_at: "2026-09-05T09:00:00.000Z",
  },
}

/** FR-11: only the platform lists an `execution` Agent, and never with a sample Call. */
export const spotExecutor: ListingResponse = {
  id: EXECUTION_LISTING_ID,
  name: "Spot Executor",
  description: "Places the market order on Binance Spot Testnet and reports the fill.",
  type: "execution",
  endpoint: "http://host.docker.internal:4105",
  status: "active",
  last_error: null,
  price: "20000",
  stake: "200000",
  reputation_bps: null,
  scored_call_count: 0,
  paused_by_creator: false,
  paused_by_stake: false,
  payout_wallet: PAYOUT_ADDRESS,
  owner_address: OWNER_ADDRESS,
  creator_account_id: "acc_00000000000000000000PLATF1",
  agent_id: "14",
  registry_listing_id: "13",
  created_at: "2026-09-05T09:05:00.000Z",
}

export const spotExecutorHistory: AgentHistoryResponse = {
  listing_id: EXECUTION_LISTING_ID,
  type: "execution",
  rows: [
    {
      intent_key: `list:${EXECUTION_LISTING_ID}`,
      intent: "list",
      status: "confirmed",
      tx_hash: TX_LIST,
      before: { price: "0", stake: "0", paused: false },
      after: { price: "20000", stake: "200000", paused: false },
      slash: null,
      created_at: "2026-09-05T09:05:00.000Z",
      confirmed_at: "2026-09-05T09:05:04.000Z",
    },
  ],
  verification: null,
}
