---
title: "Consistency and Feasibility Review: AgentDesk PRD"
status: review
created: 2026-09-05
reviewed:
  - prd.md
  - addendum.md
read_for_context:
  - _bmad-output/planning-artifacts/briefs/brief-agent-desk-2026-09-05/brief.md
  - _bmad-output/planning-artifacts/briefs/brief-agent-desk-2026-09-05/addendum.md
---

# Consistency and Feasibility Review: AgentDesk PRD

**Verdict.** The PRD is coherent at the feature level and the build order is sound, but it is not yet a document five people can build the demo from. Two defects break the demo as scripted: the settlement beat cannot land inside three minutes, and the 60-second direction rule does not reliably fail the sloppy agent (and may slash the good one). One protocol-level contradiction between FR-25 and addendum §3 will split the engine team from the agent team on day one. Around those sit a set of money-flow states the PRD never names: skipped Nodes, refused-after-payment execution, notify with no recipient, verification payments before stake, and the Price Lock checking only the number.

**Counts.** critical 2, high 6, medium 8, low 6. Total 22.

Each block: severity, location, quoted phrase, failure scenario, smallest fix.

---

## F-1 [critical] The refund beat cannot land inside the three-minute demo

**Location:** §7 Run latency; FR-33 consequence 3; addendum §6; UJ-4; brief addendum §9 (script).

**Quoted:** "The demo has 50 seconds per Run." / "60 seconds in demo mode" / script: "1:50 ... run again" then "2:20 ... Settlement scores it wrong, slashes stake, and refunds the user."

**Failure scenario:** Run 2 starts at 1:50. The research Call succeeds roughly 10 to 15 seconds in, after the data Call and its payment confirmation. The Settlement Window starts at that Call and ends 60 seconds later, at about 2:45 at best. The settlement job then needs a poll tick, a ticker fetch, and two or three on-chain transactions (slash plus refund, reputation write), each about 3 seconds to confirm on BSC testnet, plus the marketplace refresh. The reputation flip lands at 3:00 or later, after the closing line. UJ-4 and SM-1 promise it live.

**Smallest fix:** Set the demo-mode Settlement Window to 15 to 20 seconds, start it at the research Call's success timestamp, and poll the settlement job every 2 seconds in demo mode. Alternatively move the listing beat earlier so Run 2 starts by 1:20. Update addendum §6 either way.

---

## F-2 [critical] The 60-second direction rule does not make the sloppy agent fail, and may slash the good one

**Location:** FR-33; FR-44 consequence 2; addendum §2 (Sloppy Research); addendum §4; UJ-4; brief addendum §10 row 4.

**Quoted:** FR-44: "research-sloppy fails Settlement more often than it passes in demo mode, so the refund beat in UJ-4 is reproducible." FR-33: "Prices come from a platform-fetched Binance ticker, not from the paid data Agent [ASSUMPTION]."

**Failure scenario:** Sloppy Research picks LONG or SHORT "against the 24h direction." Over a 60-second window the 24-hour direction has no predictive power on BNB/USDT, so its pass rate is about 50 percent, the same as Alpha Research's LLM signal. Half of all rehearsals produce no slash on Minh's agent. Independently, half of them slash Alpha Research 60 seconds after Run 1's research Call, refunding Linh from the "good" agent and muddying the story. UJ-4's "ranks Minh's agent below the original" then fails whenever Alpha sits at 0 of 1 and Sloppy at 0 of 1 or 1 of 1. The brief's risk table carried a fallback ("a mocked feed behind a demo-mode flag on the settlement job"); the FR-33 assumption dropped it.

**Smallest fix:** Reinstate the brief's fallback as a demo-mode setting. Simplest version: in demo mode, score research against the 24-hour direction rather than the 60-second move; Sloppy is built to contradict it and Alpha can be prompted to follow it. Label the screen "demo settlement rule". Keep the live-ticker rule for production mode. Record the rule choice in FR-33 and addendum §4.

---

## F-3 [high] FR-25 and addendum §3 describe two different payment mechanisms

**Location:** FR-25 consequence 2; FR-27; Glossary "Payment Proof"; addendum §3; §7 Openness.

**Quoted:** FR-25: "The payment tx hash is recorded on the Call before the retry is sent." Addendum §3: "the engine signs a transfer authorisation from the Builder's System Wallet ... the permit2-exact scheme is expected with the Binance B402 facilitator."

