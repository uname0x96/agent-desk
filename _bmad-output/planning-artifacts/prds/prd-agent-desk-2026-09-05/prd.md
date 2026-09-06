---
title: "PRD: AgentDesk"
status: final
created: 2026-09-05
updated: 2026-09-05
event: "Binance hackathon, Payment Workflows track"
deadline: 2026-09-08
team_size: 5
inputs:
  - _bmad-output/planning-artifacts/briefs/brief-agent-desk-2026-09-05/brief.md
  - _bmad-output/planning-artifacts/briefs/brief-agent-desk-2026-09-05/addendum.md
  - docs/brief-vi.md
---

# PRD: AgentDesk

## 0. Document Purpose

This PRD is for the five-person hackathon team and for the downstream BMad skills (UX, architecture, epics and stories). It defines what the MVP does, not how it is built. It builds on the finalized product brief and its addendum in `_bmad-output/planning-artifacts/briefs/brief-agent-desk-2026-09-05/`, which carry the why-now argument, the competitive landscape, the demo script, and the risk table; none of that is repeated here. Vocabulary is fixed in §3 Glossary. Features are grouped in §4 with globally numbered FRs. Inferred decisions carry an inline `[ASSUMPTION]` tag and are indexed in §11.

`addendum.md` next to this file is normative where it specifies field-level schemas (addendum §1), the x402 wire contract (addendum §3), and the Settlement computation (addendum §4); the PRD's schema block is a summary. The addendum also lists the deviations from the brief's demo script that this PRD introduces (addendum §8), for whoever owns the pitch. Below, "addendum §N" means this file's addendum; the brief's addendum is always named "brief addendum".

The build has three days. §6 maps every FR onto the build order from the brief so the team can cut from the bottom without re-reading the document.

## 1. Vision

AgentDesk is a workflow platform for trading where the building blocks are agents rented from a marketplace, each paid per call through x402 and held accountable through an on-chain stake. A workflow builder composes typed nodes (data, research, risk, execution, notify) into a graph, picks a provider for each node, sees the maximum cost before running, and lets the engine pay each agent's owner directly as the run proceeds. An agent creator lists an agent with an endpoint, a type, and a price, locks a stake, and starts earning from strangers immediately, with a reputation written on-chain after settlement.

The thesis: agents will only work for each other at scale when three things hold at once. A shared contract, so a stranger's agent plugs into anyone's workflow. A payment rail a machine can use without a human confirming. And a consequence when the agent is wrong. Marketplaces and rails exist; the consequence does not. AgentDesk supplies all three in one product and proves it live: a newly listed agent gets paid, gets a call wrong, is slashed, and refunds the user, with no human approval anywhere in the loop.

For the hackathon, the product is the demo in the brief: one five-node workflow on BSC testnet and Binance Spot Testnet, a marketplace with competing research agents, a 30-second listing flow, and a settlement job that turns stake into refunds.

## 2. Target User

### 2.1 Jobs To Be Done

**Workflow builder** (semi-professional trader):

- Run a trading process with analysis and risk control I could not write, without coding.
- Know the maximum agent-fee spend before a run and never exceed my daily budget.
- Trust that a stranger's agent has something to lose if it is wrong.
- Let runs happen without me confirming each payment. In the MVP runs are started by hand; scheduling is v2.

**Agent creator** (developer or small fund):

- Sell one capability per call to people I do not know, with no integration work and no sales channel.
- Set and change my own price, and get paid to a wallet I choose.
- Build a reputation that is verifiable on-chain rather than claimed on Telegram.
- Be judged by results, and be able to top up and return after a bad streak.

### 2.2 Non-Users (v1)

- Institutional desks that need custody and compliance.
- Anyone trading real money on mainnet.
- Creators of agents outside the five standard types.
- Users who want to build agents inside the platform rather than bring an endpoint.

### 2.3 Key User Journeys

The journeys are adapted from the three-minute demo script in the brief addendum §9; the deviations are listed in this PRD's addendum §8. Each journey is realized by the FRs named inline.

- **UJ-1. Linh composes and runs a workflow.** Linh, a part-time BNB trader, signs in, opens the marketplace, and builds a chain in the Workflow Builder: data, research, risk, execution, notify. For each node she picks a provider from the listings of that type. The screen shows "max 0.095 USDT per run" against her remaining daily budget. She sets a 100 USDT order cap and presses run. Each node lights up in turn; the money pane shows five payments leaving her wallet, the largest 0.05 USDT for research, each with a tx hash; an order lands on Binance Spot Testnet; a Telegram message arrives with the summary, the cost table, and the hashes. **Edge case:** the research agent answers 402 with 0.06 USDT instead of the locked 0.05; the engine refuses, marks the node failed, stops the run, pays nothing for research, and Telegram reports the failure. Realizes FR-3, FR-4, FR-18 to FR-32.
- **UJ-2. Minh lists a research agent in 30 seconds.** Minh, a developer nobody on the platform knows, signs up in a second browser tab. His account gets a system wallet, pre-funded for the demo. He pastes an endpoint URL, picks type research, sets 0.03 USDT per call, accepts the default stake of 0.30 USDT, and submits. The platform makes one paid sample call, checks the response against the research schema, registers the ERC-8004 identity, locks the stake from his wallet into the registry entry, and shows the listing on the marketplace. No one approves it. Realizes FR-1, FR-2, FR-5 to FR-7, FR-10 to FR-13.
- **UJ-3. Linh swaps provider and money flows to the stranger.** Back in her tab, Linh opens the workflow, changes the research node's provider to Minh's agent, sees the max cost drop to 0.075 USDT, and runs again. The payment for the research call now lands in Minh's wallet, with a tx hash. Minh's agent answers LONG with confidence 0.9 against the day's downtrend; the risk agent rejects the trade, the execution node is skipped, and the Telegram message says "no order". Realizes FR-21, FR-24, FR-25, FR-28.
- **UJ-4. Settlement holds Minh's agent to its word.** Twenty seconds after the research call, the settlement job scores it against the demo rule, finds it wrong, slashes 0.03 USDT from Minh's stake, transfers it to Linh's wallet, and writes the new reputation on-chain. The settlement view shows the rule, the prices used, and both tx hashes. The marketplace now ranks Minh's agent below the original research agent, which was scored on runs before the demo. Realizes FR-33 to FR-37, FR-41, FR-42.

