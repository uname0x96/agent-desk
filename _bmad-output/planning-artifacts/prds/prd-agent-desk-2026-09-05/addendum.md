---
title: "PRD Addendum: AgentDesk"
status: final
created: 2026-09-05
updated: 2026-09-05
---

# PRD Addendum: AgentDesk

Technical and operational detail that supports the PRD. Sections 1 to 4 are normative: they are acceptance criteria for the engine, the Seed Agents, and any third-party Agent. Sections 5 to 7 are for architecture; engineers can stop at §7. Section 8 is for whoever owns the pitch. Architecture reads this alongside the PRD and the brief addendum (`_bmad-output/planning-artifacts/briefs/brief-agent-desk-2026-09-05/addendum.md`), which holds the proposed stack, the verified landscape facts, the demo script, and the risk table.

## 1. Standard Type schemas, field level

All timestamps are ISO 8601 UTC strings. All amounts are decimal strings in USDT unless named otherwise. Unknown fields in a response are ignored; missing required fields fail validation. Chain rules (PRD FR-24): on `HOLD` the engine skips `risk` and `execution`; on `REJECT` it skips `execution`; skipped Nodes are never called.

### data

```json
// in
{ "symbol": "BNBUSDT" }
// out
{ "symbol": "BNBUSDT", "price": "612.40", "change_24h_pct": -1.8, "volatility_24h_pct": 3.2, "ts": "2026-09-05T02:00:00Z" }
```

`volatility_24h_pct` is (high - low) / low over the last 24 hours, in percent.

### research

```json
// in
{ "symbol": "BNBUSDT", "market": { ...data.out } }
// out
{ "signal": "LONG", "confidence": 0.72, "reason": "Price reclaimed the 24h midpoint on rising volume." }
```

`signal` is one of `LONG`, `SHORT`, `HOLD`. `confidence` is a number in [0, 1]. `reason` is a non-empty string, at most 500 characters.

### risk

```json
// in
{ "symbol": "BNBUSDT", "signal": "LONG", "confidence": 0.72, "proposed_size_usdt": "100", "balance_usdt": "950.00", "market": { ...data.out } }
// out
{ "decision": "REDUCE", "size_usdt": "60", "reason": "24h volatility above 3%." }
```

`decision` is one of `APPROVE`, `REDUCE`, `REJECT`. `size_usdt` must be at most `proposed_size_usdt` and at most `balance_usdt`; for `REJECT` it is `"0"`.

### execution

```json
// in
{ "symbol": "BNBUSDT", "side": "BUY", "size_usdt": "60" }
// out (filled)
{ "status": "FILLED", "order_id": "123456789", "filled_price": "612.55", "filled_qty": "0.0979", "ts": "2026-09-05T02:00:07Z" }
// out (refused)
{ "status": "REJECTED", "reason": "emergency stop", "ts": "2026-09-05T02:00:07Z" }
```

`status` is `FILLED` or `REJECTED`. `order_id`, `filled_price`, and `filled_qty` are required when `FILLED`; `reason` is required when `REJECTED`. The engine derives `side`: `LONG` maps to `BUY`, `SHORT` to `SELL`.

### notify

```json
// in
{ "run_id": "run_01J...", "recipient": { "channel": "telegram", "address": "123456789" }, "summary": "LONG BNBUSDT, reduced to 60 USDT, filled at 612.55", "cost_table": [ { "node": "research", "provider": "Alpha Research", "amount": "0.05", "tx_hash": "0x..." } ], "tx_hashes": [ "0x..." ], "order": { ...execution.out } }
// out
{ "delivered": true, "channel": "telegram", "message_ref": "4521" }
```

`recipient.channel` is `telegram` in the MVP; `address` is the chat id. `cost_table[].tx_hash` is optional and omitted when the settlement hash is not yet known; `tx_hashes[]` lists only known hashes. The engine fills `recipient` from the Builder's settings and fails the Node before paying if `recipient` is empty. On a failed Run (FR-29) the engine sends the same shape: `summary` names the failed Node and reason, `cost_table` lists only the Calls actually paid, and `order` is absent. On a Run with a skipped `execution` Node, `summary` ends with "no order". The verification sample for `notify` carries the Platform Account's chat id.

## 2. Seed Agent behaviours