**Failure scenario:** Under x402 as the addendum specifies it, the engine signs an off-chain authorisation and sends it in the X-PAYMENT header; the Agent (through the facilitator) verifies and settles it, and the tx hash comes back in the X-PAYMENT-RESPONSE header with the 200, after the result. No tx hash exists before the retry. The engine team building to FR-25 will broadcast an on-chain transfer itself and send the hash as proof; the agent-template team building to addendum §3 will expect a permit2 authorisation and call a facilitator. The halves do not interoperate. A third-party Creator working from "the public schema page and the HTTP contract alone" (§7 Openness) has no facilitator URL, scheme, or asset to verify against. FR-27 ("failed after payment") also assumes the engine knows whether settlement happened; under facilitator settlement it does not when the paid retry times out.

**Smallest fix:** Pick one mechanism and write it into FR-25. Recommended for three days: standard x402 with the self-hosted facilitator; the engine records the tx hash from X-PAYMENT-RESPONSE after the 200; a missing hash marks the Call "paid-unknown" and is reconciled by checking the authorisation nonce on-chain; the public schema page publishes facilitator URL, scheme, network, and asset. If the team prefers engine-side settlement (engine broadcasts the transfer and X-PAYMENT carries the tx hash, Agent verifies on-chain), then FR-25 stands and addendum §3 must be rewritten. Do not ship both.

---

## F-4 [high] The self-hosted fallback inherits the hardest scheme and an undefined token

**Location:** addendum §3; §7 Compatibility; §8 Cost; Open Question 1.

**Quoted:** "On BSC USDT lacks EIP-3009, so the permit2-exact scheme is expected with the Binance B402 facilitator; the self-hosted fallback facilitator uses the same scheme." §7: "BSC testnet (chain id 97) with the testnet USDT token".

**Failure scenario:** B402 partner access is unconfirmed (Open Question 1). The fallback then needs: a Permit2 deployment on chain 97 the team trusts, a one-time Permit2 approval transaction from every System Wallet (gas, and a step missing from FR-2 and sign-up), a facilitator that verifies and settles permit2 signatures and relays gas, and a "testnet USDT" contract with a faucet, which BSC testnet does not offer in any canonical form. None of this is in the build order. The team can end day one without a working payment leg.

**Smallest fix:** For the fallback, deploy the team's own mock USDT implementing EIP-3009 (transferWithAuthorization) and run the x402 reference facilitator with the plain `exact` EVM scheme; mint freely into demo wallets. Keep permit2 for the B402 path only if access arrives. Add the token address and facilitator URL to §7 Compatibility and to the public schema page.

---

## F-5 [high] Failure after payment is defined for every Type, but slashing exists for only two

**Location:** FR-27; FR-38; Glossary "Settlement"; FR-4 consequence 3; FR-31 consequences 1 and 2; FR-15 consequence 1; FR-14 consequence 2.

**Quoted:** FR-27: "If an Agent times out or returns an invalid response after being paid, the Call is marked failed after payment and is scored as a failed Settlement." FR-38: "data, execution, and notify Calls are never scored by Settlement."

**Failure scenario:** The execution Agent is paid 0.01 USDT before it acts, because x402 pays first. It then refuses on Order Cap (FR-4), Emergency Stop (FR-31), or a Binance rejection such as minimum notional after a REDUCE to a small size. FR-31 says "the Node fails". Is that a schema-valid 200 with a rejected status (the Call succeeds, notify runs with no order), or a failed Call, in which case FR-27 says slash the platform's execution stake, which FR-38 forbids? The same gap covers a data Agent that times out after payment and a notify Agent with no chat id. The Builder has paid and the PRD names no refund path for unscored Types. Also unstated: whether Platform Agents lock Stake at all (FR-7 applies to every Listing and FR-14 calls execution "a normal paid Listing").

**Smallest fix:** In FR-27 add: "applies to research and risk only; for data, execution, and notify a failure after payment is logged, the Run stops, and no slash or refund occurs in the MVP." Make execution refusals a valid 200 with status REJECTED and a reason (schema change in FR-15 and addendum §1) so the notify message can carry them. State that Platform Agents lock Stake like any Listing. Since the engine already knows the Order Cap and the Emergency Stop flag, check both before paying execution.

---

## F-6 [high] The "skipped" execution Node exists only in the addendum

**Location:** addendum §1 execution note; Glossary "Run"; FR-24 consequence 1; FR-28; FR-29; FR-3 consequence 4; FR-34 consequence 2.