## 3. Glossary

- **Agent** — An HTTP service, owned by a Creator, that implements one Type's contract and is paid per call. One Agent has exactly one Type, one Listing, one Stake, and one Reputation.
- **Type** — One of five fixed categories: `data`, `research`, `risk`, `execution`, `notify`. Each Type has one standard input schema and one standard output schema (§4.4).
- **Listing** — The marketplace record of an Agent: name, Type, endpoint, price per call, Stake, Reputation, payout wallet, status (active or paused).
- **Registry** — The on-chain record set that backs Listings: the ERC-8004 identity plus the AgentDesk registry contract entry holding the fields listed in FR-6.
- **Creator** — An Account that owns one or more Agents.
- **Builder** — An Account that composes and runs Workflows. An Account can act as both Creator and Builder.
- **Workflow Builder** — The screen where a Builder composes a Workflow.
- **Account** — An email login with one System Wallet.
- **System Wallet** — An EVM wallet created for an Account. The platform holds its key in the MVP. It pays agent fees, receives Refunds, funds Stake, and receives payouts.
- **Platform Account** — A seeded Account operated by the team. It owns the Platform Agents and the Seed Agents.
- **Platform Wallet** — The Platform Account's System Wallet. It pays verification Calls and signs Settlement transactions.
- **Payout wallet** — The address that receives an Agent's fees. Defaults to the Creator's System Wallet; the Creator may set an external address.
- **Platform Agent** — An Agent operated by the platform itself. In the MVP these are the only `execution` Agent and the seeded `notify` Agent.
- **Seed Agent** — An Agent built by the team and listed under the Platform Account before the demo so the marketplace is usable.
- **Provider** — The Agent chosen for a given Node.
- **Workflow** — A named, saved, linear chain of Nodes with a trading symbol and an Order Cap.
- **Node** — One position in a Workflow: a Type plus a Provider.
- **Run** — One execution of a Workflow, started manually. A Run has a Price Lock, a cost, a status, and one Call per Node, where a Call may be skipped.
- **Call** — One invocation of an Agent, normally inside a Run (the verification Call of FR-11 belongs to no Run), including its x402 Handshake, payment tx hash, request, response, and status (FR-28).
- **Price Lock** — The snapshot, taken when a Run starts, of every Node's price per call, asset, network, and payout wallet (FR-23, FR-26).
- **x402 Handshake** — The call sequence: request, HTTP 402 with payment requirements, payment authorisation signed from the Builder's System Wallet, retry with Payment Proof, result with the settlement receipt.
- **Payment Proof** — The signed payment authorisation the engine attaches to the retried request. The Agent verifies and settles it through the Facilitator.
- **Facilitator** — The service that verifies a Payment Proof and settles it on-chain: Binance B402 when partner access is granted, otherwise the platform-hosted facilitator at a published URL.
- **Daily Fee Budget** — A per-Account USDT limit on agent fees per UTC day (FR-3).
- **Order Cap** — A per-Workflow USDT limit on the capital of a single order (FR-4).
- **Platform Exchange Account** — The single Binance Spot Testnet account that the `execution` Platform Agent trades through for every Builder in the MVP.
- **Stake** — USDT locked by a Creator when listing an Agent. It funds Refunds. Minimum: FR-7, FR-9.
- **Settlement** — The job that scores a `research` or `risk` Call against reality after the Settlement Window (§4.8). Lower-case "settlement" and "settlement receipt" mean x402 payment settlement by the Facilitator, not this job.
- **Settlement Window** — The delay between a Call and its Settlement; length per mode in FR-33.
- **Demo mode** — An environment setting that shortens the Settlement Window and switches the research Settlement rule (FR-33, FR-45).
- **Slash** — Deducting exactly the Call's locked price from the Agent's Stake after a failed Settlement.
- **Refund** — Transferring the slashed amount to the Builder's System Wallet.
- **Reputation** — The Agent's pass rate over recent scored Calls, written on-chain after each Settlement (FR-36).
- **Emergency Stop** — A platform-wide flag, set by the Operator, that makes the `execution` Agent refuse all orders.
- **Operator** — A team member with access to platform configuration (FR-45).

## 4. Features

In scope for the MVP:

- Accounts with email login and a platform-managed System Wallet each (§4.1).
- Agent identity and registry with Stake (§4.2).
- Marketplace with six Seed Agents, an unreviewed listing flow with Stake lock and schema verification, and Type-based browsing (§4.3).
- Five standard Type contracts and the x402 Agent contract (§4.4).
- Linear Workflow Builder with compatibility validation, max-cost preview, and Provider swap (§4.5).
- Engine with Price Lock, budget and balance checks, sequential x402 Calls settled through a Facilitator, skipped Nodes, and a live log (§4.6).
- Platform `execution` Agent on Binance Spot Testnet with Order Cap and Emergency Stop; Telegram Notifier; Operator controls (§4.7).
- Settlement with research and risk rules, a demo-mode rule, Slash, Refund, on-chain Reputation, and pause on zero Stake (§4.8).
- Dashboard with Run feed, payments, Settlement view, Agent detail, and demo split view (§4.9).
- Six Seed Agents (§4.10).

### 4.1 Accounts and wallets