| Listing | Type | Price (USDT) | Behaviour |
|---|---|---|---|
| Binance Ticker | data | 0.01 | Fetches the 24h ticker for the symbol from the Binance production public REST API; computes volatility as high-low over low. |
| Alpha Research | research | 0.05 | Sends the market snapshot to an LLM with a fixed prompt that must return a signal in the direction of `change_24h_pct`, a confidence, and a one-sentence reason grounded in the snapshot. Falls back to HOLD with confidence 0.5 on LLM error. |
| Sloppy Research | research | 0.03 | Returns LONG when `change_24h_pct` is negative and SHORT when it is positive, with confidence 0.9 and a generic reason. Built to fail the demo Settlement rule every time. |
| Guardrail Risk | risk | 0.02 | REJECT when `confidence` > 0.85 and the signal opposes the sign of `change_24h_pct`; otherwise REJECT when `volatility_24h_pct` > 6, REDUCE to 60 percent of proposed size when > 3, APPROVE otherwise. Never exceeds `balance_usdt`. |
| Binance Spot Executor | execution | 0.01 | Platform Agent. Market order through the Platform Exchange Account; enforces the platform's global order ceiling and Emergency Stop (the per-workflow Order Cap is enforced by the engine before payment); answers `REJECTED` with a reason instead of failing. |
| Telegram Notifier | notify | 0.005 | Platform Agent. Posts a formatted message with the summary, cost table, tx hashes, and order to `recipient.address`. |

Full chain cost with Alpha Research: 0.095 USDT. With Sloppy Research: 0.075 USDT. Prices are set so the Provider swap visibly changes the max-cost preview.

## 3. x402 wire contract

- Method: `POST {endpoint}` with JSON body equal to the Type's input.
- Unpaid response: HTTP 402 with the x402 v2 payment-required payload in the `PAYMENT-REQUIRED` header, which names the scheme, network (`eip155:97`, BSC testnet), asset contract, amount, and pay-to address; the Facilitator URL is published on the schema page, not in the payload. Amount, asset, network, and pay-to must equal the Price Lock exactly.
- Payment: the engine signs an off-chain payment authorisation (the Payment Proof) from the Builder's System Wallet for exactly the amount and sends it in the `PAYMENT-SIGNATURE` header on the retried request. It never signs twice for one Call.
- Agent side: the Agent asks the Facilitator to verify the authorisation, does the work, and settles through the Facilitator before responding, as the x402 reference middleware does; a handler failure returns an error and is not settled, so the Builder is not charged. The 200 response carries the Type's output and the settlement receipt (tx hash) in the `PAYMENT-RESPONSE` header. The engine records the tx hash from that receipt. Failure after payment (FR-27) therefore means a settled response whose output fails validation, or a paid retry that times out after settlement.
- Timeouts: 15 seconds for the unpaid request and 15 seconds for the paid retry; if the paid retry times out, the engine sends it once more with the same header, so at most two paid attempts.
- Facilitator and asset, two paths:
  - **B402 path** (if Binance partner access lands by day two): Binance B402 facilitator on BSC testnet, testnet USDT, `permit2-exact` scheme; each System Wallet makes the one-time Permit2 approval at creation (FR-2).
  - **Fallback path**: the platform hosts the x402 reference facilitator with the plain `exact` EVM scheme against a team-deployed test token implementing EIP-3009 `transferWithAuthorization`, minted freely into demo wallets. No approval transaction is needed.
- The public schema page publishes the active path: Facilitator URL, scheme, network, and asset address, so a third-party Agent can verify against the same Facilitator.
- The verification Call at listing time is the same sequence, initiated by the Platform Wallet.
- Any Creator building an Agent can use the x402 reference server middleware and implement only the handler.

## 4. Settlement computation

Mode values (window, poll interval, kline granularity) are owned by the §6 table.

- Price source for every Settlement: Binance production public market data (ticker and klines), never the paid `data` Agent and never the Spot Testnet book.
- Reference price at Call time: `lastPrice` fetched within five seconds of the Call's success.
- Production mode research rule: window end price against start price. LONG passes if end > start; SHORT passes if end < start; HOLD passes if |end - start| / start < 0.001.
- Demo mode research rule: `change_24h_pct` from the 24h ticker at window end. LONG passes if positive; SHORT passes if negative; HOLD passes if |value| < 0.5. The Settlement view shows "demo settlement rule: 24h trend".
- Risk rule (both modes): for a BUY, drawdown = (p_fill - min price in window) / p_fill; for a SELL, (max price in window - p_fill) / p_fill, where p_fill is the production `lastPrice` at fill time. Pass if drawdown <= 0.02. Window prices come from klines at the granularity in §6.
- Failure after payment (FR-27): `research` and `risk` only; scored as failed at the moment of failure; no window. The Settlement record is written by the settlement job triggered immediately for that Call.
- Each Call is settled at most once: the Settlement record is unique per Call; the window job skips Calls with an existing record.
- Slash amount: exactly the Call's locked price. Refund destination: the Builder's System Wallet of that Run. Slash and refund are one Registry transaction signed by the Platform Wallet; the Reputation update is a second one.
- Reputation: passed / scored over the last 30 scored Calls, stored as basis points in the Registry entry.