**Quoted:** Addendum: "A HOLD signal or a REJECT decision means the execution Node is skipped as 'not needed', not failed." Glossary: "A Run has ... one Call per Node." FR-24: "A Node starts only after the previous Node's Call succeeded."

**Failure scenario:** On HOLD or REJECT the engine must skip execution, but the PRD has no skipped Call status, no Run status for a Run that finished with a skipped Node, and no budget release for the locked but unpaid execution price (FR-3 releases only "if the Run stops"). FR-24 as written forbids notify from starting, because execution never "succeeded"; FR-29's notify-after-failure contradicts FR-24 the same way. On HOLD the engine still pays the risk Agent 0.02 USDT to size a trade that will never happen, which a judge will ask about.

**Smallest fix:** Add a Call status `skipped` and a Run status `completed, no order`. Reword FR-24: "a Node starts after the previous Node succeeded or was skipped; notify also runs after a failure (FR-29)." In FR-3, release budget for skipped and unpaid Nodes at Run end. Skip both risk and execution on HOLD, with the notify summary saying "HOLD, no order". Move the skip rule from the addendum into FR-24.

---

## F-7 [high] The notify contract has no recipient, so only the platform's notifier can work

**Location:** FR-15 notify schema; addendum §1 notify; FR-32; FR-44 description and consequence 1; §7 Openness; FR-11.

**Quoted:** FR-15: "notify in {run_id, summary, cost_table[], tx_hashes[], order?}". FR-44: "They implement the same contract as any third-party Agent." FR-32: "A missing chat id makes the Node fail with a clear reason." and "contains every tx hash of the Run".

**Failure scenario:** A third-party notify Agent receives a run id and text but no Telegram chat id or any address, so it cannot deliver to anyone. The seeded Telegram Notifier works only by querying the platform database by run id, which breaks "same contract" and the Openness NFR. FR-11 verifies every Listing with the Type's sample input; the sample run id has no chat id, so the seeded notifier fails verification per FR-32, contradicting FR-44 "All six pass FR-11 verification". Separately, the notify Node's own payment hash cannot be inside a message composed before that payment, so "every tx hash of the Run" is short by one.

**Smallest fix:** Add `recipient: {channel: "telegram", address: "<chat id>"}` to the notify input; the engine fills it from account settings and fails the Node before paying if it is missing. Or declare notify platform-only in the MVP, like execution in FR-14. Reword FR-32 to "every tx hash of the preceding Nodes".

---

## F-8 [high] Engine states a developer hits on day one are unspecified

**Location:** FR-23; FR-25; FR-28; FR-30; FR-8; §7 Demo reliability; addendum §5.

**Quoted:** FR-23 checks "the total against the remaining Daily Fee Budget" and nothing else. §7: "The engine retries an RPC or network error up to three times before failing a Call." FR-30: "Two Runs of the same Workflow cannot execute at the same time."

**Failure scenario, five cases:**
1. Budget passes but the System Wallet holds less USDT than the lock, has no BNB for gas, or lacks the token approval. The Run starts, pays data, then dies at research with no defined status or reason.
2. The paid retry times out and the engine retries three times. With a fresh authorisation each time it can pay three times; with the same nonce it gets a replay rejection or another 402. Neither branch is defined.
3. The engine process dies mid-Run. The Run stays "running", FR-30 blocks the Workflow forever, and the budget reservation is never released.
4. Settlement pauses an Agent between Price Lock and its Call. FR-8 says a paused Agent "cannot be chosen" but says nothing about an in-flight Run.
5. Two Workflows of one Builder, or several settlements signed by the platform key, submit transactions concurrently from one wallet and collide on nonces.

**Smallest fix:** In FR-23 add a balance pre-check (USDT at or above the lock total, BNB above a gas floor) with a "refused: insufficient balance" outcome. In FR-28 enumerate Call statuses: pending, price_mismatch, payment_failed, paid_awaiting_result, succeeded, failed_after_payment, skipped. Add a Run timeout (120 seconds) that marks the Run failed and releases budget. State that an in-flight Run proceeds against a paused Agent at its locked price. Require the signing service in addendum §5 to serialise transactions per wallet.

---

## F-9 [medium] The Price Lock compares only the number

**Location:** FR-16 consequences 1 and 2; FR-26; Glossary "Price Lock"; FR-40.