**Description:** A person signs up with email and password and receives an Account with a System Wallet. The same Account can list Agents and run Workflows. The wallet address and balances (testnet USDT and testnet BNB for gas) are visible; funding means sending testnet tokens to that address. For the demo, the team pre-funds the wallets. The Account holds a Daily Fee Budget.

MVP wallets are platform-managed hot wallets: the platform generates and holds every key; spending is capped by the Daily Fee Budget. On-chain transfers are still wallet to wallet with no platform intermediary, and a Creator can direct payouts to an external wallet today. External Builder wallets and withdrawals are v2. Realizes UJ-1, UJ-2.

#### FR-1: Email sign-up and sign-in

A person can create an Account with an email address and password, and sign in and out.

**Consequences (testable):**
- Sign-up with a new email creates exactly one Account and one System Wallet.
- Sign-up with an existing email is refused with the message "email already registered".
- A signed-out user cannot reach the listing form, the Workflow Builder, or the dashboard.

**Out of Scope:** password reset, magic links, OAuth, two-factor authentication.

#### FR-2: System Wallet per Account

The platform creates one EVM wallet on BSC testnet for each new Account and holds its private key.

**Consequences (testable):**
- The wallet address is shown in account settings within one second of sign-up.
- The key is stored encrypted at rest and is never returned by any API or page.
- The settings page shows the wallet's testnet USDT and testnet BNB balances, refreshed on page load.
- Any one-time token approval the payment scheme needs (addendum §3) is made at wallet creation, so a first Run never fails on approval.

**Out of Scope:** withdrawals, exporting the key, connecting an external wallet.

#### FR-3: Daily Fee Budget

A Builder can set a Daily Fee Budget in USDT for their Account.

**Consequences (testable):**
- Default budget is 1 USDT per UTC day; demo Accounts are configured at 100 USDT (addendum §6).
- The remaining budget is shown in the Workflow Builder next to the max-cost preview.
- A Run whose Price Lock total exceeds the remaining budget is refused before any Call is made, with the shortfall shown.
- Spend is reserved against the budget at Price Lock time; the reserved amount of every Node that ends unpaid (skipped, failed before payment, or never reached) is released when the Run ends.
- A Refund does not restore budget.

#### FR-4: Order Cap

A Builder can set an Order Cap in USDT on each Workflow.

**Consequences (testable):**
- The Order Cap is required to save a Workflow that contains an `execution` Node.
- The Order Cap is passed to the `risk` Node as `proposed_size_usdt`.
- The engine refuses to call `execution` with a `size_usdt` above the Order Cap, before paying (FR-25); the `execution` Agent enforces the platform's global order ceiling and Emergency Stop and answers `REJECTED` (FR-31).

### 4.2 Agent identity and registry

**Description:** Every listed Agent has an on-chain identity and a Registry entry. The Creator locks Stake when listing and can top it up. The Stake minimum applies continuously: a price change that would break it is refused. Runs in progress keep their Price Lock. An Agent whose Stake reaches zero is paused automatically. Realizes UJ-2, UJ-4.

#### FR-5: ERC-8004 identity

The platform registers an ERC-8004 identity for each new Agent, owned by the Creator's System Wallet.

**Consequences (testable):**
- The identity's agent id is stored on the Listing and shown on the Agent detail page with an explorer link.
- Registration is signed by the Creator's System Wallet, so the identity is owned on-chain by the Creator. Custody of that wallet's key is platform-side in the MVP (§4.1).

#### FR-6: Registry entry

The platform writes a Registry entry for each Agent holding Type, endpoint, price per call, Stake, Reputation, payout wallet, and status.

**Consequences (testable):**
- The entry exists on-chain before the Listing becomes visible.
- Price, Stake, Reputation, and status shown on the Listing match the on-chain entry after each update.

#### FR-7: Stake lock and top-up

A Creator can lock Stake from their System Wallet when listing and top it up at any time.

**Consequences (testable):**
- Listing is refused if the Stake is below ten times the price per call or if the System Wallet balance is insufficient.
- Top-up moves USDT from the System Wallet to the Stake and updates the Registry entry.
- Platform Agents lock Stake like any Listing.
- Stake withdrawal is not available.

**Notes:** `[NOTE FOR PM]` Stake bounds the Refunds an Agent can pay, not the number of Calls it can take. Without FR-25, an Agent with Stake worth ten Calls could be paid for a hundred inside one window; FR-25 reserves Stake against unscored Calls so the coverage is at least one Call deep, and the pitch should describe the accountability as fee-level, not loss-level.

#### FR-8: Automatic pause at zero Stake

The platform pauses a Listing when its Stake reaches zero and resumes it when Stake is topped up to at least ten times the current price per call.

**Consequences (testable):**
- A paused Agent cannot be chosen as a Provider, and existing Workflows that use it fail validation until the Provider is swapped.
- A Run already started continues against a paused Agent at its locked price.
- The pause and resume are visible on the Listing and recorded in the Registry entry.

#### FR-9: Price change

A Creator can change an Agent's price per call at any time, subject to the Stake minimum.

**Consequences (testable):**
- A change that would put Stake below ten times the new price is refused with the shortfall shown.
- The new price shows on the Listing immediately, and each change is recorded with timestamp, old price, and new price (shown by FR-42).
- Runs already started keep their Price Lock; a 402 at the new price inside such a Run is rejected (FR-26).

### 4.3 Marketplace and listing

**Description:** Anyone with an Account can list an Agent by giving an endpoint, a Type, a price, and a Stake. The platform locks the Stake, then makes one paid sample call and refuses the Listing if the response does not match the Type's output schema. Listings appear immediately; there is no review. Builders browse by Type and see price, Stake, Reputation, and owner on each card. Only the Platform Account can list `execution` Agents in the MVP. Realizes UJ-2, UJ-3.

#### FR-10: Listing form

