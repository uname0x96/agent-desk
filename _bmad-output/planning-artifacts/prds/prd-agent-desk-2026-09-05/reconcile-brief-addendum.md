---
title: "Reconciliation: brief addendum vs PRD"
status: draft
created: 2026-09-05
input: _bmad-output/planning-artifacts/briefs/brief-agent-desk-2026-09-05/addendum.md
against:
  - _bmad-output/planning-artifacts/prds/prd-agent-desk-2026-09-05/prd.md
  - _bmad-output/planning-artifacts/prds/prd-agent-desk-2026-09-05/addendum.md
---

# Reconciliation: brief addendum vs PRD

Every rule, number, flow step, demo beat, risk, and open decision in the brief addendum was checked against the PRD and the PRD addendum. Notation: **BA §n** is the brief addendum, **PRD §n / FR-n / UJ-n / SM-n** is the PRD, **PA §n** is the PRD addendum. The PRD does not repeat the demo script or the risk table by design (PRD §0), so those were checked for consistency with the user journeys, success metrics, NFRs, and open questions rather than for verbatim presence.

## Gaps

Items the PRD and its addendum do not capture, or capture only partly. Most important first.

- **G-1. The demo beat "Risk rejects it" has no reproducible mechanism.** BA §9 (2:20) and BA §11 ("What about sloppy agents?") rely on the `risk` node rejecting the sloppy research signal. PA §2 Guardrail Risk decides on `volatility_24h_pct` alone (REDUCE above 3, REJECT above 6) and ignores signal and confidence, so a rejection happens only if BNB's 24h volatility is above 6 percent at demo time. PRD UJ-4 drops the rejection beat without saying so and goes straight to Settlement. Either the script drops "Risk rejects it", or FR-44 / PA §2 gives Guardrail Risk a rule (or a demo-mode flag) that rejects a high-confidence signal that contradicts the 24h direction.
- **G-2. The mocked price feed fallback is not carried.** BA §10 row 4 offers two fallbacks for the settlement-window problem: a short-window ticker, or a mocked feed behind a demo-mode flag on the settlement job. PA §6 carries only the short window (60 s, 1-second klines). FR-44 says `research-sloppy` "fails Settlement more often than it passes in demo mode", but over a real 60-second window the price direction is close to a coin flip, so the refund beat (BA §9 2:20, PRD UJ-4, SM-1) is not reproducible without the mocked feed. Add the demo-mode price source to PA §6 and to FR-33's consequences.
- **G-3. Skip semantics for HOLD and REJECT live only in the addendum.** BA §9 2:20 needs the run to continue past a REJECT so Settlement and `notify` still happen. PA §1 says "A HOLD signal or a REJECT decision means the execution Node is skipped as 'not needed', not failed", but no FR says so. FR-24 ("A Node starts only after the previous Node's Call succeeded") and FR-29 (stop on failure) are the only rules in the PRD body. Promote the skip rule to a consequence of FR-24 or FR-29.
- **G-4. Emergency Stop has no operator FR.** BA §1 lists Emergency Stop in the stack. PRD Glossary, FR-31, and §8 define its effect. PA §6 says "toggle visible" in demo mode. No FR states who can toggle it or where. Minor.
- **G-5. The UI stack decision is not handed to architecture.** BA §1 proposes React + react-flow, or a JSON editor with graph preview. PRD §4.5 and SM-C2 set the bar (readable graph, no drag-and-drop polish), but PA §7 does not list the choice among the decisions for architecture. Minor.
- **G-6. The key hygiene rule is not written down.** BA §8 says to generate a fresh hot-wallet key for development and demo, fund it from the faucet, and never reuse a personal key. PRD FR-2, §7 Security, and PA §5 cover encryption and custody, and wallet generation at sign-up makes fresh keys the default for Accounts. The rule for the platform verification wallet and the Sub-account credentials is not stated anywhere. Minor; one line in PA §5.
- **G-7. Team assignments.** BA §8 asks who builds the contract, the engine and sample agents, and the UI and demo. Not in PRD §10 or PA §7. Arguably outside a PRD; record it in sprint planning.
- **G-8. Build order pulls account-scoped FRs ahead of Accounts.** BA §7 stage 2 is "all 5 nodes and the order lands". PRD §6.3 stage 2 adds FR-3 (per-Account Daily Fee Budget) and FR-32 (Telegram chat id in account settings) while FR-1 and FR-2 (Accounts) arrive in stage 3. The note "Stage 1 may run with a single hard-coded Builder wallet" should extend to stage 2, or FR-3 and the chat-id part of FR-32 should move to stage 3. Minor.
- **G-9. New external dependencies are missing from the risk table (reverse gap).** The PRD adds Telegram (FR-32) and an LLM API (PA §2 Alpha Research) to the demo path. BA §10 has no row for either. PA §2 gives Alpha Research a HOLD fallback; nothing covers a Telegram outage or a missing chat id during the demo. Worth a row in the brief's risk table or a line in PRD §7 Demo reliability.
- **G-10. "Keep MCP for market data" was dropped.** BA §1 and BA §10 row 2 keep Binance MCP for market data even when execution falls back to REST. PA §2 has the `data` Seed Agent use Binance public REST, PA §4 has Settlement use the public ticker, and MCP appears only in FR-31 for execution. Not harmful, but record it in PA §7 so the pitch does not over-claim Agent OS usage.