**Quoted:** FR-26: "The engine rejects a 402 whose amount differs from the locked price for that Node." FR-16: "The 402 payment requirements name the amount in USDT, the payout wallet, and the chain (BSC testnet)."

**Failure scenario:** An Agent answers 402 with the locked amount but a different asset, a different network (chain id 56), or a pay-to address that is not the Listing's payout wallet. FR-26 as written signs it. The harm on testnet is nil, but a Payment Workflows judge will ask exactly this, and the payments view (FR-40, "from and to addresses") would then disagree with the Registry's payout wallet.

**Smallest fix:** FR-26: "rejects a 402 whose amount, asset, network, or pay-to address differs from the Price Lock and the Listing." Store all four in the Price Lock.

---

## F-10 [medium] The verification call pays before anything is locked

**Location:** FR-11; FR-12; FR-7; UJ-2; addendum §3 last bullet; addendum §5.

**Quoted:** FR-11: "paying the declared price from a platform wallet ... so the Creator sees the first payment land at listing time." FR-12: "passes FR-5, FR-6, FR-7, and FR-11" with no order given.

**Failure scenario:** A Creator sets price 50 USDT and an external payout wallet, submits, the platform pays 50 USDT for the sample call, and the Stake lock (FR-7) then fails for insufficient balance. The Listing is refused but the platform wallet is 50 USDT lighter, and addendum §5 applies budgets to Builders only, so nothing caps the verification wallet. Repeat until dry. Separately, verifying an execution Listing with the sample input places a real 60 USDT market order on the testnet account at listing time.

**Smallest fix:** Order the steps in FR-12: FR-7 stake lock first, then FR-11 with the payment capped at min(price, 0.10 USDT) or paid only to the Creator's System Wallet, then FR-5 and FR-6. Give the verification wallet its own daily cap. For execution, verify with a size below the minimum notional or behind a dry-run flag.

---

## F-11 [medium] The journey numbers contradict the priced Listings

**Location:** UJ-1; UJ-3; FR-20; FR-14 consequence 2; FR-10 consequence 1; FR-44; addendum §2.

**Quoted:** UJ-1: "max 0.07 USDT per run" and "the money pane shows 0.05 USDT and 0.02 USDT leaving her wallet". UJ-3: "sees the max cost drop to 0.05 USDT". Addendum §2 prices: 0.01, 0.05, 0.03, 0.02, 0.01, 0.005.

**Failure scenario:** FR-20 sums every Node. With the seed prices the full chain costs 0.095 USDT and 0.075 after the swap, and five payments leave the wallet, not two. The 0.07 figure comes from the brief, where data, execution, and notify were unpriced. The PRD made them paid Listings, and FR-10 forbids a price of zero, so they cannot be made free to restore the number. The demo screen, the split-view money pane, and the pitch deck will disagree unless someone notices.

**Smallest fix:** Change UJ-1 and UJ-3 to 0.095 and 0.075 and list five payments, or set data, execution, and notify prices to 0.001 and update addendum §2. Carry the final figure into the brief's demo script.

---

## F-12 [medium] Stake is not reserved against outstanding Calls, and the ten-times invariant dies at the first price change

**Location:** FR-7; FR-8; FR-9; FR-35; Glossary "Stake".

**Quoted:** FR-7: "Listing is refused if the Stake is below ten times the price per call." FR-9: "A Creator can change an Agent's price per call at any time." FR-8: "resumes it when Stake is topped up above the minimum."

**Failure scenario:** (a) An Agent with Stake 0.30 at price 0.03 is called 100 times inside one window; at most ten wrong Calls can be refunded and the other 90 Builders get nothing, so "something to lose" covers 10 percent of exposure and the PRD never says so. (b) After listing, the Creator raises the price to 0.30; the Stake now covers one Call and nothing enforces the minimum. (c) "The minimum" in FR-8 is then undefined: ten times which price?

**Smallest fix:** In FR-9 add: "a price change is refused if Stake is below ten times the new price." In FR-25 add: "the engine refuses to call an Agent whose Stake minus the locked price of its unscored Calls is below the locked price" (a per-Agent reservation counter). Define the FR-8 resume threshold as ten times the current price. State the bounded coverage in the pitch before a judge finds it.

---

## F-13 [medium] The Sub-account and its "second ceiling" may not exist on Spot Testnet

**Location:** Glossary "Sub-account"; §8 Safety; FR-24 consequence 2; FR-31; §4.7 description.