A Creator can submit a Listing with name, Type, endpoint URL, price per call in USDT, Stake amount, and optional description and payout wallet.

**Consequences (testable):**
- The form rejects a non-HTTPS endpoint [ASSUMPTION: HTTPS required, with HTTP allowed for localhost during development], a price of zero, a price above 1 USDT [ASSUMPTION: MVP price ceiling, so a verification Call is never expensive], and a Type other than the five.
- Stake amount defaults to ten times the price and cannot be set lower.
- Payout wallet defaults to the Creator's System Wallet.

#### FR-11: Schema verification call

Before the Stake is locked, the platform makes one real x402 Call to the endpoint with the Type's sample input, paying the declared price from the Platform Wallet, and validates the response against the Type's output schema. It is a paid call, not a free probe, so the Creator sees the first payment land at listing time.

**Consequences (testable):**
- A response that fails schema validation, a non-402 first response, a 402 that differs from the declared price or payout wallet, or a timeout over 15 seconds refuses the Listing with the specific error shown to the Creator; no Stake is locked.
- The Platform Wallet has its own daily cap for verification Calls, 5 USDT [ASSUMPTION].
- The verification Call is shown on the Agent detail page (FR-42), not in any Run, and is never scored.
- `execution` Agents are listed by the seed script without a verification Call, because a sample call would place a real order.

#### FR-12: Immediate listing

A Listing that passes FR-11 and FR-5, then FR-7 and FR-6 in one transaction, in that order, appears on the marketplace without any approval step; a failed verification therefore never locks Stake.

**Consequences (testable):**
- The Listing is visible to all Builders within five seconds of the final on-chain confirmation.
- The whole flow, from opening the form to the card being visible, completes in under 30 seconds on testnet with a responsive endpoint.

#### FR-13: Browse and compare

A Builder can browse Listings filtered by Type and sorted by Reputation or price.

**Consequences (testable):**
- Each card shows name, Type, price per call, Stake, Reputation (a percentage with scored-call count, "no score yet", or "not scored in MVP"), plus owner address and status.
- Reputation sort is percentage descending, then "no score yet", then "not scored in MVP"; ties break by scored-call count, then price ascending.
- Paused Agents are shown but cannot be selected.

#### FR-14: Execution Type restricted to the platform

Only the Platform Account can list Agents of Type `execution`.

**Consequences (testable):**
- The listing form does not offer `execution` to other Accounts.
- The marketplace shows the platform's `execution` Agent as a normal paid Listing.

**Notes:** `[NOTE FOR PM]` Third-party execution Agents are the natural next step once a credential-delegation model exists. See §5.

### 4.4 Standard Type contracts

**Description:** The five Types are the shared language of the marketplace. Every Agent of a Type accepts the same input and returns the same output, which is what lets a stranger's Agent plug into anyone's Workflow. The platform validates every response against the schema. The wire-level x402 contract is specified once so any Creator can implement it. Field types, JSON examples, and validation rules are in addendum §1, which is normative. Realizes every journey.

#### FR-15: Five standard schemas

The platform defines and enforces one input schema and one output schema per Type:

```
data       in  {symbol}
           out {symbol, price, change_24h_pct, volatility_24h_pct, ts}
research   in  {symbol, market: <data.out>}
           out {signal: LONG|SHORT|HOLD, confidence: 0..1, reason}
risk       in  {symbol, signal, confidence, proposed_size_usdt, balance_usdt, market: <data.out>}
           out {decision: APPROVE|REDUCE|REJECT, size_usdt, reason}
execution  in  {symbol, side: BUY|SELL, size_usdt}
           out {status: FILLED|REJECTED, order_id?, filled_price?, filled_qty?, reason?, ts}
notify     in  {run_id, recipient: {channel, address}, summary, cost_table[], tx_hashes[], order?}
           out {delivered: bool, channel, message_ref}
```

**Consequences (testable):**
- A response that does not validate against the output schema makes the Call fail (FR-27, FR-28).
- Unknown fields in a response are ignored; missing required fields fail validation.
- The engine derives each Node's input from the previous Node's output and the Run context (symbol, Order Cap, exchange balance, recipient) without any Creator-side mapping.
- The schemas, the sample payloads, the Facilitator URL, the network, and the asset are published on a public page so a Creator can build an Agent without an Account.

#### FR-16: Agent HTTP contract

An Agent exposes one HTTPS endpoint that answers an unpaid request with HTTP 402 and x402 payment requirements, verifies and settles the Payment Proof on a retried request through the Facilitator, and answers with HTTP 200, the Type's output, and the settlement receipt.

**Consequences (testable):**
- The 402 payment requirements name the amount in USDT, the payout wallet, the asset, the network (BSC testnet), and the scheme.
- The amount, asset, network, and payout wallet must equal the Listing; otherwise the engine rejects the Call (FR-26).
- A request with a valid Payment Proof returns the result and the settlement receipt within 15 seconds; otherwise the Call fails after payment (FR-27).

#### FR-17: Type compatibility rules

The platform enforces which Types may follow which in a Workflow.

**Consequences (testable):**
- `research` requires a `data` Node earlier in the chain; `risk` requires `research` earlier; `execution` requires `risk` earlier; `notify` may appear only last.
- A Workflow contains at most one Node per Type.
- Valid chains include the minimal `data, research, notify` and the full `data, research, risk, execution, notify`.
- Chains from the brief addendum §6 that skip `risk` before `execution` or repeat a Type are out of scope; `risk` is mandatory before `execution`.

### 4.5 Workflow builder

**Description:** A Builder composes a Workflow in the Workflow Builder as a linear chain of Nodes, choosing a Type and then a Provider for each. The screen validates the chain, shows the maximum cost as the sum of current prices, and lets the Builder swap a Provider without touching the rest. The graph is rendered so it is readable; drag-and-drop polish is a non-goal. Realizes UJ-1, UJ-3.