## Contradictions

- **C-1. Max cost per run: 0.07 vs 0.095 USDT.** BA §4 step 1 and BA §9 0:00 price the run as Research 0.05 + Risk 0.02 = 0.07, with data, execution, and notify implicitly free. PRD UJ-1 and UJ-3 copy that: "max 0.07 USDT per run", the money pane shows 0.05 and 0.02, and the swap drops the preview to 0.05. But FR-20 defines max cost as the sum of every Node's price, FR-14 and FR-29 make `execution` and `notify` paid Calls, and PA §2 prices `data` 0.01, `execution` 0.01, `notify` 0.005. Under the PRD's own rules the five-node run costs 0.095 and the swap gives 0.075. Fix one side: either price data, execution, and notify at zero in PA §2, or update the numbers in UJ-1, UJ-3, and the demo script.
- **C-2. Demo timing vs the demo-mode Settlement Window.** BA §9 starts run 2 at 1:50 and shows Settlement (slash, refund, reputation drop) at 2:20, thirty seconds later. PRD Glossary, FR-33, and PA §6 set the demo-mode window at 60 seconds, and PRD §7 budgets 50 seconds per Run. Even measured from the research Call rather than the end of the run, Settlement plus two on-chain transactions lands near 3:00, after the 2:50 close. Options: a 10 to 15 second window in demo mode, or restructure the script (start run 2 before the listing beat, or cut run 2 to research and risk only).
- **C-3. Run duration: 50 vs 60 seconds.** BA §9 leaves 50 seconds between 0:30 and 1:20. PRD §7 restates "The demo has 50 seconds per Run", but SM-3 passes a Run at 60 seconds. A Run that meets SM-3 can still overrun the script. Align SM-3 to 50 seconds or reshape the script.
- **C-4. Workflow shape `data -> research -> execution` is rejected.** BA §6 lists it under "shapes the engine must accept". FR-17 requires a `risk` Node before `execution`, so the PRD rejects it, and nothing in the PRD records this as deliberate. It looks intentional (the Order Cap flows through `risk`, FR-4 and FR-24). Add it to PRD §5 Non-Goals or to FR-17's notes so the brief and PRD agree.
- **C-5. "Who holds the money? Nobody."** BA §11 answers that money moves wallet to wallet and the platform only takes a fee. PRD Glossary System Wallet and FR-2 make the platform the custodian of every user's key (the engine signs), and PRD §5 says the MVP collects no fee. The payment path is wallet to wallet with no escrow (FR-25), but the custody claim as phrased is false for the MVP, and BA §8 itself acknowledges the hot wallet. Reword the judge answer: no escrow, direct wallet-to-wallet payment; the MVP custodies keys for unattended signing; external wallets and session keys are roadmap.

## Superseded on purpose

- **S-1. Fan-in shapes and "sequential DAG".** BA §6 items 3 and 4 (two `data` nodes; two `research` nodes) and BA §1 "sequential DAG execution" are replaced by PRD Glossary Workflow as a linear chain, FR-17 "at most one Node per Type", and PRD §5 non-goals for branching, fan-in, and parallel Nodes. Explicit.
- **S-2. Continuous "Watch BNB/USDT" intent.** BA §4 reads like monitoring. FR-22 makes Runs manual only; scheduling is a non-goal (PRD §5) and roadmap (BA §13). Explicit.
- **S-3. Per-agent input and output schemas.** BA §2 puts `input_schema` and `output_schema` on the agent record. FR-15 and PA §1 make schemas per Type; custom Types are deferred (PRD §5, BA §13). Explicit.
- **S-4. Unpaid listing check.** BA §5 calls the endpoint once with a sample payload. FR-11 and PA §3 make it a paid x402 Call from a platform wallet so the Creator sees the first payment at listing time. Explicit with rationale.
- **S-5. Running per-node budget total.** BA §3 step 1 adds each price to a running total and stops before the call that breaks the ceiling. FR-23 and FR-3 lock and check the whole run before any Call, which matches BA §4 step 1. Stricter and consistent.
- **S-6. "Partially refund the user's fee".** BA §4 step 6 and BA §5 say partial. FR-35 and PA §4 slash and refund exactly the scored Call's locked price. That is a full refund of that Call and a partial refund of the run's total. Precise and compatible; the pitch should use the PRD wording.
- **S-7. "BSC testnet or opBNB".** BA §1 leaves the chain open. PRD §7 and PA §3 fix BSC testnet, chain id 97. Decided, but not recorded as a decision; one line in PA §7 would close it.
- **S-8. Any owner can list any Type.** BA §2's type enum implies any Creator can list `execution`. FR-14 and PRD §5 restrict `execution` to the platform, with rationale in the FR-14 note.
- **S-9. Risk rule threshold.** BA §5 says "drawdown beyond the threshold" without a number. FR-34 fixes 2 percent, scores APPROVE and REDUCE, leaves REJECT unscored, and PA §4 gives the computation. Threshold added.
- **S-10. permit2-exact and permit2-upto.** BA §12 names both. PA §3 picks permit2-exact for the B402 and self-hosted facilitators. Fine, since prices are exact.