## 5. Accounts, wallets, and keys

- Wallet generation on sign-up; key encrypted with a server-side key management secret; decrypted only inside the signing service.
- One signing service signs for Builder payment authorisations, Creator Stake locks, Platform Wallet verification Calls, and Settlement transactions; it enforces the Daily Fee Budget, Stake minimums, and the Platform Wallet's daily verification cap (PRD FR-11) before signing, and serialises transactions per wallet.
- Stake reservation: the engine keeps, per Agent, the sum of locked prices of its unscored `research` and `risk` Calls; a new Call is refused when Stake minus that sum is below the Call's locked price (FR-25).
- Demo wallets: two Builder Accounts and two Creator Accounts prepared in advance, each pre-funded with testnet BNB for gas and testnet USDT; a spare set for failover. Demo Account budgets are in §6.
- Telegram: one shared bot. The Builder starts the bot, the bot replies with the chat id, and the Builder pastes it into settings. Deferred alternative: deep link with a one-time code.
- Platform Exchange Account: one Binance Spot Testnet API key, held only by the `execution` Agent's process. All Builders' orders go through it; `balance_usdt` passed to `risk` is its balance.

## 6. Environment modes

| Setting | Production default | Demo mode |
|---|---|---|
| Settlement Window | 60 minutes | 20 seconds |
| Settlement poll interval | 60 seconds | 2 seconds |
| Research Settlement rule | window price move | 24h trend |
| Kline granularity for drawdown | 1 minute | 1 second |
| Daily Fee Budget default | 1 USDT | 100 USDT on demo Accounts |
| Run timeout | 120 seconds | 120 seconds |
| Emergency Stop | off | off, toggle visible on dashboard header |

The Operator switches modes and resets budgets through configuration or the admin page (FR-45).

## 7. Decisions handed to architecture

- Registry on BNBAgent SDK (ERC-8004 plus ERC-8183 escrow with UMA disputes) versus a custom minimal contract. The PRD needs only identity, price, Stake, Reputation, status, and a Slash that pays the Builder.
- Facilitator path per §3: decide on day one and publish the active path.
- Binance MCP versus direct Spot Testnet REST for the `execution` Agent. Verified 2026-09-05: Spot Testnet offers no sub-accounts and no per-key spending limits; BNBUSDT minimum notional is 5 USDT.
- Runtime: Node.js or Python; Solidity toolchain: Foundry or Hardhat.
- Hosting for the demo: local machine with tunnel versus a cloud host.

All five are resolved in the architecture spine (`_bmad-output/planning-artifacts/architecture/architecture-agent-desk-2026-09-05/ARCHITECTURE-SPINE.md`, 2026-09-05): custom `AgentDeskRegistry` contract with direct ERC-8004 registration; self-hosted reference Facilitator with a team EIP-3009 token (the fallback path above is the active path); Spot Testnet REST with Demo Mode as fallback; TypeScript throughout; Foundry; docker compose on the demo machine.

## 8. Deviations from the brief's demo script

For whoever owns the pitch. The brief addendum §9 script predates these PRD decisions.

- **Cost figures.** All five Types are paid Listings, so the full chain locks 0.095 USDT and the swap drops it to 0.075, not 0.07 and 0.05. Five payments leave the wallet per Run, not two.
- **Timing.** The demo Settlement Window is 20 seconds from the research Call's success. Run 2 must start by about 1:40 for the Slash to land by 2:20; the listing beat should be tightened accordingly.
- **"Risk rejects it."** Kept. Guardrail Risk rejects a confident counter-trend signal, so Sloppy Research's LONG is rejected, `execution` is skipped, and Run 2 ends "completed, no order". The order beat happens in Run 1 only.
- **Settlement rule on screen.** The Settlement view says "demo settlement rule: 24h trend" and the presenter should say so: production scores the price move after one hour; the demo scores against the day's trend because a 20-second move is noise.
- **Judge answer on custody.** Replace "Who holds the money? Nobody." with: "On-chain, money moves wallet to wallet with no intermediary. In this MVP the platform manages the hot wallets, capped by a daily budget; external wallets are the next step." Also say that Settlement is run by the platform today and the roadmap's judge Agent decentralises it.
- **Price-mismatch edge case.** Specified in the PRD (FR-26) and worth one rehearsal, but not a demo beat.
- **Reputation ranking at the close.** Requires Alpha Research (`research-good` in the PRD) to have passed Settlements before the demo (PRD §7 Demo reliability); otherwise both Agents sit at "no score yet" or 0 of 1.