#### FR-18: Create a Workflow

A Builder can create a Workflow with a name, a trading symbol, an Order Cap, and an ordered list of Nodes.

**Consequences (testable):**
- The MVP supports one symbol, BNB/USDT [ASSUMPTION: one symbol keeps the Seed Agents and Settlement simple].
- Each Node is added by picking a Type and then a Provider from the active Listings of that Type.

#### FR-19: Validate the chain

The Workflow Builder validates the chain against FR-17 and FR-8 as the Builder edits it.

**Consequences (testable):**
- A violation is shown inline at the offending Node with the rule that failed.
- A Workflow with any violation cannot be saved or run.

#### FR-20: Maximum-cost preview

The Workflow Builder shows the maximum cost of a Run as the sum of the current price per call of every Node, next to the remaining Daily Fee Budget.

**Consequences (testable):**
- The preview updates within one second of any Provider change.
- If the preview exceeds the remaining budget, the run button is disabled with the shortfall shown.

#### FR-21: Swap Provider

A Builder can change the Provider of one Node without changing any other Node.

**Consequences (testable):**
- The swap preserves the rest of the chain and re-validates it.
- The max-cost preview reflects the new Provider's price.

#### FR-22: Save, list, and run

A Builder can save a Workflow, see their saved Workflows, and start a Run manually.

**Consequences (testable):**
- Runs start only from an explicit run action; there is no scheduling.
- Starting a Run navigates to the live Run view (FR-28).

### 4.6 Workflow engine and payments

**Description:** A Run locks prices, checks budget and balances, and executes Nodes one at a time. Each Node is one x402 Handshake paid from the Builder's System Wallet to the Agent's payout wallet through the Facilitator. The engine refuses a 402 that deviates from the Price Lock and pays nothing. Nodes that are not needed are skipped unpaid. Every Call is logged with amount and tx hash and shown live. A failed Node stops the Run; if the Workflow has a `notify` Node, the engine still sends a failure message through it. Realizes UJ-1, UJ-3.

#### FR-23: Price Lock, budget, and balance check

When a Run starts, the engine snapshots each Node's price, asset, network, and payout wallet, sums the prices, and checks the total against the remaining Daily Fee Budget and the System Wallet's USDT balance. A BNB gas floor applies only if the payment rail needs gas from the System Wallet; with the relayed EIP-3009 rail chosen in architecture, it is zero.

**Consequences (testable):**
- The Price Lock is stored on the Run and shown in the Run view.
- A total above the remaining budget refuses the Run with "refused: budget" and the shortfall (FR-3).
- A USDT balance below the total (or BNB below a non-zero gas floor) refuses the Run with "refused: insufficient balance" before any Call.

#### FR-24: Sequential execution with schema mapping and skips

The engine executes Nodes in chain order, building each Node's input from the previous output and Run context per FR-15, and skips Nodes that are not needed.

**Consequences (testable):**
- A Node starts after the previous Node succeeded or was skipped; `notify` also runs after a failure (FR-29).
- The `risk` Node receives `proposed_size_usdt` equal to the Order Cap and `balance_usdt` from the Platform Exchange Account.
- A `HOLD` signal skips `risk` and `execution`; a `REJECT` decision skips `execution`. A skipped Node is not paid, its reserved budget is released, and its Call status is `skipped`.
- `LONG` maps to side `BUY` and `SHORT` to `SELL` for the `execution` input.
- A Run whose `execution` Node was skipped ends with status "completed, no order"; the `notify` summary says so.

#### FR-25: x402 Handshake per Node

For each Node the engine calls the endpoint, receives 402, compares it with the Price Lock, signs a payment authorisation from the Builder's System Wallet, retries with the Payment Proof, and validates the result and the settlement receipt.

**Consequences (testable):**
- The on-chain transfer goes from the Builder's System Wallet to the Agent's payout wallet with no platform intermediary; the Facilitator only relays.
- The payment tx hash is recorded on the Call from the settlement receipt that arrives with the 200 response.
- A paid request that times out is resent once with the same Payment Proof; the engine never signs a second authorisation for the same Call. If the second attempt also fails, the Call is `failed_after_payment` if the settlement is found on-chain, otherwise `payment_failed`.
- Before paying `execution`, the engine checks the Order Cap and the Emergency Stop and fails the Call before paying if either blocks the order.
- Before paying a `research` or `risk` Agent, the engine checks that its Stake minus the locked prices of its unscored Calls covers this Call's locked price; otherwise the Call fails with "stake exhausted" and the Run stops.
- The Call is marked `succeeded` only after the result passes schema validation.

#### FR-26: Reject Price Lock mismatch

The engine rejects a 402 whose amount, asset, network, or payout wallet differs from the Price Lock for that Node.

**Consequences (testable):**
- No payment is made; the Call is marked `price_mismatch` with both values shown.
- The Run stops (FR-29).

#### FR-27: Failure after payment

If an Agent times out or returns an invalid response after being paid, the Call is marked `failed_after_payment`. In every case the Run stops (FR-29). For `research` and `risk` the Call is scored as a failed Settlement immediately, with no window [ASSUMPTION: a paid non-answer is treated like a wrong answer]. For `data`, `execution`, and `notify` it is only logged; no Slash or Refund occurs in the MVP.

**Consequences (testable):**
- For `research` and `risk`, Settlement slashes the Call's locked price from the Agent's Stake and refunds the Builder (FR-35), and the failure counts against Reputation (FR-36).
- For other Types, the payments view shows the payment with status `failed_after_payment` and no Refund.

#### FR-28: Live Run log

The engine records, per Call: Node, Provider, status, amount, tx hash, request, response, and timestamps, and shows the Run live.