## Confirmed coverage (short)

- **BA §1 stack.** x402 in USDT with B402 and a self-hosted fallback (PRD §7, PA §3, PA §7); ERC-8004 (FR-5); registry contract with price, stake, reputation (FR-6); Sub-account with limit and Emergency Stop (Glossary, FR-31, §8); HTTP agents with an LLM (FR-16, PA §2); Node or Python left open (PA §7).
- **BA §2 record.** `agent_id` (FR-5); owner and payout wallet (Glossary, FR-10); endpoint, type, price, stake, reputation (FR-6, FR-13).
- **BA §3 per-call flow.** 402 with amount, wallet, chain (FR-16); compare with the lock (FR-26); sign, retry, result (FR-25, PA §3); log node, amount, tx hash, result (FR-28).
- **BA §4 numbers.** Research 0.05, Risk 0.02, new agent 0.03 (PA §2); LONG at 0.72 (PA §1); REDUCE 100 to 60 (PA §1, PA §2 Guardrail Risk at 60 percent); order through the Sub-account (FR-31); notify with cost table and hashes (FR-32); settlement after one hour (FR-33, PA §6); slash, refund, reputation (FR-35, FR-36). Only the 0.07 total is off (C-1).
- **BA §5 rules.** One price per agent (Glossary, §5); price change with run-start lock and 402 rejection (FR-9, FR-23, FR-26, SM-5); reputation over the last 30 scored Calls (Glossary, FR-36); research and risk rules (FR-33, FR-34); pause at zero Stake (FR-8, FR-37); listing schema check (FR-11).
- **BA §6 shapes.** The full five-node chain and `data -> research -> notify` (FR-17).
- **BA §7 build order.** Five stages map one to one onto PRD §6.3; all 44 FRs are placed; cut from the bottom (§6.3, §8 Time).
- **BA §8 decisions.** Event, deadline, team (frontmatter); Build the Era (§10 Q5); hot-wallet custody (Glossary, FR-2, PA §5); stack and toolchain (PA §7); SDK versus custom contract (§10 Q3, PA §7); B402 onboarding and the daily cap (§10 Q1); MCP on Spot Testnet (§10 Q2, FR-31).
- **BA §9 beats.** Split screen (FR-43); compose with max-cost preview (FR-18, FR-20, UJ-1); run with per-node payments and an order (FR-25, FR-28, FR-31, UJ-1); 30-second stranger listing (FR-10 to FR-12, UJ-2, SM-2); swap and pay the stranger (FR-21, UJ-3); slash, refund, reputation drop (FR-35, FR-36, UJ-4, SM-1); no approvals (SM-4).
- **BA §10 risks.** B402 fallback (§7 Compatibility, §10 Q1); MCP fallback (FR-31); faucet and RPC (§7 Demo reliability: three retries, spare wallet sets, recorded backup; PA §5); configurable window (Glossary, FR-33, PA §6); scope creep (§6.3).
- **BA §11 answers.** Price lock (SM-5); stake, reputation, settlement (FR-33 to FR-37); simple rule admitted and judge agent deferred (§6.2); workflow layer (§1).
- **BA §12 facts used.** Chain id 97 and testnet USDT (§7); permit2 because BSC USDT lacks EIP-3009 (PA §3); Build the Era dates (§10 Q5); stake and slashing as AgentDesk's own layer above ERC-8004 and ERC-8183 (PA §7).
- **BA §13 roadmap.** Judge agent (§6.2); outcome and resource pricing, custom Types, branching, scheduling, versioning (§5). Subscription pricing and listing on BNB Agent Studio are not named in the PRD; roadmap only, no action.