**Quoted:** §8: "Sub-account limit configured on Binance as a second ceiling." Glossary: "The Binance Spot Testnet sub-account, with its own exchange-side limit".

**Failure scenario:** Sub-accounts with permissions and spending limits are an Agent OS and production feature. To the reviewer's knowledge Spot Testnet issues one API-keyed account per login, with no sub-accounts and no spending limit. The only ceiling in the demo is then the Order Cap inside the execution Agent's own code. Also, every Builder's orders go through the same account, so the balance passed to risk (FR-24) is the platform's balance, not Linh's, and two Builders' orders commingle. The PRD never states this.

**Smallest fix:** Verify on day one. If absent, rename to "the platform's Spot Testnet account", drop the "second ceiling" from §8, and add one sentence to §4.7: "All Builders trade through one platform account in the MVP; balance_usdt is that account's balance." Keep the exchange-side limit as a mainnet roadmap line.

---

## F-14 [medium] Settlement mixes prices from two markets

**Location:** FR-33 consequence 2; FR-34 consequence 1; addendum §4; addendum §2 (Binance Ticker).

**Quoted:** FR-34: "Drawdown is computed from the fill price and the lowest (for BUY) or highest (for SELL) price inside the window." Addendum §4: "Window prices sampled from the 1-minute klines (1-second klines in demo mode)."

**Failure scenario:** The fill price comes from the Spot Testnet order; the klines source is unnamed. If klines come from the production API, as the data Seed Agent's ticker does, the testnet fill and the production window prices differ by however far the thin testnet book is off that minute, which can exceed 2 percent by itself and slashes the risk Agent for a phantom drawdown. If klines come from testnet, 1-second klines and liquidity are unverified there.

**Smallest fix:** Name one source in FR-33 and FR-34: production public klines for both the start price and the window; for risk, use the production last price at fill time instead of the testnet fill price. Show the source on the Settlement view (FR-41, "prices used").

---

## F-15 [medium] The custody story in the PRD contradicts the pitch

**Location:** Glossary "System Wallet"; FR-2; FR-25 consequence 1; §5 Non-Goals; brief "What Makes This Different" item 3; brief addendum §11.

**Quoted:** FR-25: "Payment goes directly from the Builder's System Wallet to the Agent's payout wallet; no platform wallet is in the path." Glossary: "The engine holds its key." Brief §11 prepared answer: "Who holds the money? Nobody."

**Failure scenario:** The platform generates and holds every key, custodies funds for both sides, makes withdrawals a non-goal, and lands refunds and payouts in wallets only the platform can spend from. A judge who reads the PRD and hears "nobody holds the money" will call it. FR-25's claim is true only for the on-chain leg.

**Smallest fix:** Replace the prepared answer and add one sentence to §4.1: "MVP wallets are platform-managed hot wallets capped by the Daily Fee Budget; Creators may set an external payout wallet today; external Builder wallets are v2." Reword FR-25 to "the on-chain transfer is wallet to wallet with no platform intermediary".

---

## F-16 [medium] The demo script's "Risk rejects it" cannot happen with the seeded risk Agent

**Location:** UJ-4; §2.3 ("The journeys mirror the three-minute demo script"); FR-44; addendum §2 (Guardrail Risk); brief addendum §9 at 2:20.

**Quoted:** Addendum §2: "REDUCE to 60 percent of proposed size when volatility_24h_pct > 3; REJECT when > 6; APPROVE otherwise." Brief script: "The new agent gives a sloppy signal. Risk rejects it."

**Failure scenario:** Guardrail Risk never reads the signal or its confidence; it rejects only on 24-hour volatility above 6 percent, which BNB/USDT rarely shows. In the demo the sloppy LONG is approved or reduced and a testnet order is placed on it. UJ-4 quietly drops the rejection while §2.3 claims the journeys mirror the script, and the pitch still says it. Either the script is wrong or the risk Agent is silently redesigned.

**Smallest fix:** Decide and align. Either amend brief addendum §9 to "Risk sizes it down, the order fills, settlement scores the signal wrong", or give Guardrail Risk a rule on the signal (REJECT when confidence is above 0.85 and the signal opposes the 24-hour direction) and write it into addendum §2.

---

## F-17 [low] The build-order table splits FRs from the FRs they depend on

**Location:** §6.3; FR-27; FR-8; FR-23; FR-3; §8 Time.