**Consequences (testable):**
- Call statuses are exactly: `pending`, `price_mismatch`, `payment_failed`, `paid_awaiting_result`, `succeeded`, `failed_after_payment`, `skipped`.
- Run statuses are exactly: `running`, `completed`, `completed, no order`, `failed at <Node>`, `timed out`.
- The Run view updates within two seconds of each status change without a page reload.
- Each tx hash links to the BSC testnet explorer.

#### FR-29: Stop on failure, notify anyway

A failed Node stops the Run; later Nodes are not called or paid, except a `notify` Node, which the engine calls with a failure summary.

**Consequences (testable):**
- The Run status is "failed at <Node>" and the reason is shown.
- The `notify` Call is paid at its locked price and its message names the failed Node, the reason, and every payment already made.
- Budget reserved for the other unpaid Nodes is released (FR-3).
- A failure in the `notify` Node itself ends the Run with no further attempt.
- A Run that has not ended 120 seconds after start is marked `timed out`, its reserved budget is released, and the Workflow is free to run again.

#### FR-30: Repeatable Runs

A Builder can start a new Run of the same Workflow at any time after the previous Run ends.

**Consequences (testable):**
- Each Run has its own Price Lock, Calls, and log.
- Two Runs of the same Workflow cannot execute at the same time.

### 4.7 Platform Agents and operator controls

**Description:** The `execution` Agent is operated by the platform because it holds the exchange credentials. It is listed and paid like any Agent. It places market orders on Binance Spot Testnet, enforces the platform's global order ceiling, and obeys the Emergency Stop. All Builders trade through one Platform Exchange Account in the MVP; `balance_usdt` is that account's balance, and per-Builder exchange capital is post-hackathon (§5). The Telegram Notifier is a Platform Agent of Type `notify` that implements the open contract; a third-party `notify` Agent can be listed the same way. The Operator sets platform configuration. Realizes UJ-1.

#### FR-31: Execution Agent

The `execution` Platform Agent places a market order on Binance Spot Testnet through the Platform Exchange Account for the given symbol, side, and size, and returns the fill.

**Consequences (testable):**
- An order with `size_usdt` above the platform's global order ceiling, an order while Emergency Stop is on, or an order the exchange rejects returns a schema-valid `REJECTED` with the reason; the Call succeeds and the Run continues to `notify` with "no order".
- The Run view offers a "verify on Binance" action that queries the order live from the exchange and shows the raw response, since Spot Testnet has no public order page.
- If Binance MCP is unavailable on Spot Testnet, the Agent uses the Spot Testnet REST API directly; the contract does not change.

#### FR-32: Telegram Notifier

The Telegram Notifier sends the Run summary, cost table, tx hashes, and order (if any) to the recipient named in the input.

**Consequences (testable):**
- The Builder links a Telegram chat id in account settings after starting the shared bot [ASSUMPTION: one shared bot, chat id pasted by the user]; the engine fills `recipient` from settings and fails the Node before paying, with the reason "no Telegram chat id linked", if no chat id is linked.
- The message arrives within ten seconds of the Node's Call and contains every tx hash of the preceding Nodes.

#### FR-45: Operator controls

The Operator can set the Emergency Stop, switch demo mode, and reset an Account's Daily Fee Budget through configuration or a single admin page.

**Consequences (testable):**
- Each change takes effect within five seconds without a restart.
- The current state of Emergency Stop and demo mode is visible on the dashboard header.

### 4.8 Settlement and Reputation

**Description:** After the Settlement Window, a job scores each `research` and `risk` Call against a platform-fetched Binance price series. A failed score slashes exactly the Call's locked price from the Agent's Stake and refunds the Builder, and the Agent's Reputation is recomputed and written on-chain. In demo mode the research rule uses the 24-hour trend so the demo is reproducible without a fake price feed. `data`, `execution`, and `notify` Calls are paid but never scored. The Settlement job is run by the platform with the Platform Wallet's key; slashing is centralised even though funds are not, and the brief's roadmap names an independent judge Agent as the answer. Realizes UJ-4.

#### FR-33: Research rule

Settlement passes a `research` Call by comparing the signal with the price move between the Call and the end of the Settlement Window in production mode, and with the 24-hour trend at the end of the window in demo mode.

**Consequences (testable):**
- Production mode: LONG passes if the price rose; SHORT passes if it fell; HOLD passes if the absolute change is below 0.1 percent.
- Demo mode: LONG passes if `change_24h_pct` at window end is positive; SHORT passes if it is negative; HOLD passes if its absolute value is below 0.5 percent. The Settlement view labels the result "demo settlement rule".
- Prices come from the platform-fetched public market data of the live Binance exchange (not Spot Testnet), not from the paid `data` Agent [ASSUMPTION: one price source for every Settlement].
- The Settlement Window is one hour in production mode and 20 seconds in demo mode, counted from the Call's success; in demo mode the job polls every two seconds.

#### FR-34: Risk rule

Settlement passes a `risk` Call whose decision was APPROVE or REDUCE if the resulting position's drawdown inside the Settlement Window stayed within 2 percent; REJECT decisions are not scored.

**Consequences (testable):**
- Drawdown is computed from the live-exchange last price at fill time and the lowest (for BUY) or highest (for SELL) live-exchange price inside the window.
- A `risk` Call with no resulting order is recorded as "not scored".

**Notes:** `[NOTE FOR PM]` A wrong LONG slashes both `research` and `risk` for one event, and a `risk` Agent that always rejects is never scored. Both are accepted for the MVP; the roadmap's judge Agent should score `risk` on sizing rather than direction.

#### FR-35: Slash and Refund

On a failed Settlement the platform slashes exactly the Call's locked price from the Agent's Stake and transfers it to the Builder's System Wallet.

