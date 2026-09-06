import { MODE_CONSTANTS } from "@agent-desk/core/mode"
import { RISK_RULE_LABEL } from "@agent-desk/core/settlement"
import { PRICE_SOURCE, type SettlementRow, type SettlementsPage } from "@agent-desk/schemas"

/**
 * A page of `GET /api/settlements` as the route returns it. Test-only: nothing
 * in `app/` imports this.
 *
 * Every label and reason here is imported rather than typed out, so the fixture
 * cannot drift from what `packages/core/settlement` and the worker actually
 * write. That is the whole point of the file: a test that asserts the page
 * prints "demo settlement rule: 24h trend" is only worth something if the
 * fixture got that string from the same constant the worker did.
 */

const BUILDER_WALLET = "0xa71c3d90e5b28f4607c93d1a2b85e04f7d16c982"
const SLASH_TX = `0x${"5c".repeat(32)}`
const REPUTATION_TX = `0x${"7e".repeat(32)}`
const REPUTATION_TX_PASSED = `0x${"3a".repeat(32)}`
const RUN_ID = "run_01K4RWZ8QY7M3B0P5X2A9TGCVD"

const BLANK = {
  run_id: RUN_ID,
  price_source: PRICE_SOURCE,
  start_price: null,
  end_price: null,
  change_24h_pct: null,
  p_fill: null,
  window_min: null,
  window_max: null,
  not_scored_reason: null,
  slash_amount: null,
  slash_tx_hash: null,
  refund_to: null,
  reputation_tx_hash: null,
} as const

/** Demo mode, LONG, the 24 h ticker rose: the rule passed and no Stake moved. */
export const passedDemoResearch: SettlementRow = {
  ...BLANK,
  id: "stl_01K4RX40000000000000000009",
  call_id: "call_01K4RWZC4T8N1D5F9J3M7QBXV2",
  listing_id: "lst_01K4RWY4T1B6N9C3F8H2J5MDRX",
  node_type: "research",
  provider: "Claude Analyst",
  result: "passed",
  mode: "demo",
  rule_label: MODE_CONSTANTS.demo.researchRuleLabel,
  start_price: "612.40",
  change_24h_pct: 1.732,
  scored_at: "2026-09-05T02:00:41Z",
  reputation_tx_hash: REPUTATION_TX_PASSED,
}

/** The row a judge is here for: the Agent was wrong, the Slash landed, the Refund is on chain. */
export const failedResearchSlashed: SettlementRow = {
  ...BLANK,
  id: "stl_01K4RX40000000000000000008",
  call_id: "call_01K4RWZC4T8N1D5F9J3M7QBXV3",
  listing_id: "lst_01K4RWY9X2C5F8K1N4Q7T0WBZE",
  node_type: "research",
  provider: "Sloppy Research",
  result: "failed",
  mode: "demo",
  rule_label: MODE_CONSTANTS.demo.researchRuleLabel,
  start_price: "612.40",
  change_24h_pct: -0.884,
  scored_at: "2026-09-05T02:00:42Z",
  slash_amount: "25000",
  slash_tx_hash: SLASH_TX,
  refund_to: BUILDER_WALLET,
  reputation_tx_hash: REPUTATION_TX,
}

/** The same failure one tick earlier: scored, slash sent, receipt not in yet. */
export const failedRiskSlashPending: SettlementRow = {
  ...BLANK,
  id: "stl_01K4RX40000000000000000007",
  call_id: "call_01K4RWZC4T8N1D5F9J3M7QBXV4",
  listing_id: "lst_01K4RWY7V4E9Q2Z5B8D1G3KFNS",
  node_type: "risk",
  provider: "Volatility Guard",
  result: "failed",
  mode: "production",
  rule_label: RISK_RULE_LABEL,
  p_fill: "612.55",
  window_min: "598.10",
  scored_at: "2026-09-05T03:00:44Z",
}

/** FR-24: a REJECT skips the execution Node, so there is no fill to measure against. */
export const notScoredReject: SettlementRow = {
  ...BLANK,
  id: "stl_01K4RX40000000000000000006",
  call_id: "call_01K4RWZC4T8N1D5F9J3M7QBXV5",
  listing_id: "lst_01K4RWY7V4E9Q2Z5B8D1G3KFNS",
  node_type: "risk",
  provider: "Volatility Guard",
  result: "not_scored",
  not_scored_reason: "reject_decision",
  mode: "production",
  rule_label: RISK_RULE_LABEL,
  scored_at: "2026-09-05T03:00:45Z",
}

/** An APPROVE whose Run ended without a `FILLED` execution Call. */
export const notScoredNoFill: SettlementRow = {
  ...BLANK,
  id: "stl_01K4RX40000000000000000005",
  call_id: "call_01K4RWZC4T8N1D5F9J3M7QBXV6",
  listing_id: "lst_01K4RWY7V4E9Q2Z5B8D1G3KFNS",
  node_type: "risk",
  provider: "Volatility Guard",
  result: "not_scored",
  not_scored_reason: "no_fill",
  mode: "production",
  rule_label: RISK_RULE_LABEL,
  scored_at: "2026-09-05T03:00:46Z",
}

/** AD-3: a failed reference read leaves `reference_price` null, so there is no start price. */
export const notScoredNoReferencePrice: SettlementRow = {
  ...BLANK,
  id: "stl_01K4RX40000000000000000004",
  call_id: "call_01K4RWZC4T8N1D5F9J3M7QBXV7",
  listing_id: "lst_01K4RWY4T1B6N9C3F8H2J5MDRX",
  node_type: "research",
  provider: "Claude Analyst",
  result: "not_scored",
  not_scored_reason: "no_reference_price",
  mode: "production",
  rule_label: MODE_CONSTANTS.production.researchRuleLabel,
  scored_at: "2026-09-05T03:00:47Z",
}

/** Newest first, as the route orders them. */
export const settlementsFixture: SettlementsPage = {
  items: [
    passedDemoResearch,
    failedResearchSlashed,
    failedRiskSlashPending,
    notScoredReject,
    notScoredNoFill,
    notScoredNoReferencePrice,
  ],
  next: null,
}

/** The same page once the pending Slash has landed: nothing left to wait for. */
export const settledFixture: SettlementsPage = {
  items: settlementsFixture.items.map((row) =>
    row.id === failedRiskSlashPending.id
      ? {
          ...row,
          slash_amount: "10000",
          slash_tx_hash: `0x${"9d".repeat(32)}`,
          refund_to: BUILDER_WALLET,
          reputation_tx_hash: `0x${"4b".repeat(32)}`,
        }
      : row,
  ),
  next: null,
}

export { BUILDER_WALLET, REPUTATION_TX, RUN_ID, SLASH_TX }