**Quoted:** Stage 2 lists FR-27, whose consequence reads "Settlement slashes ... (FR-35)"; Stage 3 lists FR-8, triggered only by FR-35 and FR-37 in Stage 4; Stage 1 lists FR-23, which checks a budget defined by FR-3 in Stage 2.

**Failure scenario:** A team that cuts at Stage 2 or 3 reports FR-27 and FR-8 as done although their testable consequences cannot be met, and the §8 rule "cut per §6.3, not deferred silently" is defeated by the table itself.

**Smallest fix:** Move FR-27 and FR-8 to Stage 4, leaving only the "Call marked failed after payment" status of FR-27 in Stage 2. Move FR-3 to Stage 1, or make the Stage 1 budget check a constant.

---

## F-18 [low] The listing form has no Stake field

**Location:** FR-10; FR-7; UJ-2.

**Quoted:** FR-10: "name, Type, endpoint URL, price per call in USDT, and optional description and payout wallet." FR-7: "A Creator can lock Stake from their System Wallet when listing".

**Failure scenario:** The Creator cannot choose an amount, so either the form silently locks exactly ten times the price or the UX stage invents a field. UJ-2 says Minh "locks the stake" without a number.

**Smallest fix:** Add "Stake amount, defaulting to ten times the price" to FR-10.

---

## F-19 [low] Two labels for one condition, and no sort rule for either

**Location:** FR-13; FR-36 consequence 1; FR-38 consequence; UJ-4.

**Quoted:** FR-36: "An Agent with no scored Calls shows 'no score yet'." FR-38: "Their Listings show Reputation as 'not scored in MVP' rather than 'no score yet'." FR-13: "sorted by Reputation".

**Failure scenario:** An unscored-Type Agent has no scored Calls, so FR-36 and FR-38 both apply and disagree. Sorting by Reputation across two text states and percentages is undefined, and UJ-4's "ranks Minh's agent below the original" depends on it (see F-2 for Alpha's likely 0 of 1 or 1 of 1 at that moment).

**Smallest fix:** FR-36: "An Agent of a scored Type with no scored Calls shows 'no score yet'." FR-13: "sort is percentage descending, then 'no score yet', then 'not scored in MVP'; ties broken by scored-call count, then price."

---

## F-20 [low] Demo-day rehearsals will exhaust the default budget

**Location:** FR-3; FR-20; addendum §6; §8 Cost.

**Quoted:** FR-3: "Default budget is 1 USDT per UTC day." FR-20: "If the preview exceeds the remaining budget, the run button is disabled." §8: "gas on BSC testnet is free."

**Failure scenario:** At 0.095 USDT per Run the demo Builder gets ten Runs per UTC day. Ten rehearsals on the morning of the pitch disable the run button live. Refunds do not restore budget (unstated). §8 says gas is free while FR-2 and §8 itself pre-fund BNB for gas.

**Smallest fix:** Set demo Accounts' budget to 100 USDT in addendum §6 and add a "reset budget" admin action. Change §8 to "gas is paid in faucet BNB".

---

## F-21 [low] "Visible on Binance Spot Testnet" has nowhere to be seen

**Location:** FR-31 consequence 3; SM-1.

**Quoted:** "The returned order_id is visible on Binance Spot Testnet."

**Failure scenario:** Spot Testnet has no web interface for orders; a judge cannot open it. The proof lives only in the team's own dashboard, which is what a sceptical judge discounts.

**Smallest fix:** Add to FR-31: "the Run view offers a 'verify on Binance' action that queries the order endpoint live and shows the raw response."

---

## F-22 [low] Immediate scoring and windowed scoring can both fire for one Call

**Location:** FR-27; FR-33; addendum §4.

**Quoted:** Addendum §4: "Failure after payment (FR-27): scored as failed at the moment of failure; no window."

**Failure scenario:** The window job later finds the same Call (it has a timestamp and a scored Type) and scores it again, producing a second slash and refund. Nothing marks a Call as already settled.

**Smallest fix:** "Each Call is settled at most once; the Settlement record is unique per Call and the window job skips Calls with an existing record."

---

## Not findings, for the record

- The refund equals the fee, not the trade loss. The brief called this "partial refund"; the PRD makes it a full fee refund. That is a defensible MVP choice, but the pitch should say "fee-level accountability" out loud.
- Settlement is run by the platform key. The brief already admits this; keep the admission in the pitch.
- Platform fee collection is a non-goal. Fine for the MVP; expect the question.