**Consequences (testable):**
- The Slash and the Refund are one on-chain transaction, and the Reputation update a second; both tx hashes are shown on the Settlement view and in the Run log.
- The Stake shown on the Listing decreases by the slashed amount.
- If Stake is lower than the price, the whole remaining Stake is slashed and refunded, and the Agent is paused (FR-8).
- Each Call is scored at most once; the Settlement record is unique per Call and the Settlement job skips Calls that already have one.

**Notes:** The brief described the Refund as partial; the PRD sets it to the full Call fee, by decision. The Refund is the fee, not the trade loss.

#### FR-36: Reputation

The platform recomputes Reputation after every Settlement as the share of passed Calls among the Agent's last 30 scored Calls, and writes it to the Registry entry.

**Consequences (testable):**
- An Agent of a scored Type with no scored Calls shows "no score yet".
- The marketplace sort by Reputation reflects the new value within five seconds of the on-chain write.

#### FR-37: Pause on exhausted Stake

Settlement triggers the pause in FR-8 when Stake reaches zero.

**Consequences (testable):**
- The pause happens in the same job that performed the final slash.

#### FR-38: Unscored Types

`data`, `execution`, and `notify` Calls are never scored by Settlement.

**Consequences (testable):**
- Their Listings show Reputation as "not scored in MVP".

### 4.9 Dashboard

**Description:** The dashboard shows every Run, every Call, every payment with its tx hash, every Settlement outcome, and each Agent's Reputation history. A split view puts the agent request/response log on the left and the money flow on the right for the demo. Realizes UJ-1, UJ-3, UJ-4.

#### FR-39: Run feed

A Builder can see their Runs with status, Nodes, total cost, and start time, updating live.

**Consequences (testable):**
- A new Run appears at the top within two seconds of starting.

#### FR-40: Payments view

A Builder can see every payment they made: Run, Node, Provider, amount, from and to addresses, status, and tx hash with explorer link.

**Consequences (testable):**
- The sum of payments per Run equals the Run's cost.

#### FR-41: Settlement view

A Builder can see every scored Call: rule applied, mode, prices used and their source, result, Slash tx hash, and Refund amount.

**Consequences (testable):**
- A failed Settlement shows the Refund landing in the Builder's System Wallet with its tx hash.

#### FR-42: Agent detail

Anyone signed in can open an Agent's page showing its identity, Stake, price history, Reputation history, scored-call count, and its verification Call.

**Consequences (testable):**
- The Reputation history shows one point per Settlement.

#### FR-43: Demo split view

A Builder can open a Run in a split view: agent request/response log on the left, money flow on the right.

**Consequences (testable):**
- Both panes update live during a Run.

### 4.10 Seed Agents

**Description:** The team builds and lists six Agents under the Platform Account before the demo so the marketplace is usable: one per Type plus a second `research` Agent that is deliberately sloppy. They implement the same contract as any third-party Agent. Behaviour detail is in addendum §2.

#### FR-44: Six Seed Agents

The platform ships with these Listings: `data` (Binance ticker), `research-good` (LLM analysis with a stated reason, prompted to follow the 24-hour trend), `research-sloppy` (confident signals against the 24-hour trend), `risk` (rejects a confident counter-trend signal; reduces or rejects on volatility), `execution` (Platform Agent), `notify` (Telegram Notifier).

**Consequences (testable):**
- All Seed Agents except `execution` pass FR-11 verification when listed (FR-11 exempts `execution`).
- In demo mode `research-sloppy` fails every Settlement and `research-good` passes every Settlement, because both are defined against the same 24-hour trend the demo rule scores.
- In the demo, Minh lists the `research-sloppy` endpoint live; the seeded Listing of the same endpoint is the failover if the live Listing fails.
- `research-good` and `research-sloppy` have different prices so the max-cost preview visibly changes on swap.

## 5. Non-Goals (Explicit)

- Mainnet, real funds, or any asset other than USDT fees and BNB/USDT orders on testnet.
- Third-party `execution` Agents; any delegation of exchange credentials to a stranger's Agent.
- Per-Builder exchange accounts or exchange capital; the MVP trades one Platform Exchange Account.
- Dispute handling, appeals, governance, or human review of Settlements; an independent judge Agent.
- Custom Types or Creator-defined schemas.
- Branching, fan-in, parallel Nodes, scheduling, backtesting, Workflow versioning.
- Multi-chain, multi-asset, multiple symbols.
- Platform fee collection. The fee model is documented in the brief; the MVP collects nothing.
- Withdrawals from System Wallets or Stake; external Builder wallets; key export.
- Polished drag-and-drop; mobile layouts; accessibility beyond keyboard-navigable forms.
- Outcome-based or resource-based pricing.

Deferred rather than rejected:

- Password reset and any auth beyond email and password; the demo uses prepared Accounts.
- Symbols other than BNB/USDT; v2.
- Binance MCP for market data; the `data` Seed Agent uses the public REST ticker.

## 6. Build Order

The brief's cut order, with the FRs each stage needs. Cut from the bottom.

| Stage | Outcome | FRs |
|---|---|---|
| 1. Spine | Registry entry for one Agent, one Agent that answers 402, an engine that pays it through the Facilitator and gets a result | FR-3 (constant budget on a hard-coded wallet), FR-5, FR-6, FR-7, FR-15, FR-16, FR-23, FR-25, FR-26, FR-28, one Seed Agent from FR-44 |
| 2. Full run | Five-node Run ends in a Binance Spot Testnet order and a Telegram message | FR-4, FR-17 to FR-22, FR-24, FR-29 to FR-32, FR-45, all of FR-44 |
| 3. Listing | A stranger lists a new Agent with no approval in under 30 seconds | FR-1, FR-2, FR-9 to FR-14 |
| 4. Settlement | A wrong Call is slashed and refunded, Reputation moves on-chain | FR-8, FR-27, FR-33 to FR-38, and the Stake reservation check in FR-25 |
| 5. Dashboard | Every Call and every payment visible; demo split view | FR-39 to FR-43 |

Stage 1 and 2 run with a single hard-coded Builder wallet; Accounts arrive in stage 3.

## 7. Cross-Cutting NFRs

- **Run latency.** A five-node Run completes in 45 seconds in the demo, with 60 seconds as the engineering ceiling, on BSC testnet with responsive Agents; each payment settles within 10 seconds.
- **Demo reliability.** The engine retries a chain RPC error up to three times before failing a Call, never re-signing a payment; a paid request to an Agent is resent once (FR-25). Two prepared wallet sets exist for the demo. `research-good` is scored on Runs before the demo so its Reputation is above zero when Minh's Agent is slashed. A recorded backup of the full demo exists before the presentation.
- **Security and safety.** Testnet only; no withdrawals. System Wallet keys are encrypted at rest and never leave the server (FR-2). The exchange credentials exist only in the `execution` Agent's configuration. Budgets, the Order Cap, Emergency Stop, and Stake minimums are enforced server-side, never only in the UI, and the Order Cap is checked before payment while the `execution` Agent enforces the platform's global order ceiling. An exchange-side limit on the Platform Exchange Account is added if Spot Testnet offers one (Open Question 2). The signing service serialises transactions per wallet so concurrent Runs and Settlements never collide on nonces.
- **Trust.** Wallet custody and Settlement are platform-side in the MVP, stated plainly in the pitch (addendum §8). On-chain transfers, Stake, Slash, and Reputation are verifiable by anyone.
- **Observability.** Every Call and every on-chain transaction is logged with tx hash and retained for the hackathon period. The Run log is the source of truth for the dashboard.
- **Compatibility.** BSC testnet (chain id 97); the USDT asset and Facilitator per addendum §3; Binance Spot Testnet.
- **Openness.** A Creator can implement an Agent from the public schema page and the HTTP contract alone, including the Facilitator URL, network, and asset, without reading platform code.

## 8. Constraints

- **Privacy.** The platform stores email, password hash, wallet address, encrypted key, and Telegram chat id. Nothing else personal.
- **Cost.** Agent fees are cents; gas is paid in faucet BNB. The platform pre-funds testnet BNB and testnet USDT into demo wallets [ASSUMPTION: faucet or team-minted supply is sufficient].
- **Time.** Three build days for five people. Any FR whose §6 stage has not been reached by the end of day two is cut, not deferred silently.

## 9. Success Metrics

**Primary**

- **SM-1: Demo completes live.** At least two Runs with every payment settled on-chain, one Binance Spot Testnet order, one live listing, one Provider swap, one Slash with Refund, all inside the three minutes and without a manual step between Run start and the Telegram message. Validates FR-10 to FR-12, FR-23 to FR-26, FR-31, FR-32, FR-35.
- **SM-2: Listing in 30 seconds.** Time from opening the listing form to the card being visible is at most 30 seconds. Validates FR-10 to FR-12.
- **SM-3: Run in 45 seconds.** A five-node Run completes in at most 45 seconds. Validates FR-24, FR-25.

**Secondary**

- **SM-4: Zero manual approvals.** No human action is needed between pressing run and receiving the notification, and none between submitting a Listing and its appearance. Validates FR-12, FR-22, FR-25.
- **SM-5: Price Lock holds.** A 402 with a changed price is rejected in rehearsal and pays nothing. Validates FR-26.

**Counter-metrics (must not rise while the primaries are pushed)**

- **SM-C1: Fee leakage.** Share of paid Calls of an unscored Type that end `failed_after_payment`, where the Builder paid and got nothing back. Counterbalances SM-4.
- **SM-C2: Junk listings.** Share of submitted Listings refused by FR-11, or listed and then paused within a day. Counterbalances SM-2.

**Outcome goals** (not testable in the build): placement in the Payment Workflows track of the Binance hackathon, and a follow-up conversation about listing on BNB Agent Studio. Post-hackathon signal: Agents listed by people outside the team, and repeat Runs by users who are not the team.

## 10. Open Questions

1. Is B402 partner onboarding on BSC testnet granted before day two, and does the reported daily agent payment cap apply to on-chain B402 payments? Fallback is the platform-hosted Facilitator with the team's own EIP-3009 test token (addendum §3).
2. Does Binance Spot Testnet offer sub-accounts or an exchange-side spending limit? Verify on day one; if not, the Order Cap is the only capital ceiling in the demo (§7 Security and safety).
3. Does Binance MCP work against Spot Testnet, or does the `execution` Agent call the REST API directly (FR-31)?
4. Build the Registry on the BNBAgent SDK (ERC-8004 plus ERC-8183 escrow) or as a custom contract? Architecture decision.
5. Who covers gas for Creator and Builder System Wallets after the hackathon? The MVP pre-funds.
6. Submit to BNB Chain's Build the Era as well? It closes one day after the Binance deadline.
7. Does the hackathon require a public repository or a hosted demo URL? Affects the deployment stage.

## 11. Assumptions Index

- §4.3 FR-10 — MVP price ceiling of 1 USDT per call, so a verification Call is never expensive.
- §4.3 FR-10 — endpoints must be HTTPS, with HTTP allowed for localhost during development.
- §4.3 FR-11 — the Platform Wallet's daily cap for verification Calls is 5 USDT.
- §4.5 FR-18 — the MVP supports only BNB/USDT.
- §4.6 FR-27 — a paid non-answer from `research` or `risk` is scored as a wrong answer immediately.
- §4.7 FR-32 — one shared Telegram bot; the user pastes their chat id.
- §4.8 FR-33 — Settlement prices come from the live Binance exchange's public market data, not the paid `data` Agent.
- §8 Cost — the platform pre-funds testnet BNB and testnet USDT into demo wallets from faucets or a team-minted supply.
