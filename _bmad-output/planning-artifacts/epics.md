---
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-agent-desk-2026-09-05/prd.md
  - _bmad-output/planning-artifacts/prds/prd-agent-desk-2026-09-05/addendum.md
  - _bmad-output/planning-artifacts/architecture/architecture-agent-desk-2026-09-05/ARCHITECTURE-SPINE.md
---

# AgentDesk - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for AgentDesk, decomposing the requirements from the PRD, its normative addendum, and the architecture spine into implementable stories. Constraints: Binance hackathon, three build days from 2026-09-05, team of five working in parallel, BSC testnet and Binance Spot Testnet only. Epics follow the PRD §6 build order; if time runs short, cut from the bottom.

## Requirements Inventory

### Functional Requirements

FR-1: Email sign-up and sign-in. A person can create an Account with an email address and password, and sign in and out.
FR-2: System Wallet per Account. The platform creates one EVM wallet on BSC testnet for each new Account and holds its encrypted private key.
FR-3: Daily Fee Budget. A Builder can set a Daily Fee Budget in USDT for their Account; spend is reserved at Price Lock time and released for unpaid Nodes.
FR-4: Order Cap. A Builder can set an Order Cap in USDT on each Workflow.
FR-5: ERC-8004 identity. The platform registers an ERC-8004 identity for each new Agent, owned by the Creator's System Wallet.
FR-6: Registry entry. The platform writes a Registry entry for each Agent holding Type, endpoint, price per call, Stake, Reputation, payout wallet, and status.
FR-7: Stake lock and top-up. A Creator can lock Stake (at least ten times the price per call) from their System Wallet when listing and top it up at any time.
FR-8: Automatic pause at zero Stake. The platform pauses a Listing when its Stake reaches zero and resumes it when Stake is topped up to at least ten times the current price per call.
FR-9: Price change. A Creator can change an Agent's price per call at any time, subject to the Stake minimum; Runs in progress keep their Price Lock.
FR-10: Listing form. A Creator can submit a Listing with name, Type, endpoint URL, price per call in USDT (ceiling 1 USDT), Stake amount, and optional description and payout wallet.
FR-11: Schema verification call. Before the Stake is locked, the platform makes one real, paid x402 Call to the endpoint with the Type's sample input from the Platform Wallet (daily cap 5 USDT) and validates the response against the Type's output schema; failure refuses the Listing with the specific error and locks no Stake; `execution` Agents are exempt.
FR-12: Immediate listing. A Listing that passes FR-11 and FR-5, then FR-7 and FR-6 in one transaction, appears on the marketplace within five seconds of the final confirmation, under 30 seconds end to end, with no approval step.
FR-13: Browse and compare. A Builder can browse Listings filtered by Type and sorted by Reputation or price, each card showing price, Stake, Reputation, scored-call count, and owner.
FR-14: Execution Type restricted to the platform. Only the Platform Account can list Agents of Type `execution`.
FR-15: Five standard schemas. The platform defines and enforces one input and one output schema per Type (data, research, risk, execution, notify) as PRD addendum §1 specifies, and publishes them on a public schema page.
FR-16: Agent HTTP contract. An Agent exposes one HTTPS endpoint that answers an unpaid request with HTTP 402 and x402 payment requirements, verifies and settles the Payment Proof on the retried request through the Facilitator, and answers HTTP 200 with the Type's output and the settlement receipt.
FR-17: Type compatibility rules. The platform enforces which Types may follow which in a Workflow (data → research → risk → execution → notify, with allowed omissions).
FR-18: Create a Workflow. A Builder can create a Workflow with a name, a trading symbol, an Order Cap, and an ordered list of Nodes, each bound to one Listing.
FR-19: Validate the chain. The Workflow Builder validates the chain against FR-17 and paused Listings (FR-8) as the Builder edits it.
FR-20: Maximum-cost preview. The Workflow Builder shows the maximum cost of a Run as the sum of every Node's current price next to the remaining Daily Fee Budget.
FR-21: Swap Provider. A Builder can change the Provider of one Node without changing any other Node.
FR-22: Save, list, and run. A Builder can save a Workflow, see their saved Workflows, and start a Run manually.
FR-23: Price Lock, budget, and balance check. When a Run starts, the engine snapshots each Node's price, asset, network, and payout wallet, sums the prices, and checks the total against the remaining Daily Fee Budget and the System Wallet's tUSD balance, refusing with "refused: budget" or "refused: insufficient balance" before any Call.
FR-24: Sequential execution with schema mapping and skips. The engine executes Nodes in chain order, builds each input from the previous output and Run context, and skips `risk` and `execution` on HOLD and `execution` on REJECT; skipped Nodes are never called or paid.
FR-25: x402 Handshake per Node. For each Node the engine calls the endpoint, receives 402, compares it with the Price Lock, signs a payment authorisation from the Builder's System Wallet, retries with the Payment Proof (at most two paid attempts), and validates the result and the settlement receipt; Stake reservation refuses a Call when the Agent's unreserved Stake is below the locked price.
FR-26: Reject Price Lock mismatch. The engine rejects a 402 whose amount, asset, network, or payout wallet differs from the Price Lock, records `price_mismatch` with both values, and pays nothing.
FR-27: Failure after payment. If an Agent times out or returns an invalid response after being paid, the Call is `failed_after_payment`, the Run stops (FR-29), and for `research` and `risk` the Call is scored as a failed Settlement immediately with no window.
FR-28: Live Run log. The engine records per Call: Node, Provider, status, amount, tx hash, request, response, and timestamps, and shows the Run live (under 2 seconds).
FR-29: Stop on failure, notify anyway. A failed Node stops the Run; later Nodes are not called or paid, except `notify`, which the engine calls with a failure summary; a failure in `notify` itself ends the Run.
FR-30: Repeatable Runs. A Builder can start a new Run of the same Workflow after the previous Run ends; two Runs of one Workflow cannot execute at the same time; a Run not ended after 120 seconds is `timed out`.
FR-31: Execution Agent. The `execution` Platform Agent places a market order on Binance Spot Testnet through the Platform Exchange Account for the given symbol, side, and size, returns the fill, and answers a schema-valid `REJECTED` for Emergency Stop, the global order ceiling, or an exchange rejection; the Run view offers "verify on Binance".
FR-32: Telegram Notifier. The Telegram Notifier sends the Run summary, cost table, tx hashes, and order (if any) to the recipient named in the input; the Builder sets their chat id in settings.
FR-33: Research rule. Settlement passes a `research` Call by comparing the signal with the price move over the Settlement Window in production mode, and with the 24-hour trend at window end in demo mode (window 60 min or 20 s per addendum §6).
FR-34: Risk rule. Settlement passes a `risk` Call whose decision was APPROVE or REDUCE if the position's drawdown inside the Settlement Window stayed within 2 percent; REJECT decisions are not scored.
FR-35: Slash and Refund. On a failed Settlement the platform slashes exactly the Call's locked price from the Agent's Stake and transfers it to the Builder's System Wallet in one on-chain transaction, with tx hashes shown; a Stake below the price is slashed whole and the Agent paused.
FR-36: Reputation. The platform recomputes Reputation after every Settlement as passed over the last 30 scored Calls and writes it to the Registry entry.
FR-37: Pause on exhausted Stake. Settlement triggers the FR-8 pause when Stake reaches zero.
FR-38: Unscored Types. `data`, `execution`, and `notify` Calls are paid but never scored.
FR-39: Run feed. A Builder can see their Runs with status, Nodes, total cost, and start time, updating live.
FR-40: Payments view. A Builder can see every payment they made: Run, Node, Provider, amount, from and to addresses, status, and tx hash with explorer link.
FR-41: Settlement view. A Builder can see every scored Call: rule applied, mode, prices used and their source, result, Slash tx hash, and Refund amount.
FR-42: Agent detail. Anyone signed in can open an Agent's page showing its identity, Stake, price history, Reputation history, scored-call count, and its verification Call.
FR-43: Demo split view. A Builder can open a Run in a split view: agent request/response log on the left, money flow on the right.
FR-44: Six Seed Agents. The platform ships with Binance Ticker (data, 0.01), Alpha Research (research, 0.05, LLM following the 24h trend), Sloppy Research (research, 0.03, contrarian, confidence 0.9), Guardrail Risk (risk, 0.02), Binance Spot Executor (execution, 0.01), and Telegram Notifier (notify, 0.005), behaving as PRD addendum §2 specifies.
FR-45: Operator controls. The Operator can set the Emergency Stop, switch demo mode, and reset an Account's Daily Fee Budget through a single admin page, effective within five seconds without a restart, with mode and Emergency Stop visible on the dashboard header.

### NonFunctional Requirements

NFR-1: Run latency. A five-node Run completes in 45 seconds in the demo, 60 seconds as the ceiling, with each payment settling within 10 seconds.
NFR-2: Demo reliability. Chain RPC errors are retried up to three times without re-signing; a paid request is resent once; two prepared wallet sets exist; `research-good` is scored on Runs before the demo; a recorded backup of the full demo exists.
NFR-3: Security and safety. Testnet only, no withdrawals; System Wallet keys encrypted at rest and never leave the server; exchange credentials only in the `execution` Agent; budgets, Order Cap, Emergency Stop, and Stake minimums enforced server-side; the signing service serialises transactions per wallet.
NFR-4: Trust. Custody and Settlement are platform-side and stated plainly; on-chain transfers, Stake, Slash, and Reputation are verifiable by anyone.
NFR-5: Observability. Every Call and every on-chain transaction is logged with tx hash; the Run log is the source of truth for the dashboard.
NFR-6: Compatibility. BSC testnet (chain id 97), the tUSD asset and self-hosted Facilitator per addendum §3, Binance Spot Testnet.
NFR-7: Openness. A Creator can implement an Agent from the public schema page and the HTTP contract alone, including Facilitator URL, network, asset, and EIP-712 domain.
NFR-8: Privacy. Store only email, password hash, wallet address, encrypted key, and Telegram chat id.
NFR-9: Cost. Agent fees are cents; gas is faucet BNB; the platform pre-funds demo wallets with testnet BNB and team-minted tUSD.
NFR-10: Time. Three build days for five people; any FR whose stage is not reached by the end of day two is cut explicitly.

### Additional Requirements

**Starter and scaffold (Epic 1, Story 1):** pnpm monorepo, Node 24.20, TypeScript throughout; `apps/web` from `create-next-app` (Next.js 16.3.4, React 19.2.8, App Router, Tailwind CSS 4) plus shadcn/ui; `packageManager` pinned to pnpm 11.25; `eslint no-restricted-imports` enforcing the AD-1 dependency direction; every process validates env with a Zod schema at boot; pino JSON logs with `run_id`, `call_id`, `tx_hash`.

**Shared contracts first (AD-14):** `packages/schemas` holds the five Type schemas, `samples`, `validateOutput`, the Price Lock, job payloads, API bodies and error codes, internal route shapes, `toBaseUnits`/`toDecimalUsdt` with branded types, the `x402Config`, and the typed `deployments/97.json` export. Every other package depends on it.

**Contracts and chain (AD-2, AD-6, AD-8):** Foundry 1.8.1; `TUSD.sol` = OpenZeppelin ERC20 + `ERC3009` (draft, v5.7.0 tag), domain `EIP712("tUSD", "1")`, open capped `mint`; `AgentDeskRegistry.sol` with `list`, `addStake`, `setPrice`, `setPaused`, `slash` (clamps, pays `to`, stake pause), `setReputation`, `getListing`, events `Listed`, `Staked`, `PriceSet`, `Paused`, `Slashed`, `ReputationSet`; `forge script` writes `deployments/97.json`; ABI JSON exported to `packages/adapters/chain/abi/`; ERC-8004 IdentityRegistry at `0x8004A818BFB912233c491871b3d84c89A494BD9e`, `agentId` decoded from the `Registered` event; Etherscan V2 verification; `RPC_URLS` with viem `fallback()` and three retries.

**Facilitator (AD-6):** `apps/facilitator` self-hosted on `@x402/core` + `@x402/evm` 2.25.0, `exact` scheme on `eip155:97`, tUSD asset with `extra { name, version }`, relayer key with viem `nonceManager`, `GET /health` reporting relayer balance and pending nonces.

**Agent runtime (AD-7):** `packages/agent-kit` `createAgent({ type, price, payTo, handler, internalRoutes? })` on Express 5.2.1 + `@x402/express`; `/health`, `/schema`, `/internal/*` with Bearer `INTERNAL_TOKEN`; input validation and `validateOutput`; 10 s handler budget; single-flight per `PAYMENT-SIGNATURE` with a five-minute replay cache. Agents are self-contained processes owning their vendor client (`@binance/spot` 32.0.3 with Ed25519 key, grammY 1.46.0 long polling, `@anthropic-ai/sdk` 0.124.0 with claude-sonnet-5).

**Persistence and jobs (AD-3, AD-4, AD-9):** PostgreSQL 18 with Drizzle 0.45.2; tables `accounts`, `wallets`, `workflows`, `workflow_nodes`, `listings`, `runs`, `calls` (fixed column set), `settlements` (unique `call_id`), `chain_tx` (unique `intent_key`), `platform_settings` (row 1 inserted by migration); partial unique index `runs(workflow_id) where status = 'running'`; pg-boss 12.30.0 queues `run.execute`, `wallet.create`, `listing.verify`, `listing.write` with `policy: 'exclusive'`, `settlement.tick` for targeted sends; the settlement loop runs in-process in the worker; Run status writes are compare-and-set; `run.execute` is resumable; a `migrate` compose service runs before web and worker.

**Signing (AD-5):** `core/signing` policy with per-wallet mutex and all budget, reservation, minimum, cap, and gas-floor checks inside the lock; `packages/adapters/signer` (viem + Node crypto, AES-256-GCM under `MASTER_KEY`) imported only by the worker and scripts; `signPayment` persists `calls.payment_payload` before sending; `wallet.create` runs `gas`, `mint` (demo), `approve` and sets `wallets.ready_at`.

**Runtime settings and routes (AD-10, conventions):** `platform_settings` holds mode, Emergency Stop, `order_ceiling_usdt`, default budget, `verification_cap_daily`, `platform_account_id`, `worker_seen_at`; mode constants (window, poll, rule, klines, budgets) in `packages/core`; route families public / session / operator / internal as the spine's Routes convention lists; `GET /api/settings/public`; `GET /api/health`; iron-session 9.0.1 + bcrypt auth with `is_operator`.

**Exchange (AD-11):** `spot-executor` owns the exchange client; `GET /internal/balance` and `GET /internal/orders/<order_id>?symbol=`; Spot Demo Mode fallback needs `EXCHANGE_DEMO_API_KEY` / private key and `EXCHANGE_BASE_URL=https://demo-api.binance.com`; minimum notional 5 USDT for BNBUSDT enforced by the engine before paying.

**Deployment and operations (Structural Seed):** docker compose on the demo laptop (`postgres:18-alpine`, `migrate`, web :3000, worker, facilitator :4020, agents :4101–4107 with the :4107 second Sloppy Research paid to the demo Creator wallet), `restart: unless-stopped`, one `.env` per service from `.env.example`; `scripts/seed` (accounts, spare pair, demo budgets, seed listings with `skip_verification` for `execution`, `.env.seed`, `--warm`, `--activate-spare`, `--reset`, `--rehost`) and `scripts/doctor` (gas floors, facilitator and RPC health, relayer nonces, worker heartbeat, exchange balance, `PUBLIC_BASE_URL`); keys and `deployments/97.json` in the team password manager; named Cloudflare tunnel only for a stable `agentURI` host, else `data:` URI.

**Day-1 checks before other work (spine Open Questions):** `ERC3009` from the OZ v5.7.0 tag compiles under Foundry with the `(v, r, s)` overload; the x402 facilitator example runs on `eip155:97` with the Solana signer removed; team domain on Cloudflare DNS or the `data:` URI path; faucet address holds 0.002 mainnet BNB.

**Explicitly out of scope (spine Deferred):** platform fee collection, external wallets and withdrawals, stake withdrawal, event indexing, B402 facilitator switch, sub-accounts, DAG workflows, ERC-8004 ReputationRegistry writes, worker scaling, Telegram deep links, rate limiting.

### UX Design Requirements

No UX design document exists. The PRD fixes the pages (marketplace, listing form, workflow builder with `@xyflow/react` 12.11.6, run view, split view, payments, settlement, agent detail, operator page) and the spine fixes polling and the UI library; visual design is owned by the code.

### FR Coverage Map

### FR Coverage Map

FR-1: Epic 2 (sign-in session for seeded accounts, operator guard) → Epic 3 (sign-up, sign-out UI, signed-out redirects)
FR-2: Epic 3 - System Wallet created and funded per Account
FR-3: Epic 1 (constant budget, hard-coded wallet) → Epic 3 (Builder-settable per Account, reserve and release)
FR-4: Epic 2 - Order Cap per Workflow, enforced by the engine before paying execution
FR-5: Epic 1 - ERC-8004 identity registration (seed path) → reused by the Epic 3 listing pipeline
FR-6: Epic 1 - Registry entry written by `listing.write` (seed path) → reused by Epic 3
FR-7: Epic 1 - Stake lock at listing (seed path); top-up UI in Epic 3
FR-8: Epic 4 - Automatic pause at zero Stake and resume on top-up
FR-9: Epic 3 - Creator changes price; Runs in progress keep their Price Lock
FR-10: Epic 3 - Listing form
FR-11: Epic 3 - Paid schema verification Call from the Platform Wallet, no Stake locked on failure
FR-12: Epic 3 - Listing live within 30 seconds, no approval step
FR-13: Epic 3 - Marketplace browse, filter, sort, cards
FR-14: Epic 3 - Execution Type restricted to the Platform Account
FR-15: Epic 1 - Five Type schemas in `packages/schemas` and the public schema page
FR-16: Epic 1 - Agent HTTP contract via `agent-kit` (402, verify, settle, 200 with receipt)
FR-17: Epic 2 - Type compatibility rules
FR-18: Epic 2 - Create a Workflow (name, symbol, Order Cap, ordered Nodes)
FR-19: Epic 2 - Chain validation in the builder against FR-17 and paused Listings
FR-20: Epic 2 - Maximum-cost preview against remaining budget
FR-21: Epic 2 - Swap one Node's Provider
FR-22: Epic 2 - Save, list, and run Workflows
FR-23: Epic 1 - Price Lock snapshot, budget and balance refusal before any Call
FR-24: Epic 2 - Sequential execution, schema mapping, HOLD and REJECT skips
FR-25: Epic 1 (x402 Handshake, retry once, receipt validation) → Epic 4 (Stake reservation refusal)
FR-26: Epic 1 - Price Lock mismatch rejected, `price_mismatch` recorded, nothing paid
FR-27: Epic 4 - Failure after payment stops the Run and is scored failed immediately
FR-28: Epic 1 - Live Run log per Call, visible under 2 s
FR-29: Epic 2 - Stop on failure, still call notify with a failure summary
FR-30: Epic 2 - Repeatable Runs, one running Run per Workflow, 120 s timeout
FR-31: Epic 2 - Binance Spot Executor with REJECTED for Emergency Stop, ceiling, exchange errors
FR-32: Epic 2 - Telegram Notifier and Builder chat id setting
FR-33: Epic 4 - Research rule (production window vs demo 24 h trend)
FR-34: Epic 4 - Risk rule (2 percent drawdown inside the window)
FR-35: Epic 4 - Slash and Refund in one transaction, whole-Stake slash and pause
FR-36: Epic 4 - Reputation over the last 30 scored Calls written to the Registry
FR-37: Epic 4 - Settlement triggers the FR-8 pause
FR-38: Epic 4 - data, execution, notify never scored
FR-39: Epic 5 - Run feed
FR-40: Epic 5 - Payments view with explorer links
FR-41: Epic 5 - Settlement view
FR-42: Epic 5 - Agent detail page
FR-43: Epic 5 - Demo split view
FR-44: Epic 1 (Binance Ticker) → Epic 2 (Alpha Research, Sloppy Research, Guardrail Risk, Binance Spot Executor, Telegram Notifier)
FR-45: Epic 2 - Operator page: Emergency Stop, mode switch, budget reset, header badge

## Epic List

Epics follow the PRD §6 build order one to one. The day-1 setup the spine names (monorepo scaffold, shared schemas, contracts, facilitator, database and migrations, compose, seed, doctor) is not a separate epic: it is the first stories of Epic 1, because Stage 1 cannot deliver its outcome without them and none of it has user value on its own. Cut from the bottom.

### Epic 1: Paid Agent Call Spine
A Registry entry for one Agent exists on BSC testnet, one Seed Agent answers HTTP 402, and the engine pays it through the self-hosted Facilitator from a hard-coded Builder wallet, validates the result, and records the Call with its tx hash. Everything runs from `docker compose up` on the demo laptop. Day 1 target; the one epic every other epic depends on.
**FRs covered:** FR-3 (constant budget on a hard-coded wallet), FR-5, FR-6, FR-7, FR-15, FR-16, FR-23, FR-25 (without the Stake reservation check), FR-26, FR-28, FR-44 (Binance Ticker only)
**NFRs addressed:** NFR-2 (RPC retries, resend once), NFR-3 (signer isolation, MASTER_KEY), NFR-5 (Call and tx logging), NFR-6, NFR-7 (schema page), NFR-9 (faucet BNB, team-minted tUSD)
**Implementation notes:** AD-1, AD-3, AD-5, AD-6, AD-7, AD-8, AD-13, AD-14 land here. Stories: scaffold and schemas; contracts and deploy; facilitator; database, migrations, compose; agent-kit and Binance Ticker; signing and chain adapters; engine pays one Node; seed and doctor.

### Epic 2: Five-Node Run to a Binance Order and a Telegram Message
A Builder composes a data → research → risk → execution → notify Workflow in the builder, starts a Run, and watches the engine pay each Node in order, skip on HOLD or REJECT, place a Binance Spot Testnet market order through the platform-operated executor, and deliver the summary to Telegram. The Operator can stop trading and switch mode without a restart. Still a single hard-coded Builder wallet. Day 2 target.
**FRs covered:** FR-1 (sign-in session only, so Workflows and operator routes have an owner), FR-4, FR-17, FR-18, FR-19, FR-20, FR-21, FR-22, FR-24, FR-29, FR-30, FR-31, FR-32, FR-44 (Alpha Research, Sloppy Research, Guardrail Risk, Binance Spot Executor, Telegram Notifier), FR-45
**NFRs addressed:** NFR-1 (45 s demo Run), NFR-2 (two wallet sets prepared by seed)
**Implementation notes:** AD-4 (run state machine, sweep), AD-9 constants, AD-10 (platform_settings, operator routes), AD-11 (exchange only in spot-executor), AD-12 (2 s polling). Touches `apps/web` builder and run pages, `apps/worker` engine, five agent apps.

### Epic 3: Self-Service Accounts, Wallets, and Agent Listing
A stranger signs up, receives a funded System Wallet, sets a Daily Fee Budget and Telegram chat id, and lists a new Agent with no approval in under 30 seconds: the platform verifies the endpoint with one paid Call, registers the ERC-8004 identity, locks Stake and writes the Registry entry in one transaction, and the card appears on the marketplace. Builders browse and compare Listings, and Runs now use the signed-in Account's wallet and budget. Day 2 target, in parallel with Epic 2 (different files).
**FRs covered:** FR-1 (sign-up, sign-out, redirects), FR-2, FR-3 (Builder-settable per Account, reservation and release), FR-9, FR-10, FR-11, FR-12, FR-13, FR-14
**NFRs addressed:** NFR-3 (keys encrypted at rest, server-side enforcement), NFR-8 (privacy: only the five stored fields)
**Implementation notes:** AD-2 (listing pipeline verify → register → list, `refreshListingFromChain()`, agentURI), AD-5 (`wallet.create` gas → mint → approve), `listing.verify` and `listing.write` jobs, session routes, `is_operator`, `platform_account_id`. Replaces the hard-coded wallet from Epics 1 and 2 with the Account's wallet.

### Epic 4: Settlement, Slash, Refund, and Reputation
After a Run, the platform scores every research and risk Call against the market, slashes exactly the locked price from a wrong Agent's Stake and refunds the Builder in one on-chain transaction, recomputes Reputation over the last 30 scored Calls and writes it to the Registry, pauses an Agent whose Stake is exhausted, and refuses to pay an Agent whose unreserved Stake cannot cover a Call. Day 3 target.
**FRs covered:** FR-8, FR-25 (Stake reservation check), FR-27, FR-33, FR-34, FR-35, FR-36, FR-37, FR-38
**NFRs addressed:** NFR-2 (research-good pre-scored before the demo), NFR-4 (Slash and Reputation verifiable on-chain)
**Implementation notes:** AD-9 (in-process settlement loop, one settlements row per research/risk Call, rule_label, p_fill from the execution Call, single-tx slash, reputation formula), AD-8 intent keys `slash:` `reputation:` `pause:`, `settlement.tick`, `failed_after_payment` immediate scoring.

### Epic 5: Dashboard and Demo Views
A Builder sees every Run, payment, and scored Call with tx hashes and explorer links, opens any Agent's page with its identity, Stake, price and Reputation history and its verification Call, and opens a Run in the demo split view with the agent log on the left and the money flow on the right. Day 3 target; the first epic to cut if time runs short, since Epics 1–4 already expose their data through the run view and API.
**FRs covered:** FR-39, FR-40, FR-41, FR-42, FR-43
**NFRs addressed:** NFR-4 (custody and Settlement stated plainly), NFR-5 (Run log is the dashboard source of truth)
**Implementation notes:** Read-only pages over the `calls`, `settlements`, `chain_tx`, and `listings` tables, 2 s polling (AD-12), `@xyflow/react` only in the builder. No new writers.

### Dependencies and parallel plan
- Epic 1 blocks everything; the whole team converges on it on day 1.
- Epics 2 and 3 run in parallel on day 2: Epic 2 owns the engine, agents, builder and run pages, operator page; Epic 3 owns auth, wallets, listing pipeline, marketplace. Their only shared surface is `packages/schemas`, which Epic 1 fixes first. Story 2.1 (session) lands first thing on day 2 because Epic 3 builds on it; Story 3.7 needs the :4107 instance from Story 2.3.
- Epic 4 needs Epic 2 (execution reference price) and Epic 3 (per-Account refund wallet). Epic 5 needs the tables from Epics 1–4 but its first three views can start after Epic 2.
- NFR-10: any story whose epic has not started by the end of day two is cut explicitly and logged.

## Epic 1: Paid Agent Call Spine

A Registry entry for one Agent exists on BSC testnet, one Seed Agent answers HTTP 402, and the engine pays it through the self-hosted Facilitator from a hard-coded Builder wallet, validates the result, and records the Call with its tx hash. Everything runs from `docker compose up` on the demo laptop. Day 1 target; every other epic depends on it.

Story order is the build order. Stories 1.2, 1.3, 1.4, and 1.5 can run in parallel once 1.1 has landed; 1.6 → 1.7 → 1.8 are sequential; 1.9 runs beside 1.8; 1.10 closes the day.

### Story 1.1: Monorepo Scaffold and Shared Contracts Package

As a team member,
I want one pnpm monorepo with the shared `packages/schemas` contract and the dependency rules in place,
So that five people can build packages in parallel on day 1 without inventing payloads, units, or import paths.

**Covers:** FR-15 (schemas), NFR-10 · AD-1, AD-13, AD-14

**Acceptance Criteria:**

**Given** a clean clone on Node 24.20
**When** a developer runs `pnpm install && pnpm lint && pnpm typecheck && pnpm test`
**Then** all four succeed, `packageManager` in the root `package.json` pins pnpm 11.25, and the workspace contains `apps/web` (created with `create-next-app`: Next.js 16.3.4, React 19.2.8, App Router, TypeScript, Tailwind CSS 4, shadcn/ui initialised), `apps/worker`, `apps/facilitator`, `apps/agents/binance-ticker`, `packages/schemas`, `packages/agent-kit`, `packages/core`, `packages/db`, `packages/adapters`, `scripts`, and `contracts` as package skeletons with the tree of the spine's Structural Seed
**And** every package has an `eslint no-restricted-imports` rule that enforces the AD-1 table (agents import only `schemas`, `agent-kit`, and their vendor SDK; `core` imports only `schemas`; `adapters/signer` is importable only from `apps/worker` and `scripts`; nothing imports from `apps/*`), and a deliberate violation fails `pnpm lint`

**Given** `packages/schemas`
**When** it is built
**Then** it exports, as Zod 4 objects, the five Type input and output schemas exactly as PRD addendum §1 defines them, `samples[type]` for each Type, `validateOutput(type, input, output)` with the cross-field rules (research `confidence` in [0, 1] and `reason` non-empty ≤ 500 chars; risk `size_usdt` ≤ `proposed_size_usdt` and ≤ `balance_usdt`, `"0"` on `REJECT`; execution `order_id`, `filled_price`, `filled_qty` required on `FILLED` and `reason` on `REJECTED`; notify `recipient.channel = 'telegram'`, `cost_table[].tx_hash` optional), the `PriceLock` schema, `jobs/` payloads for `run.execute`, `wallet.create`, `listing.verify`, `listing.write`, `settlement.tick`, `api/` request and response bodies with the error envelope and the fixed codes of AD-14 in `api/errors.ts`, `internal/` shapes `InternalBalance`, `InternalOrder`, `InternalSettings`, `toBaseUnits` and `toDecimalUsdt` over `TUSD_DECIMALS = 6` with branded `BaseUnits` and `UsdtDecimal` types, `buildX402Config({ facilitatorUrl })` returning `{ network: 'eip155:97', asset, extra: { name, version }, facilitatorUrl }`, and `deployments.ts` that parses `deployments/97.json` at build time
**And** unit tests prove: unknown response fields are ignored, missing required fields fail, each cross-field rule fails on a counter-example, `toBaseUnits("0.01")` is `10000n`, and `toDecimalUsdt(10000n)` is `"0.01"`
**And** `deployments/97.json` is committed with `chainId: 97`, the ERC-8004 `identityRegistry` address `0x8004A818BFB912233c491871b3d84c89A494BD9e`, and placeholder `tusd` and `registry` entries that Story 1.2 overwrites

**Given** any app in the workspace
**When** it starts
**Then** it validates its env with a Zod schema and exits non-zero with the failing keys named when a required variable is missing, and it logs with pino JSON including `run_id`, `call_id`, and `tx_hash` fields where known
**And** `.env.example` at the root lists every variable per service with a one-line comment, including `MASTER_KEY`, `PLATFORM_WALLET_KEY`, `RPC_URLS`, `FACILITATOR_URL`, `INTERNAL_TOKEN`, `PUBLIC_BASE_URL`, `EXPLORER_URL`, `CHAIN_ID`, and the three BNB floor variables

### Story 1.2: tUSD and AgentDeskRegistry Deployed on BSC Testnet

As a Creator,
I want a payment token and a Registry contract live on BSC testnet,
So that Stake, price, reputation, and every x402 payment have a verifiable on-chain home.

**Covers:** FR-6, FR-7 (contract side), NFR-4, NFR-6 · AD-2, AD-6, AD-8

**Acceptance Criteria:**

**Given** the `contracts/` Foundry 1.8.1 project with openzeppelin-contracts installed at the `v5.7.0` tag
**When** `forge build` runs
**Then** `TUSD.sol` compiles as `ERC20` plus `ERC3009` from `draft-ERC3009.sol` with domain `EIP712("tUSD", "1")`, 6 decimals, `authorizationState(address, bytes32)`, the `transferWithAuthorization` `(v, r, s)` overload, and an open `mint(to, amount)` capped at 1,000 tUSD per call
**And** `AgentDeskRegistry.sol` compiles with `list(agentId, agentType, price, endpoint, payTo, stakeAmount)`, `addStake`, `setPrice`, `setPaused` (creator only), `slash(listingId, callRef, amount, to)` and `setReputation(listingId, bps)` (platform address only), `getListing`, and events `Listed`, `Staked`, `PriceSet`, `Paused`, `Slashed(listingId, callRef, amount)`, `ReputationSet`, with every amount in tUSD pulled by `transferFrom`
**And** `ERC20TransferAuthorization` is not used anywhere (its keyed nonces revert on x402's random nonces)

**Given** `forge test`
**When** it runs
**Then** tests pass for: `list` reverts when stake < 10 × price; `setPrice` reverts when stake would fall below 10 × new price; `addStake` clears the stake pause once stake ≥ 10 × price; `slash` clamps to the remaining stake, transfers tUSD to `to`, emits `Slashed` with the clamped amount, and sets the stake pause when stake reaches zero; `setReputation` and `slash` revert for a non-platform caller; `setPaused` reverts for a non-creator; `TUSD.eip712Domain()` returns name `tUSD` and version `1`; a `transferWithAuthorization` with a random 32-byte nonce succeeds once and reverts on replay

**Given** the Platform Wallet key funded from the BSC testnet faucet (the faucet address holds the 0.002 mainnet BNB it requires)
**When** `forge script script/Deploy.s.sol --rpc-url <RPC_URLS[0]> --broadcast --verify` runs
**Then** both contracts are deployed with the Platform Wallet as the registry's platform address, verified on `testnet.bscscan.com` through Etherscan V2, and `deployments/97.json` is overwritten with `tusd: { address, name: "tUSD", version: "1", decimals: 6 }`, `registry: { address }`, `identityRegistry`, and the deploy block numbers
**And** `pnpm --filter contracts build` exports the ABI JSON of `AgentDeskRegistry`, `TUSD`, and the ERC-8004 `IdentityRegistry` into `packages/adapters/chain/abi/`
**And** the deploy key, `deployments/97.json`, and the addresses are stored in the team password manager

### Story 1.3: Self-Hosted x402 Facilitator on eip155:97

As a Creator,
I want a Facilitator that verifies and settles tUSD payment authorisations on BSC testnet,
So that my Agent can be paid by the engine with the same x402 v2 rail the schema page publishes.

**Covers:** FR-16 (facilitator side), NFR-6, NFR-7 · AD-6

**Acceptance Criteria:**

**Given** `apps/facilitator` built on `@x402/core` and `@x402/evm` 2.25.0 with the Solana signer removed and `bscTestnet` plus `eip155:97` registered
**When** it starts with `FACILITATOR_RELAYER_KEY`, `RPC_URLS`, and `CHAIN_ID`
**Then** it registers the `exact` scheme on `eip155:97` for the tUSD asset from `buildX402Config`, including `extra { name, version }`, and `GET /supported` lists exactly that network, scheme, and asset
**And** the relayer sends through viem with `nonceManager` and `fallback()` over `RPC_URLS`, and the relayer key lives only in this app's env

**Given** a payment authorisation signed by a viem test account holding minted tUSD for a 402 built by `buildX402Config`
**When** `POST /verify` and then `POST /settle` are called with the x402 v2 bodies
**Then** `verify` answers valid, `settle` broadcasts `transferWithAuthorization`, and the response carries a tx hash that is confirmed on BSC testnet with the exact amount moved from payer to `payTo`
**And** a second `settle` of the same authorisation answers an error and sends no transaction
**And** an authorisation whose `extra` is missing or whose asset differs from the config is rejected by `verify`

**Given** the facilitator is running
**When** `GET /health` is called
**Then** it answers 200 with the relayer address, relayer BNB balance, and pending nonce count, and answers 503 when the RPC is unreachable
**And** a Dockerfile and a `facilitator` service on port 4020 exist for compose

### Story 1.4: Database Schema, Migrations, and Compose Base

As a team member,
I want the Postgres schema, Drizzle migrations, pg-boss queues, and the compose base landed once,
So that every later story adds only columns and services by PR instead of redesigning shared tables.

**Covers:** FR-28 (Call and Run enums), NFR-3, NFR-5 · AD-3, AD-4, AD-8, AD-9, AD-10, conventions

**Acceptance Criteria:**

**Given** `packages/db` with Drizzle ORM 0.45.2 and drizzle-kit 0.31.10
**When** `pnpm --filter db generate` and the `migrate` compose service run against `postgres:18-alpine`
**Then** the tables `accounts` (with `email`, `password_hash`, `is_operator`, `telegram_chat_id`, `daily_fee_budget` nullable, `budget_window_start`), `wallets` (`account_id`, `address` lower-case, `encrypted_key`, `ready_at`), `workflows`, `workflow_nodes`, `listings` (form-owned columns, chain-owned columns, `status`, `last_error`, `skip_verification`), `runs` (`status`, `price_lock`, `failure_reason`, `created_at`, `started_at`, `ended_at`), `calls` with exactly the AD-3 column set, `settlements` (unique index on `call_id`), `chain_tx` (`intent_key` unique, `payload`, `status`, `tx_hash`, `confirmed_at`), and `platform_settings` exist with ULID-prefixed text ids, snake_case names, amounts as base-unit integer strings, and ISO timestamps
**And** the partial unique index `runs(workflow_id) where status = 'running'` exists
**And** the migration inserts `platform_settings` row `id = 1` with `mode = 'production'`, `emergency_stop = false`, `order_ceiling_usdt = '1000'`, `default_daily_fee_budget` = 1 tUSD in base units, `verification_cap_daily` = 5 tUSD in base units, `platform_account_id = null`, `worker_seen_at = null`
**And** running the migration twice is a no-op

**Given** `packages/db` repositories
**When** code inserts a Run or Call
**Then** the status columns accept only the PRD enums (Call: `pending`, `price_mismatch`, `payment_failed`, `paid_awaiting_result`, `succeeded`, `failed_after_payment`, `skipped`; Run: `running`, `completed`, `completed, no order`, `failed at <Node>`, `timed out`) through TypeScript union types, and the chain-owned listing columns are marked in the schema as written only by `refreshListingFromChain` (delivered in Story 1.6)
**And** the spend, reservation, and verification-spend queries of AD-3 exist as repository functions with unit tests over fixture rows

**Given** `docker-compose.yml` and `.env.example`
**When** `docker compose up postgres migrate facilitator` runs
**Then** `migrate` runs `drizzle-kit migrate` once and exits 0, `facilitator` starts only after it, every service uses `restart: unless-stopped` and one `.env` file, and the pg-boss queues `run.execute`, `wallet.create`, `listing.verify`, `listing.write` are created with `policy: 'exclusive'` and `settlement.tick` as a plain queue by a shared `createQueues()` in `packages/db`

### Story 1.5: agent-kit and the Binance Ticker Agent

As a Creator,
I want a one-call `createAgent()` runtime and a working `data` Agent built on it,
So that any Agent answers 402, verifies and settles through the Facilitator, and returns a schema-valid output with a receipt.

**Covers:** FR-15, FR-16, FR-44 (Binance Ticker), NFR-7 · AD-6, AD-7, AD-13, AD-14

**Acceptance Criteria:**

**Given** `packages/agent-kit` on Express 5.2.1 and `@x402/express` 2.25.0
**When** `createAgent({ type, price, payTo, handler, internalRoutes? })` is called
**Then** it mounts `POST /` behind the x402 middleware, `GET /health`, `GET /schema` (the Type's input and output JSON schema), and `internalRoutes` under `/internal/*` guarded by `Authorization: Bearer INTERNAL_TOKEN` (401 otherwise); `price` is a decimal USDT string converted with `toBaseUnits` into an explicit `AssetAmount` with `extra { name, version }` from `buildX402Config`
**And** the middleware verifies the `PAYMENT-SIGNATURE` through `FACILITATOR_URL`, validates the request body against the Type input schema (400 on failure), runs the handler under a 10 s budget (500 on expiry), calls `validateOutput` (500 on an invalid output, never 200), then settles and answers 200 with the output and the `PAYMENT-RESPONSE` header; a handler error returns 5xx and is never settled
**And** it is single-flight per `PAYMENT-SIGNATURE`: a concurrent duplicate awaits the in-flight attempt, the handler output is cached for five minutes even when `settle` fails, and a retry re-attempts `settle` with the cached output instead of re-running the handler, proven by a unit test that counts handler invocations

**Given** `apps/agents/binance-ticker` with `AGENT_PRICE=0.01`, `AGENT_PAYTO`, `FACILITATOR_URL`, `INTERNAL_TOKEN`
**When** an unpaid `POST /` with `{ "symbol": "BNBUSDT" }` arrives
**Then** it answers 402 with a `PAYMENT-REQUIRED` header whose single `accepts` entry has `scheme: 'exact'`, `network: 'eip155:97'`, the tUSD address, `amount: '10000'`, `payTo` = `AGENT_PAYTO`, `maxTimeoutSeconds ≤ 15`, and `extra { name: 'tUSD', version: '1' }`

**Given** a paid request signed by a viem test account holding minted tUSD (test script using `@x402/fetch`)
**When** it arrives within 15 s
**Then** the handler fetches the 24 h ticker for the symbol from `https://data-api.binance.vision`, answers `{ symbol, price, change_24h_pct, volatility_24h_pct, ts }` with `volatility_24h_pct = (high − low) / low × 100`, and the `PAYMENT-RESPONSE` header carries a tx hash confirmed on BSC testnet
**And** an unknown symbol or a market-data timeout over 8 s returns 500 and no settlement
**And** a Dockerfile and an `agent-binance-ticker` compose service on port 4101 exist, and `GET /health` answers 200

### Story 1.6: Signer, Signing Policy, Chain Writes, and Wallet Creation

As an Operator,
I want every key held encrypted in one worker-only signer behind a policy layer, with idempotent chain writes and a wallet-creation job,
So that no payment or transaction is ever signed twice, from the wrong process, or outside the budget and stake rules.

**Covers:** FR-2 (wallet creation job), FR-3 (constant budget), FR-23 (checks inside the lock), NFR-2, NFR-3 · AD-1, AD-5, AD-8, AD-13

**Acceptance Criteria:**

**Given** `packages/adapters/signer`
**When** the worker wires it
**Then** it implements the `Signer` port from `core/ports` (`generateKey`, `decryptKey`, `signTypedData`, `sendRawTx`) over viem 2.56.3 and Node crypto with AES-256-GCM under `MASTER_KEY`, `MASTER_KEY` appears only in the worker env schema and compose service, and a unit test proves a key round-trips and a wrong `MASTER_KEY` fails to decrypt
**And** `apps/web` cannot import `packages/adapters/signer` (lint fails)

**Given** `packages/core/signing`
**When** `signPayment(walletId, requirements)` or `sendTx(walletId, intent)` is called
**Then** each wallet has one async mutex; inside the lock the policy runs the Daily Fee Budget check (spend query of AD-3 against `accounts.daily_fee_budget` or `platform_settings.default_daily_fee_budget`), the FR-25 stake reservation check (research and risk only), the Creator ten-times minimum, the Platform Wallet verification cap, and the Creator gas floor, and refuses with `refused_budget` or `refused_stake` before signing
**And** `signPayment` writes `calls.payment_payload` (`nonce`, `validBefore`, `from`, `to`, `value`) and moves the Call to `paid_awaiting_result` in the same database transaction before returning the header, so a retry finds the stored header and never re-signs; a unit test proves two concurrent `signPayment` calls on one wallet serialise

**Given** `packages/adapters/chain`
**When** `chainWrite(intentKey, buildTx)` is called
**Then** it inserts a `chain_tx` row with `status = 'pending'` and the payload before sending, sends through viem `fallback()` over `RPC_URLS` with three retries, awaits the receipt up to 60 s, and sets `confirmed`, `reverted`, or `failed` with `tx_hash` and `confirmed_at`; a second call with the same `intentKey` re-checks the receipt and sends nothing; a `reverted` or `failed` listing intent writes `listings.last_error`; every `confirmed` receipt whose intent names a listing calls `refreshListingFromChain`
**And** `refreshListingFromChain(listingId)` reads `getListing` and writes `price`, `stake`, `reputation_bps`, `paused_by_creator`, `paused_by_stake`, `payout_wallet`, `endpoint`, `agent_id`, `registry_listing_id`, and a unit test with a mocked chain proves the mapping
**And** `MarketData` (`lastPrice`, `ticker24h`, `klines`) is defined in `core/ports` and `packages/adapters/market-data` implements it over `data-api.binance.vision`

**Given** the pg-boss job `wallet.create { account_id }` with singleton key `account_id`
**When** it runs
**Then** it generates and stores an encrypted key, inserts the `wallets` row, runs `gas:<wallet_id>` (BNB from the Platform Wallet up to `WALLET_GAS_FLOOR`), `mint:<wallet_id>` (tUSD `mint`, demo mode only), then `approve:<wallet_id>` (`tUSD.approve(registry, max)` signed by the new wallet), each through `chainWrite`, and sets `wallets.ready_at` from the approve receipt
**And** a retried job after a crash resumes at the first unconfirmed intent without a second gas or mint transaction
**And** an `importPlatformWallet()` helper in `scripts/` imports the Platform Wallet once from `PLATFORM_WALLET_KEY` as an ordinary `wallets` row of the Platform Account (which it creates when absent, setting `platform_settings.platform_account_id`); nothing else reads that variable, and the helper is idempotent

### Story 1.7: Seed Listing Pipeline Puts Binance Ticker on Chain

As a Creator,
I want a listing to gain an ERC-8004 identity, a Registry entry, and a locked Stake through one worker pipeline,
So that the Agent is discoverable on-chain and can be paid at a locked price.

**Covers:** FR-5, FR-6, FR-7, FR-12 (order of steps) · AD-2, AD-5, AD-8

**Acceptance Criteria:**

**Given** a `listings` row in `status = 'verifying'` for Binance Ticker (`type = 'data'`, `declared_price = 10000`, `declared_stake ≥ 100000`, `payout_wallet`, `creator_account_id` = the Platform Account, `skip_verification = true`)
**When** the worker runs `listing.verify { listing_id }` (singleton key `listing_id`)
**Then** it skips the verification Call only when `skip_verification` is true (accepted only from the seed script; Story 3.4 adds the real Call), then runs `identity:<listing_id>` = `IdentityRegistry.register(agentURI)` signed by the Creator wallet, decodes `agentId` from the `Registered` event in the receipt, then runs `list:<listing_id>` = `AgentDeskRegistry.list(agentId, type, price, endpoint, payTo, stake)` signed by the Creator wallet, and after the confirmed receipt `refreshListingFromChain` fills the chain-owned columns and sets `status = 'active'`
**And** `agentURI` is `PUBLIC_BASE_URL/api/listings/<id>/agent.json` when `PUBLIC_BASE_URL` is set, otherwise a `data:application/json;base64,` URI carrying the same JSON, decided once per listing
**And** a `list` revert (stake below ten times price or insufficient tUSD) sets `status = 'failed'` with `last_error` naming the revert reason, and no identity is minted before a step that can still fail verification

**Given** the listing is `active`
**When** `GET /api/listings/<id>/agent.json` is requested signed-out
**Then** it returns the agent card (name, type, endpoint, `agentId`, registry listing id, payout wallet, schema page URL)
**And** `GET /api/listings` returns `{ items, next }` with only `active` and `paused` listings, amounts as base-unit strings, addresses lower-case
**And** the marketplace card data (price, stake, reputation `no score yet` or `not scored in MVP`, owner, status) matches `getListing` on chain after the write

### Story 1.8: Engine Pays One Node with Price Lock and Receipt

As a Builder,
I want to start a Run of a one-node Workflow and have the engine pay the Agent through x402 and record the result,
So that a paid Agent Call is proven end to end on testnet with the tx hash on the Call.

**Covers:** FR-3 (constant budget), FR-23, FR-25 (x402 Handshake, retry once), FR-26, FR-28 (log) · AD-3, AD-4, AD-5, AD-6, AD-13, AD-14

**Acceptance Criteria:**

**Given** a Workflow with one `data` Node bound to the active Binance Ticker listing, owned by an account whose wallet has `ready_at` set and holds tUSD
**When** `POST /api/runs { workflow_id }` is called
**Then** in one transaction with `SELECT ... FOR UPDATE` on the account row it builds the Price Lock from `active` listings (per Node: `listing_id`, `price`, `asset`, `network`, `pay_to`), checks Price Lock total ≤ remaining Daily Fee Budget and ≤ the wallet's tUSD balance, and inserts the Run in `running` with the Price Lock and one `pending` Call per Node (`kind = 'run'`, `node_index`, `node_type`, `locked_*`), then publishes `run.execute { run_id }` with singleton key `workflow_id`
**And** it answers 409 `refused_budget` (with the shortfall), `refused_balance`, `wallet_not_ready`, or `run_in_progress` without inserting anything; a paused listing in the chain is refused with `validation_failed`

**Given** the worker picks up `run.execute`
**When** it executes the `data` Node
**Then** it sets `runs.started_at`, sends the unpaid `POST` (15 s timeout), stores the 402 payload in `calls.payment_required`, selects the first `accepts` entry whose `scheme`, `network` (exact string), and `asset` (`isAddressEqual`) match the lock, compares `payTo` with `isAddressEqual` and `amount` as `bigint`, refuses a `maxTimeoutSeconds` above 15, and on any difference marks the Call `price_mismatch` with both values in `failure_reason`, pays nothing, and ends the Run `failed at data`
**And** on a match it calls `signPayment` (Story 1.6), sends the paid request with the stored header (15 s timeout), resends once with the same header on timeout, and on 200 runs `validateOutput`, stores `response`, `payment_tx_hash` from `PAYMENT-RESPONSE`, `attempt`, `ended_at`, and `reference_price` and `reference_at` from `MarketData.lastPrice` within five seconds (null on failure), marks the Call `succeeded`, and ends the Run `completed` (no `execution` Node)
**And** a 200 whose output fails validation marks the Call `failed_after_payment` and ends the Run `failed at data`; when both paid attempts end without a `PAYMENT-RESPONSE` the engine reads `tUSD.authorizationState(from, nonce)` and records `payment_failed` (unused) or `failed_after_payment` with null hash (used)

**Given** the Run state machine in `core/run/machine.ts`
**When** any Run or Call status is written
**Then** only the PRD enums are accepted, every Run status write is a compare-and-set from `running` (zero rows updated makes the engine record the in-flight Call and exit), and a `run.execute` re-delivered after a crash resumes from the first non-terminal Call, resending a `paid_awaiting_result` Call with `attempt < 2` using the stored header
**And** the engine checks `started_at + 120 s` before each Node and each paid retry and ends the Run `timed out` when exceeded, marking still-`pending` Calls `skipped` with `skip_reason = 'not_reached'`
**And** `GET /api/runs/<id>` returns the Run with its Price Lock and every Call (Node, listing name as Provider, status, `locked_price`, `payment_tx_hash`, request, response, timestamps) as one JSON body

### Story 1.9: Live Run View and Public Schema Page

As a Builder,
I want to watch a Run update live and read the public schema page,
So that I can see the payment land with its tx hash, and a Creator can build an Agent from the page alone.

**Covers:** FR-15 (publication), FR-28 (live view), NFR-5, NFR-7 · AD-12, AD-13, AD-14

**Acceptance Criteria:**

**Given** a Run in progress
**When** the Builder opens `/runs/<id>`
**Then** the page renders the Price Lock (per Node: Provider, locked price as decimal tUSD, pay-to) and a row per Call with Node, Provider, status, amount, tx hash linked through `explorerLink()` to `EXPLORER_URL`, request and response JSON, started and ended timestamps, and the Run status and failure reason
**And** React Query refetches `GET /api/runs/<id>` every 2 s while the Run is `running` and stops afterwards, so every status change shows within two seconds without a reload
**And** amounts are rendered as decimals labelled `tUSD` from base-unit strings, and addresses and hashes are rendered checksummed

**Given** a signed-out visitor
**When** they open `/schema`
**Then** the page renders the five Type input and output schemas from `packages/schemas` via `z.toJSONSchema`, the shared `samples`, the x402 wire contract (method, headers `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, timeouts 15 s unpaid and 15 s paid, one retry), and the active binding from `buildX402Config`: Facilitator URL, scheme `exact`, network `eip155:97`, tUSD address, and EIP-712 domain name and version
**And** `GET /api/health` answers 200 after pinging the database and 503 otherwise

### Story 1.10: Seed, Doctor, and One-Command Bring-Up

As an Operator,
I want `docker compose up`, `pnpm seed`, and `pnpm doctor` to bring the whole spine to a paid Run from a fresh laptop,
So that the demo environment is reproducible and every gas-paying key is known to be funded.

**Covers:** FR-44 (Binance Ticker listed), NFR-2, NFR-9, NFR-10 · Structural Seed, AD-2, AD-5, AD-10

**Acceptance Criteria:**

**Given** a laptop with Docker and the `.env` files restored from the team password manager
**When** `docker compose up -d` runs
**Then** `postgres`, `migrate`, `web` (:3000), `worker`, `facilitator` (:4020), and `agent-binance-ticker` (:4101) start in dependency order, `web` and `worker` wait for `migrate` with `service_completed_successfully`, and every `/health` answers 200 within 60 s
**And** the worker writes `platform_settings.worker_seen_at` every 10 s from a dedicated interval started at boot, independent of the settlement loop of Story 2.9 and of the mode's poll interval, so the heartbeat holds in `production` mode on day 1

**Given** the stack is up
**When** `pnpm seed` runs
**Then** it refuses to run when any BNB floor is unmet, calls `importPlatformWallet()` (Platform Account, `platform_settings.platform_account_id`, Platform Wallet row), creates one hard-coded Builder account and wallet through `wallet.create` and waits for `ready_at`, mints tUSD into it, inserts the Binance Ticker listing with `skip_verification` and waits for `status = 'active'`, creates the Builder's one-node Workflow, and prints the Workflow id, the listing's agent URL, and the explorer links of the identity and list transactions
**And** running `pnpm seed` twice is idempotent (no duplicate accounts, listings, or chain transactions), and `pnpm seed --reset` truncates every table including `chain_tx` after an explicit confirmation

**Given** the seeded stack
**When** `pnpm doctor` runs
**Then** it checks and prints pass or fail for: Platform Wallet, relayer, and Creator BNB floors; RPC reachability for every `RPC_URLS` entry; facilitator `/health` and pending nonces; database connectivity; `worker_seen_at` within 30 s; `PUBLIC_BASE_URL` not loopback, Docker-internal, or `trycloudflare.com` when any `identity:` row exists; and exits non-zero on any failure
**And** `POST /api/runs` for the seeded Workflow ends `completed` with a `payment_tx_hash` visible on `testnet.bscscan.com` within 45 s, which is the day-1 exit criterion
**And** the named Cloudflare tunnel exists on the team domain and `PUBLIC_BASE_URL` points at it, or the team has recorded in the memlog that `data:` URIs are used instead

## Epic 2: Five-Node Run to a Binance Order and a Telegram Message

A Builder composes a data → research → risk → execution → notify Workflow in the builder, starts a Run, and watches the engine pay each Node in order, skip on HOLD or REJECT, place a Binance Spot Testnet market order through the platform-operated executor, and deliver the summary to Telegram. The Operator can stop trading and switch mode without a restart. Day 2 target, in parallel with Epic 3.

Story order is the build order. 2.1 and 2.2 first (small, shared by everything after); 2.3, 2.4, 2.5, 2.6 are independent agent processes that run in parallel; 2.7 (builder) runs beside them; 2.8 → 2.9 are the engine; 2.10 closes the day with the rehearsal.

### Story 2.1: Sign-In Session for Seeded Accounts

As a Builder,
I want to sign in with the seeded email and password and have my Workflows and Runs belong to my Account,
So that the builder, Runs, and operator routes have an owner before self-service sign-up exists.

**Covers:** FR-1 (sign-in only; sign-up is Story 3.1) · AD-10, conventions (auth)

**Acceptance Criteria:**

**Given** the seeded Builder and Platform accounts with `password_hash` (bcrypt) and `is_operator = true` on the Platform Account
**When** `POST /api/auth/sign-in { email, password }` is called
**Then** a valid pair sets an iron-session 9.0.1 cookie holding `account_id` and `is_operator`, and a wrong pair answers 401 `unauthorized` without revealing which field failed
**And** `POST /api/auth/sign-out` clears the cookie, and `GET /api/me` returns the account's id, email, wallet address, `is_operator`, `telegram_chat_id`, and remaining Daily Fee Budget as a base-unit string

**Given** the helpers `requireSession()` and `requireOperator()` in `apps/web`
**When** a session route is called without a cookie
**Then** it answers 401 `unauthorized`; a non-operator calling `/api/operator/*` answers 403 `forbidden`
**And** `POST /api/runs` and every `/api/workflows` route require a session and answer 404 `not_found` for a Workflow the session does not own
**And** a `/sign-in` page exists and the builder and run pages redirect there when signed out

### Story 2.2: Platform Settings, Mode Constants, and Operator Controls

As an Operator,
I want to flip Emergency Stop, switch demo mode, and reset an Account's budget from one page,
So that the demo can be steered live without a restart.

**Covers:** FR-45, NFR-2 (demo mode) · AD-10, AD-12

**Acceptance Criteria:**

**Given** `platform_settings` row 1
**When** the worker loop iterates or any API request runs
**Then** it reads the row fresh (no in-memory cache older than one iteration or request), and `packages/core` exports the mode constants table keyed by `mode` with the PRD addendum §6 values (window 60 min / 20 s, poll 60 s / 2 s, research rule `window price move` / `24h trend`, kline granularity 1 m / 1 s, default budget 1 / 100 tUSD, run timeout 120 s)
**And** `GET /api/settings/public` (session) returns `{ mode, emergency_stop }`, and `GET /api/internal/settings` (Bearer `INTERNAL_TOKEN`, no session) returns `InternalSettings { emergency_stop, order_ceiling_usdt }`; a wrong token answers 401

**Given** a signed-in Operator on `/operator`
**When** they toggle Emergency Stop, switch mode between `production` and `demo`, or enter an account email and click reset budget
**Then** `PATCH /api/operator/settings { emergency_stop?, mode? }` and `POST /api/operator/accounts/<id>/reset-budget` (sets `accounts.budget_window_start = now()`) persist the change, and the page shows the new state within one refetch
**And** `GET /api/operator/accounts?email=` lists accounts (id, email, wallet address, budget, spend) so the page resolves the typed email to an id before calling reset; an unknown email shows "no such account"
**And** the change is observable by the worker and by `GET /api/internal/settings` within five seconds without restarting any service
**And** a non-operator gets 403 and the page is not linked for them

**Given** any signed-in page
**When** the dashboard header renders
**Then** it shows the current mode and an Emergency Stop badge from `GET /api/settings/public`, polled every 2 s

### Story 2.3: Alpha Research and Sloppy Research Agents

As a Builder,
I want a research Agent that follows the 24-hour trend with a reason and a second one that is confidently wrong,
So that the Provider swap in the demo changes both the cost and the Settlement outcome.

**Covers:** FR-44 (Alpha Research, Sloppy Research), FR-15 · AD-1, AD-7

**Acceptance Criteria:**

**Given** `apps/agents/alpha-research` (:4102, `AGENT_PRICE=0.05`) built with `createAgent({ type: 'research' })` and `@anthropic-ai/sdk` 0.124.0 with model `claude-sonnet-5`
**When** a paid request with `{ symbol, market }` arrives
**Then** the handler sends the market snapshot with a fixed prompt requiring a signal in the direction of `change_24h_pct`, a confidence in [0, 1], and a one-sentence reason grounded in the snapshot, parses the model's JSON, and answers `{ signal, confidence, reason }` that passes `validateOutput`
**And** the LLM call has an 8 s timeout; on error, timeout, or unparsable output the handler answers `{ signal: 'HOLD', confidence: 0.5, reason: 'LLM unavailable, holding' }`
**And** a model answer whose signal contradicts the sign of `change_24h_pct` is replaced by the trend-following signal with the model's reason, so the agent follows the trend by construction (unit test with a stubbed model)
**And** `ANTHROPIC_API_KEY` appears only in this agent's env schema; no other package imports the SDK

**Given** `apps/agents/sloppy-research` (:4103, `AGENT_PRICE=0.03`)
**When** a paid request arrives
**Then** it answers `LONG` when `change_24h_pct < 0`, `SHORT` when `> 0`, `HOLD` when `= 0`, with `confidence: 0.9` and a generic reason, within 100 ms of the handler start
**And** both agents have a Dockerfile, a compose service, `GET /health`, and a 402 whose `amount` equals `toBaseUnits(AGENT_PRICE)`
**And** the same image starts a second instance as `agent-sloppy-research-2` on :4107 with `AGENT_PAYTO` read from a compose `env_file` `.env.seed`, committed as a template holding the Platform Wallet address until the seed of Story 2.10 rewrites it
**And** `pnpm seed` lists both agents under the Platform Account at 0.05 and 0.03 tUSD with the seed's `skip_verification` path (Story 3.4 replaces it with a real verification Call) and waits for `status = 'active'`, so the Workflow Builder of Story 2.7 and the engine of Story 2.8 have a Provider of this Type

### Story 2.4: Guardrail Risk Agent

As a Builder,
I want a risk Agent that rejects confident counter-trend signals and sizes down on volatility,
So that a sloppy signal never reaches the exchange and an approved one is sized within balance.

**Covers:** FR-44 (Guardrail Risk), FR-15 · AD-7

**Acceptance Criteria:**

**Given** `apps/agents/guardrail-risk` (:4104, `AGENT_PRICE=0.02`) built with `createAgent({ type: 'risk' })`
**When** a paid request with `{ symbol, signal, confidence, proposed_size_usdt, balance_usdt, market }` arrives
**Then** it answers `REJECT` with `size_usdt: "0"` when `confidence > 0.85` and the signal opposes the sign of `market.change_24h_pct` (LONG with a negative change or SHORT with a positive change); otherwise `REJECT` when `market.volatility_24h_pct > 6`; otherwise `REDUCE` to 60 percent of `proposed_size_usdt` when `> 3`; otherwise `APPROVE` with `size_usdt = proposed_size_usdt`
**And** `size_usdt` is never above `balance_usdt` (clamped, still `APPROVE` or `REDUCE`), is a decimal string with at most 2 decimals, and the `reason` names the rule that fired
**And** a `HOLD` signal answers `REJECT` with reason `hold signal`
**And** unit tests cover each branch and the clamp; the handler completes in under 100 ms; Dockerfile, compose service, and `/health` exist
**And** `pnpm seed` lists Guardrail Risk under the Platform Account at 0.02 tUSD with the seed's `skip_verification` path (Story 3.4 replaces it with a real verification Call) and waits for `status = 'active'`, so the Workflow Builder of Story 2.7 and the engine of Story 2.8 have a Provider of this Type

### Story 2.5: Binance Spot Executor Agent

As a Builder,
I want the platform's execution Agent to place a market order on Binance Spot Testnet and answer a schema-valid result or refusal,
So that a Run can end in a real testnet order that I can verify on Binance.

**Covers:** FR-31, FR-44 (Binance Spot Executor), FR-14 (platform-operated) · AD-7, AD-10, AD-11, AD-14

**Acceptance Criteria:**

**Given** `apps/agents/spot-executor` (:4105, `AGENT_PRICE=0.01`) owning an `Exchange` port (`placeMarketOrder({ symbol, side, quoteQty })`, `getOrder(symbol, orderId)`, `getBalance()`) implemented over `@binance/spot` 32.0.3 with an Ed25519 key against `https://testnet.binance.vision`
**When** a paid request `{ symbol, side, size_usdt }` arrives
**Then** the handler calls `GET /api/internal/settings` with `INTERNAL_TOKEN` (3 s timeout) and answers `{ status: 'REJECTED', reason: 'emergency stop', ts }` when `emergency_stop` is true, `reason: 'above platform order ceiling'` when `size_usdt > order_ceiling_usdt`, and `reason: 'settings unavailable'` when the settings call fails; each is a paid, schema-valid 200
**And** otherwise it places a MARKET order with `quoteOrderQty = size_usdt` and answers `{ status: 'FILLED', order_id, filled_price, filled_qty, ts }` from the fill (`filled_price` = cumulative quote / executed qty as a decimal string), and an exchange rejection (for example below minimum notional or insufficient balance) answers `REJECTED` with the exchange message as `reason`, never a 5xx
**And** setting `EXCHANGE_BASE_URL=https://demo-api.binance.com` with `EXCHANGE_DEMO_API_KEY` / `EXCHANGE_DEMO_PRIVATE_KEY` switches to Spot Demo Mode with no code change; exchange credentials appear only in this agent's env schema

**Given** the internal routes
**When** `GET /internal/balance` or `GET /internal/orders/<order_id>?symbol=BNBUSDT` is called with the bearer token
**Then** they return `InternalBalance { balance_usdt }` (free USDT of the Platform Exchange Account) and `InternalOrder { order_id, raw }` (the exchange's live order response), and 401 without the token
**And** `pnpm doctor` gains checks that ping both exchange hosts and print the Platform Exchange Account's USDT balance
**And** Dockerfile, compose service, and `/health` exist
**And** `pnpm seed` lists Binance Spot Executor under the Platform Account at 0.01 tUSD with the seed's `skip_verification` path (Story 3.4 replaces it with a real verification Call) and waits for `status = 'active'`, so the Workflow Builder of Story 2.7 and the engine of Story 2.8 have a Provider of this Type

### Story 2.6: Telegram Notifier Agent

As a Builder,
I want the Run summary, cost table, tx hashes, and order delivered to my Telegram chat,
So that I get the result of a Run where I already am.

**Covers:** FR-32, FR-44 (Telegram Notifier), FR-15 · AD-7, AD-12

**Acceptance Criteria:**

**Given** `apps/agents/telegram-notifier` (:4106, `AGENT_PRICE=0.005`) built with `createAgent({ type: 'notify' })` and grammY 1.46.0
**When** it starts with `TELEGRAM_BOT_TOKEN` and `AGENT_TELEGRAM_POLL=true`
**Then** it long-polls the Bot API (never a webhook), and replying `/start` to the bot returns the chat id in a message the Builder can paste into settings
**And** `TELEGRAM_BOT_TOKEN` appears only in this agent's env schema

**Given** a paid request with the `notify` input
**When** `recipient.channel = 'telegram'`
**Then** it posts one formatted message to `recipient.address` containing `summary`, one line per `cost_table` entry (node, provider, amount, tx hash when present), every entry of `tx_hashes` as an explorer link, and the order block (`order_id`, `filled_price`, `filled_qty`) or the `REJECTED` reason when `order` is present, and answers `{ delivered: true, channel: 'telegram', message_ref: <message id> }`
**And** a Telegram API error or a chat id the bot cannot message returns 500 (not settled); a `channel` other than `telegram` is a 400
**And** the message arrives within ten seconds of the request; Dockerfile, compose service, and `/health` exist
**And** `pnpm seed` lists Telegram Notifier under the Platform Account at 0.005 tUSD with the seed's `skip_verification` path (Story 3.4 replaces it with a real verification Call) and waits for `status = 'active'`, so the Workflow Builder of Story 2.7 and the engine of Story 2.8 have a Provider of this Type

### Story 2.7: Workflow Builder with Validation, Cost Preview, and Provider Swap

As a Builder,
I want to compose a linear chain of typed Nodes, see it validated and priced live, swap a Provider, save it, and run it,
So that I can assemble a five-agent pipeline from the marketplace without writing any mapping.

**Covers:** FR-4, FR-17, FR-18, FR-19, FR-20, FR-21, FR-22 · AD-3, AD-12, AD-13, AD-14

**Acceptance Criteria:**

**Given** `packages/core/workflow/validate.ts`
**When** `validateChain(nodes, listings)` runs (used by both the API and the builder page)
**Then** it enforces: `research` requires an earlier `data`; `risk` requires an earlier `research`; `execution` requires an earlier `risk`; `notify` only last; at most one Node per Type; every Node bound to an `active` Listing (a `paused` Listing is a violation naming FR-8); an `execution` Node requires an Order Cap > 0; and it returns violations keyed by node index with the rule name
**And** unit tests accept `data, research, notify` and `data, research, risk, execution, notify` and reject `data, execution`, `research, data`, a duplicate Type, and a chain with a paused Listing

**Given** a signed-in Builder on `/workflows/new`
**When** they add Nodes by picking a Type and then a Provider from `GET /api/listings?type=`
**Then** the chain renders with `@xyflow/react` 12.11.6 as a left-to-right linear graph, violations show inline at the offending Node with the rule, the symbol is fixed to `BNBUSDT`, and the Order Cap field is required when an `execution` Node is present
**And** the max-cost preview shows the sum of the Nodes' current prices next to the remaining Daily Fee Budget from `GET /api/me`, updates within one second of any Provider change, and disables the run button with the shortfall when the preview exceeds the remaining budget
**And** swapping one Node's Provider leaves every other Node unchanged, re-validates, and re-prices (with the Seed Listings of Stories 1.10 and 2.3 to 2.6 active, the good chain shows 0.095 tUSD and the swap to Sloppy Research 0.075 tUSD)

**Given** the API
**When** `POST /api/workflows` or `PUT /api/workflows/<id>` is called with `{ name, symbol, order_cap_usdt, nodes: [{ type, listing_id }] }`
**Then** an invalid chain answers 400 `validation_failed` with the violations; a valid one persists `workflows` and `workflow_nodes` (ordered by `node_index`) owned by the session account
**And** `GET /api/workflows` lists the account's Workflows with name, node count, and last Run status, and `/workflows` renders them with a run action that calls `POST /api/runs` and navigates to `/runs/<id>`
**And** a `run_in_progress` 409 shows "a Run of this Workflow is still running" without navigating

### Story 2.8: Engine Runs the Full Chain with Mapping, Skips, and Order Guards

As a Builder,
I want the engine to feed each Node from the previous output and Run context, skip Nodes that are not needed, and guard the order before paying,
So that a five-node Run pays only the Nodes that matter and ends in a filled order or an honest "no order".

**Covers:** FR-4, FR-24, FR-30, FR-31 (engine side, verify on Binance) · AD-4, AD-11, AD-13, AD-14

**Acceptance Criteria:**

**Given** a Run of the full chain
**When** the engine executes Nodes in `node_index` order
**Then** it builds each input per PRD addendum §1: `research` gets `{ symbol, market: data.out }`; `risk` gets `{ symbol, signal, confidence, proposed_size_usdt: order_cap_usdt, balance_usdt, market }` with `balance_usdt` read through the `ExchangeBalance` port (`packages/adapters/exchange` over `GET /internal/balance`, 3 s timeout) just before the `risk` Node; `execution` gets `{ symbol, side, size_usdt }` with `LONG → BUY` and `SHORT → SELL`; and `notify` gets the engine-built input with `recipient` from the account's `telegram_chat_id`
**And** a Node starts only after the previous Node `succeeded` or was `skipped`; a `HOLD` signal marks `risk` and `execution` `skipped` with `skip_reason = 'hold'`; a `REJECT` decision marks `execution` `skipped` with `skip_reason = 'reject'`; skipped Calls are never requested or paid and their `locked_price` drops out of the spend query once the Run ends
**And** a failed `balance_usdt` read fails the `risk` Call before payment with `failure_reason = 'exchange balance unavailable'`

**Given** the `execution` Node is reached
**When** the engine prepares to pay
**Then** it fails the Call before payment with `failure_reason` `order cap exceeded` when `size_usdt > order_cap_usdt`, or `below exchange minimum notional (5 USDT)` when `size_usdt < 5`, ending the Run `failed at execution` with `notify` still run; Emergency Stop and the global ceiling are not checked by the engine (the executor answers `REJECTED`)
**And** a `notify` Node with no `telegram_chat_id` on the account fails before payment with `failure_reason = 'no Telegram chat id linked'`

**Given** the Run reaches its end
**When** the last Node has ended
**Then** the Run is `completed` only when an `execution` Call returned `FILLED` or the Workflow has no `execution` Node; a `REJECTED` execution or a skipped execution ends `completed, no order` and the `notify` summary ends with "no order"; every still-`pending` Call becomes `skipped` with `skip_reason = 'not_reached'`
**And** two `POST /api/runs` for one Workflow while the first is `running` answer 409 `run_in_progress`, and a new Run after the first ends starts with its own Price Lock, Calls, and log
**And** `GET /api/runs/<id>/order` proxies `GET /internal/orders/<order_id>?symbol=` for the Run's `FILLED` execution Call, and the Run view shows a "verify on Binance" action that renders the raw exchange response; skipped Calls show their `skip_reason`

### Story 2.9: Stop on Failure, Notify Anyway, and the Timeout Sweep

As a Builder,
I want a failed Node to stop the Run but still send me the failure by Telegram, and a stuck Run to time out cleanly,
So that I never pay for Nodes after a failure and the Workflow is free to run again.

**Covers:** FR-29, FR-30 (timeout), FR-27 (statuses only; scoring is Epic 4) · AD-4, AD-9 (sweep only)

**Acceptance Criteria:**

**Given** a Node fails (`price_mismatch`, `payment_failed`, `failed_after_payment`, or a pre-payment refusal)
**When** the engine handles the failure
**Then** it sets the Run `failed at <Type>` with `runs.failure_reason`, marks every later non-`notify` Call `skipped` with `skip_reason = 'not_reached'`, and runs the `notify` filter with a failure input: `summary` names the failed Node and reason, `cost_table` lists only Calls that were paid (`paid_awaiting_result`, `succeeded`, `failed_after_payment`), `tx_hashes` lists only known hashes, `order` absent
**And** the `notify` Call is paid at its locked price; a `notify` failure on a still-`running` Run ends it `failed at notify`, while a `notify` failure on a Run already `failed at <Node>` or `timed out` keeps that status and the Call carries the failure
**And** a `failed_after_payment` `research` or `risk` Call publishes `settlement.tick { call_id }` (consumed in Epic 4; a no-op handler is registered now)

**Given** the worker's in-process loop (`setTimeout` chain that re-reads `platform_settings.mode` and sleeps the mode's poll interval)
**When** a Run has been `running` for more than 120 s plus 45 s grace
**Then** the sweep compare-and-sets it to `timed out`, marks `pending` Calls `skipped` with `skip_reason = 'not_reached'`, and publishes `run.execute { run_id, finalize: true }`, on which the engine runs only the `notify` filter
**And** the engine itself ends a Run `timed out` when `started_at + 120 s` is exceeded before a Node or a paid retry
**And** after any end the spend query no longer counts the Run's unpaid Calls, so the released budget is visible in `GET /api/me` and the Workflow accepts a new Run
**And** the Run view shows the failure reason, and a unit test proves the compare-and-set: a second writer ending the same Run updates zero rows and the engine records the in-flight Call and exits

### Story 2.10: Six Seed Agents Listed and the Full Chain Rehearsed

As an Operator,
I want the seed to list all six Agents and the demo Workflows, and a rehearsal Run to end in a testnet order and a Telegram message inside 45 seconds,
So that day 2 ends with the demo's main beat working on the real stack.

**Covers:** FR-44 (all six listed), NFR-1, NFR-2 (two wallet sets), NFR-10 · Structural Seed, AD-2, AD-10

**Acceptance Criteria:**

**Given** the stack from Story 1.10 plus the five new agent services on :4102–:4107
**When** `docker compose up -d` runs
**Then** every agent's `/health` answers 200 within 60 s, and `pnpm doctor` passes including the exchange checks

**Given** the stack is up
**When** `pnpm seed` runs
**Then** it creates two Builder and two Creator accounts plus one spare pair (each through `wallet.create`, funded with tUSD), sets `daily_fee_budget` to 100 tUSD on the demo accounts, sets `mode = 'demo'`, asserts all six Seed Agents listed by Stories 1.10 and 2.3 to 2.6 are `active` at the PRD addendum §2 prices and lists any that are missing, writes `.env.seed` with `AGENT_PAYTO` = the demo Creator wallet and restarts `agent-sloppy-research-2`, sets the first Builder's `telegram_chat_id` from `SEED_TELEGRAM_CHAT_ID`, and creates two Workflows for that Builder: the good chain (Ticker, Alpha, Guardrail, Executor, Notifier, Order Cap 10 USDT) and the sloppy chain (same with Sloppy Research)
**And** `pnpm seed --activate-spare` swaps the spare account pair into the demo Workflows; `pnpm seed` remains idempotent

**Given** the seeded good chain and demo mode
**When** a rehearsal Run starts from the builder
**Then** it ends `completed` within 45 s with five `succeeded` Calls each carrying a `payment_tx_hash` on `testnet.bscscan.com`, a `FILLED` order visible through "verify on Binance", and a Telegram message containing all five hashes
**And** a Run of the sloppy chain ends `completed, no order` with `risk` `REJECT`, `execution` `skipped` (`reject`), and a Telegram message ending in "no order"
**And** with Emergency Stop on, the good chain ends `completed, no order` with the executor's `REJECTED` reason `emergency stop` in the Call response

## Epic 3: Self-Service Accounts, Wallets, and Agent Listing

A stranger signs up, receives a funded System Wallet, sets a Daily Fee Budget and Telegram chat id, and lists a new Agent with no approval in under 30 seconds: the platform verifies the endpoint with one paid Call, registers the ERC-8004 identity, locks Stake and writes the Registry entry in one transaction, and the card appears on the marketplace. Builders browse and compare Listings, and Runs use the signed-in Account's wallet and budget. Day 2 target, in parallel with Epic 2.

Story order is the build order. 3.1 → 3.2 are the account surface; 3.3 → 3.4 are the listing pipeline; 3.5 and 3.6 run in parallel after 3.4; 3.7 closes the epic with the live-listing rehearsal.

### Story 3.1: Sign-Up with a System Wallet

As a person new to AgentDesk,
I want to create an Account with email and password and receive a funded System Wallet,
So that I can list Agents and run Workflows without bringing my own wallet.

**Covers:** FR-1 (sign-up, sign-out, redirects), FR-2, NFR-3, NFR-8 · AD-5, AD-8, AD-12

**Acceptance Criteria:**

**Given** the `/sign-up` page
**When** a visitor submits a new email and a password of at least 8 characters
**Then** `POST /api/auth/sign-up` inserts exactly one `accounts` row (email, bcrypt hash, `is_operator = false`), publishes `wallet.create { account_id }` in the same transaction, sets the session cookie, and redirects to `/settings`
**And** an existing email answers 409 `conflict` and the page shows "email already registered"; an invalid body answers 400 `validation_failed`
**And** the database stores for that person only `email`, `password_hash`, the wallet `address`, `encrypted_key`, and later `telegram_chat_id`

**Given** the `wallet.create` job from Story 1.6 runs for the new account
**When** the Builder watches `/settings`
**Then** the wallet address appears within one second of sign-up (the row is inserted before gas, mint, and approve), the page shows "wallet preparing" and polls `GET /api/me` every 2 s until `ready_at` is set, then shows the tUSD and BNB balances read on page load through the chain adapter
**And** no API or page ever returns `encrypted_key` or a private key (an integration test asserts the `GET /api/me` and `GET /api/accounts/*` bodies contain no such field)
**And** `POST /api/listings` and `POST /api/runs` answer 409 `wallet_not_ready` until `ready_at` is set

**Given** a signed-out visitor
**When** they open `/listings/new`, `/workflows/*`, `/runs/*`, `/marketplace`, or `/settings`
**Then** they are redirected to `/sign-in`, and the same guard covers the Epic 5 pages `/dashboard`, `/payments`, `/settlements`, `/agents/*`, and `/runs/<id>/split`, while `/schema` and `/api/listings/<id>/agent.json` stay public
**And** a sign-out control in the header calls `POST /api/auth/sign-out` and returns to `/sign-in`

### Story 3.2: Daily Fee Budget and Telegram Chat Id in Settings

As a Builder,
I want to set my Daily Fee Budget and link my Telegram chat id,
So that my spending is capped per day and my Runs can notify me.

**Covers:** FR-3 (per Account, reserve and release), FR-32 (chat id setting) · AD-3, AD-5, AD-10

**Acceptance Criteria:**

**Given** `/settings`
**When** the Builder saves a Daily Fee Budget in decimal tUSD or a Telegram chat id
**Then** `PATCH /api/me { daily_fee_budget?, telegram_chat_id? }` stores the budget in base units (null restores the platform default from `platform_settings.default_daily_fee_budget`) and the chat id as a string of digits, answering 400 `validation_failed` otherwise
**And** the page shows the budget, the spend so far in the current window, and the remaining budget from `GET /api/me`, and instructions to start the shared bot with `/start` and paste the chat id it replies

**Given** the spend query of AD-3 (Calls in `paid_awaiting_result`, `succeeded`, `failed_after_payment`, plus `pending` Calls of `running` Runs, since the later of UTC midnight and `accounts.budget_window_start`)
**When** `POST /api/runs` computes the remaining budget
**Then** a Price Lock total above the remainder answers 409 `refused_budget` with `details.shortfall` in base units, and the builder shows the shortfall
**And** while a Run is `running` its `pending` Calls count against the budget; once it ends, Calls that ended `skipped`, `price_mismatch`, or `payment_failed` no longer count, which a unit test proves over fixture rows
**And** a Refund (Epic 4) never increases the remaining budget, and an Operator budget reset (Story 2.2) makes the remainder equal the full budget

**Given** a new UTC day
**When** the first request after midnight computes spend
**Then** yesterday's Calls are excluded without any scheduled job

### Story 3.3: Listing Form and Verification Progress

As a Creator,
I want to submit my Agent's name, Type, endpoint, price, and Stake and watch the listing progress,
So that my Agent is on the marketplace minutes after I finish building it.

**Covers:** FR-10, FR-14, FR-12 (progress and visibility) · AD-2, AD-10, AD-12, AD-13

**Acceptance Criteria:**

**Given** a signed-in Creator on `/listings/new`
**When** they fill the form
**Then** it requires `name`, `type` (the five Types, with `execution` offered only when the session account equals `platform_settings.platform_account_id`), `endpoint` (`https://` required; `http://` accepted only for `localhost`, `127.0.0.1`, `host.docker.internal`, and compose service names), `price` (decimal tUSD, `0 < price ≤ 1`), and `stake` (defaults to ten times the price and cannot be set lower), with optional `description` and `payout_wallet` (defaults to the Creator's System Wallet, must be a valid address)
**And** the form shows the max verification cost (the declared price) and the tUSD the Stake will pull from the System Wallet

**Given** a valid submission
**When** `POST /api/listings` is called
**Then** it inserts the `listings` row in `status = 'verifying'` with the form-owned columns (`declared_price` and `declared_stake` in base units, addresses lower-case), publishes `listing.verify { listing_id }` with singleton key `listing_id`, and answers 201 with the listing id
**And** it answers 409 `refused_execution_type` for `type = execution` from any other account, 409 `wallet_not_ready` when the Creator's wallet has no `ready_at`, and 400 `validation_failed` with field errors otherwise; the Stake is not compared against the wallet balance here (the pipeline reports it)

**Given** the listing page `/listings/<id>`
**When** the Creator watches it
**Then** it polls `GET /api/listings/<id>` every 2 s while `status = 'verifying'` and shows the pipeline steps (verification Call, identity, registry entry) with their state, then either `active` with explorer links for the `identity:` and `list:` transactions and a link to the marketplace card, or `failed` with `last_error` verbatim and a "fix and resubmit" action that opens the form pre-filled
**And** the marketplace card is visible to any Builder within five seconds of the `list:` confirmation

### Story 3.4: Paid Verification Call Before Identity and Stake

As a Creator,
I want the platform to make one real paid Call to my endpoint and refuse the listing with a precise error if it does not conform,
So that a wrong Agent never gets an identity or locks Stake, and a right one shows its first payment landing.

**Covers:** FR-11, FR-12 (step order), FR-44 (five Seed Agents pass verification) · AD-2, AD-3, AD-5, AD-6, AD-7, AD-14

**Acceptance Criteria:**

**Given** `listing.verify` from Story 1.7 for a listing without `skip_verification`
**When** the job starts
**Then** it first checks the Platform Wallet's verification spend (AD-3 query over `kind = 'verification'` Calls in the last 24 h) against `platform_settings.verification_cap_daily` inside the signing lock and sets `status = 'failed'`, `last_error = 'verification cap reached, try again tomorrow'` when the declared price would exceed it
**And** it inserts one `calls` row with `kind = 'verification'`, `run_id = null`, `listing_id`, `node_type = type`, `locked_price = declared_price`, `locked_pay_to = payout_wallet`, `locked_asset` and `locked_network` from `buildX402Config`, and `request = samples[type]` (for `notify`, with `recipient.address = PLATFORM_CHAT_ID` and `run_id = null`)
**And** it performs the same Handshake as the engine (Story 1.8) from the Platform Wallet: unpaid POST with a 15 s timeout, `accepts` selection and comparison against the locked values, `signPayment`, paid POST with a 15 s timeout resent once, `validateOutput`

**Given** the verification outcome
**When** it fails
**Then** `status = 'failed'` and `last_error` is the specific reason: "endpoint answered <status> instead of 402", "402 amount <a> differs from declared <b>", "402 payTo <x> differs from declared payout wallet <y>", "402 asset or network differs from the platform binding", "no response within 15 s", or "response failed the <type> output schema at <path>"; the Call row keeps its terminal status; no `identity:` or `list:` intent is created and no Stake moves
**And** when it succeeds the Call is `succeeded` with `payment_tx_hash`, and the job continues with `identity:<listing_id>` then `list:<listing_id>` exactly as Story 1.7, so that the whole flow from form submit to `active` completes in under 30 s against a responsive endpoint on testnet
**And** `listing.verify` skips the verification Call when `skip_verification` is set, and `POST /api/listings` sets it automatically and only for `type = 'execution'` (a path FR-14 already restricts to the Platform Account), because a sample call would place a real order (FR-11); every other Type from every path takes a real verification Call
**And** `pnpm seed` now lists the other five Seed Agents through real verification Calls and fails loudly if any of them does not pass

### Story 3.5: Marketplace Browse and Compare

As a Builder,
I want to browse Listings by Type and sort them by Reputation or price with Stake and owner on each card,
So that I can choose a Provider for each Node on evidence.

**Covers:** FR-13, FR-12 (visibility), FR-8 (paused shown, not selectable) · AD-2, AD-12, AD-13

**Acceptance Criteria:**

**Given** `/marketplace`
**When** a signed-in Builder opens it
**Then** `GET /api/listings?type=&sort=` returns `active` and `paused` listings with name, Type, price per call, Stake, `reputation_bps`, scored-call count, owner address, status, and `agent_id`, and each card renders price and Stake as decimal tUSD, the owner address checksummed with an explorer link, and the status
**And** the Reputation label is the percentage with the scored-call count for `research` and `risk` listings with at least one scored Call, "no score yet" for those with none, and "not scored in MVP" for `data`, `execution`, and `notify`

**Given** the sort control
**When** the Builder sorts by Reputation
**Then** the order is percentage descending, then "no score yet", then "not scored in MVP", ties broken by scored-call count descending then price ascending; sorting by price is ascending with ties by Reputation; the Type filter narrows to one Type, and the same ordering is applied server-side (unit test over fixture rows)
**And** paused cards show "paused" with the reason (creator or stake) and their select action is disabled in the Workflow Builder's Provider picker
**And** the list refetches every 5 s while the page is open, so a listing that turned `active` or a Reputation written on chain shows within five seconds of `refreshListingFromChain`

### Story 3.6: Creator Manages Price, Stake Top-Up, and Pause

As a Creator,
I want to change my Agent's price, top up its Stake, and pause or resume it, each as one on-chain transaction I can see,
So that I control my Listing's terms while the Stake minimum keeps Builders protected.

**Covers:** FR-7 (top-up), FR-9, FR-8 (resume by top-up) · AD-2, AD-5, AD-8, AD-13

**Acceptance Criteria:**

**Given** the owner of an `active` or `paused` listing on `/listings/<id>/manage`
**When** they submit a new price, a top-up amount, or toggle pause
**Then** `POST /api/listings/<id>/price`, `/stake`, or `/pause` allocates `<n> = Date.now()`, captures `before: { price, stake, paused }` from the listings cache, publishes `listing.write { listing_id, intent_key: 'price:<id>:<n>' | 'stake:<id>:<n>' | 'pause:<id>:<n>', payload: { listing_id, before, after } }`, and answers 202 with the intent key; a non-owner answers 404 `not_found`
**And** a price above 1 tUSD or zero, or a top-up of zero, answers 400 `validation_failed`; a price whose ten-times minimum exceeds the current Stake answers 409 `refused_stake` with `details.shortfall` before enqueuing, and the page shows the shortfall

**Given** the worker runs `listing.write`
**When** it signs with the Creator wallet through `sendTx` under the signing lock
**Then** the policy re-checks the ten-times minimum for `price:`, the wallet's tUSD balance for `stake:`, and the Creator BNB gas floor for all, and refuses by writing `listings.last_error` (`'stake below ten times price'`, `'insufficient tUSD for top-up'`, `'creator wallet below gas floor'`) without sending
**And** the transaction goes through `chainWrite` with the intent key (`setPrice`, `addStake`, `setPaused`), a confirmed receipt triggers `refreshListingFromChain`, and a revert writes `last_error` with the revert reason; a redelivered job with the same intent key sends nothing
**And** the manage page polls every 2 s while an intent is `pending` and shows the `chain_tx` rows for the listing (intent, status, tx hash link, before and after values), and a "refresh from chain" action calls `POST /api/listings/<id>/refresh`, the second caller of `refreshListingFromChain` named by AD-2, which any signed-in user may call and which answers the refreshed listing

**Given** a Run started before a price change
**When** the engine reaches that Node
**Then** the Run's Price Lock is unchanged, and a 402 at the new price is `price_mismatch` with both values (FR-26); a new Run locks the new price
**And** a top-up that brings Stake to at least ten times the current price on a listing with `paused_by_stake` clears the pause on chain and in the cache, while a creator pause is cleared only by the creator's own resume
**And** a Run already `running` when a Listing is paused (by the creator or by Stake) continues against it at the locked price, while the Workflow Builder and `POST /api/runs` refuse the paused Listing for any new Run (FR-8)

### Story 3.7: A Stranger Lists a Live Agent in Under 30 Seconds

As a Creator,
I want to list the second Sloppy Research instance from a fresh Account and see it on the marketplace within 30 seconds,
So that the demo's listing beat works on the real stack with a stable agent URI.

**Covers:** FR-12, FR-44 (live listing of `research-sloppy`), NFR-2 (seeded failover listing) · AD-2, Structural Seed

**Acceptance Criteria:**

**Given** `PUBLIC_BASE_URL` is the named Cloudflare tunnel hostname on the team domain (or empty, in which case `data:` URIs are used) and the stack from Story 2.10 is running
**When** the demo Creator account submits `/listings/new` with the :4107 endpoint URL printed by `pnpm seed`, Type `research`, price 0.03, Stake 0.3
**Then** the listing reaches `active` in under 30 s with a `succeeded` verification Call paid by the Platform Wallet, an `identity:` transaction whose `Registered` event carries the `agentURI`, and a `list:` transaction, all linked on the listing page, and the card appears on the marketplace with "no score yet"
**And** `GET <agentURI>` (or the decoded `data:` URI) returns the agent card of Story 1.7 from outside the laptop

**Given** the same endpoint is already listed by the seed as the failover
**When** the live listing fails for any reason
**Then** the seeded Listing is selectable in the builder and the failure reason is visible on the live listing's page

**Given** a host change
**When** `pnpm seed --rehost` runs with a new `PUBLIC_BASE_URL`
**Then** it enqueues `identity-uri:<listing_id>:<n>` (`setAgentURI`) for every listing with an `identity:` row and reports each result; `pnpm doctor` fails when `PUBLIC_BASE_URL` is a loopback, Docker-internal, or `trycloudflare.com` host while any `identity:` row exists

## Epic 4: Settlement, Slash, Refund, and Reputation

After a Run, the platform scores every research and risk Call against the market, slashes exactly the locked price from a wrong Agent's Stake and refunds the Builder in one on-chain transaction, recomputes Reputation over the last 30 scored Calls and writes it to the Registry, pauses an Agent whose Stake is exhausted, and refuses to pay an Agent whose unreserved Stake cannot cover a Call. Day 3 target.

Story order is the build order. 4.1 is the scoring core; 4.2, 4.3, 4.4 extend the same tick; 4.5 is independent of 4.1–4.4 and can be built in parallel; 4.6 closes the epic with the warm-up and the slash rehearsal.

### Story 4.1: Settlement Tick Scores Research and Risk Calls

As a Builder,
I want every research and risk Call I paid for scored once against live Binance market data after the Settlement Window,
So that a wrong signal or a bad sizing decision is recorded as a failed Settlement I can see.

**Covers:** FR-33, FR-34, FR-38 · AD-3, AD-9, AD-10

**Acceptance Criteria:**

**Given** `packages/core/settlement` pure functions
**When** unit tests run
**Then** `scoreResearchProduction(signal, start, end)` passes LONG when `end > start`, SHORT when `end < start`, HOLD when `|end − start| / start < 0.001`, and fails otherwise; `scoreResearchDemo(signal, change24hPct)` passes LONG when positive, SHORT when negative, HOLD when `|value| < 0.5`; `scoreRisk(side, pFill, windowMin, windowMax)` computes drawdown `(pFill − windowMin) / pFill` for BUY and `(windowMax − pFill) / pFill` for SELL and passes when `≤ 0.02`; each has a passing and a failing example and a boundary case

**Given** `runSettlementTick()` in the worker loop from Story 2.9 (sleeping the mode's poll interval, re-reading `platform_settings.mode` each iteration)
**When** it runs
**Then** it selects `research` and `risk` Calls with `kind = 'run'` (never `kind = 'verification'`, which FR-11 exempts from scoring) in `succeeded` or `failed_after_payment` with no `settlements` row, so a dropped `settlement.tick` job is recovered by the loop, and applies the mode read at tick time: a `research` Call whose `ended_at + window` has elapsed is scored with `start_price = calls.reference_price` and either `end_price = MarketData.lastPrice` (production, `rule_label = 'production settlement rule: window price move'`) or `change_24h_pct = MarketData.ticker24h` (demo, `rule_label = 'demo settlement rule: 24h trend'`); a `research` Call with null `reference_price` is `not_scored` with reason `no_reference_price`
**And** a `risk` Call with decision `REJECT` is `not_scored` with reason `reject_decision`; one with `APPROVE` or `REDUCE` waits until its Run has ended, is `not_scored` with reason `no_fill` when the Run has no `FILLED` execution Call, and otherwise, once `ended_at + window` has elapsed, is scored with `p_fill` = that execution Call's `reference_price` and the window min or max from `MarketData.klines` at the mode's granularity (1 m production, 1 s demo) between `ended_at` and window end, `rule_label = 'risk rule: 2% drawdown in window'`
**And** each scored Call gets exactly one `settlements` row (`call_id` unique, `listing_id`, `result`, `not_scored_reason`, `mode`, `rule_label`, `start_price`, `end_price`, `change_24h_pct`, `p_fill`, `window_min`, `window_max`, `price_source` (the constant `binance-public-market-data`, the only source AD-9 and addendum §4 allow), `scored_at`, `slash_amount`, `slash_tx_hash`, `refund_to`, `reputation_tx_hash`, columns added by this story's migration); a tick that finds an existing row skips the Call, and a market-data failure leaves the Call unscored for the next tick
**And** `data`, `execution`, and `notify` Calls are never selected, `kind = 'verification'` Calls are never selected at any status (FR-11: the verification Call is never scored, so it also never reserves Stake), and the scoring reads only the `MarketData` port, never the paid `data` Agent's response

### Story 4.2: Failure After Payment Is Scored Immediately

As a Builder,
I want a research or risk Agent that took my payment and then failed to be scored as failed at once,
So that a paid non-answer costs the Agent the same as a wrong answer.

**Covers:** FR-27 · AD-4, AD-9

**Acceptance Criteria:**

**Given** the engine marks a `research` or `risk` Call `failed_after_payment` and publishes `settlement.tick { call_id }` (Story 2.9)
**When** the worker handles that job
**Then** it calls the same `runSettlementTick({ call_id })` code path, which writes one `settlements` row with `result = 'failed'`, `rule_label = 'failed after payment'`, `scored_at = calls.ended_at`, no prices, and no window wait, and continues with the slash of Story 4.3
**And** a redelivered job for the same `call_id` finds the row and does nothing
**And** a `failed_after_payment` Call of Type `data`, `execution`, or `notify` gets no `settlements` row, and the Run view shows the payment with status `failed_after_payment` and no Refund

### Story 4.3: Slash and Refund in One Transaction, Pause at Zero Stake

As a Builder,
I want a failed Settlement to move exactly the Call's fee from the Agent's Stake into my System Wallet in one on-chain transaction,
So that a wrong Agent pays me back and I can verify it on the explorer.

**Covers:** FR-35, FR-37, FR-8 (automatic pause at zero) · AD-2, AD-8, AD-9, AD-13

**Acceptance Criteria:**

**Given** a `settlements` row with `result = 'failed'` and no `slash_tx_hash`
**When** the tick continues
**Then** it runs `chainWrite('slash:<call_id>', ...)` from the Platform Wallet calling `slash(registry_listing_id, keccak256(call_id), locked_price, <the Run's Builder System Wallet>)`, and on the confirmed receipt reads `Slashed(listingId, callRef, amount)` and writes `slash_amount` from the event, `slash_tx_hash`, and `refund_to`
**And** the Builder's wallet tUSD balance increases by `slash_amount` in the same transaction as the Stake decreases (one tx hash for both), and a retried tick with the existing `slash:` row sends nothing
**And** when the remaining Stake is below the locked price the contract slashes the whole remainder, `slash_amount` is the clamped value, the contract sets the stake pause, and `refreshListingFromChain` on the same receipt sets `paused_by_stake = true` and `status = 'paused'` in the same job, so the marketplace shows "paused (stake)" and the Workflow Builder refuses the Listing
**And** the `slash:` `chain_tx` row carries `payload = { listing_id, call_id, settlement_id, amount, to }` captured before sending, so Story 5.4 can render the Stake history without re-reading the chain
**And** a `reverted` or `failed` `slash:` intent is logged with `tx_hash` and `listings.last_error`, and the tick retries it on the next iteration through the same key

**Given** `GET /api/runs/<id>`
**When** a Run's Calls have Settlements
**Then** the body includes each Call's Settlement (`result`, `rule_label`, `mode`, prices, `slash_amount`, `slash_tx_hash`, `refund_to`), the Run view shows a settlement column per research and risk Call with the result and the slash tx hash linked through `explorerLink()`, and React Query keeps polling every 2 s while any research or risk Call is unscored or a `failed` row has no `slash_tx_hash`

### Story 4.4: Reputation Recomputed and Written On-Chain

As a Builder,
I want each Agent's Reputation to reflect its last 30 scored Calls on-chain within seconds of every Settlement,
So that the marketplace ranks Agents by evidence anyone can verify.

**Covers:** FR-36, FR-6 (Reputation in the entry), FR-13 (sort reflects it) · AD-2, AD-8, AD-9

**Acceptance Criteria:**

**Given** a new `settlements` row with `result` in (`passed`, `failed`) for a listing
**When** the tick finishes the row (after the slash for `failed`)
**Then** it computes `passed / (passed + failed)` over the listing's last 30 rows with `result` in (`passed`, `failed`) ordered by `scored_at` descending, converts it to basis points, and runs `chainWrite('reputation:<listing_id>:<settlement_id>', ...)` from the Platform Wallet calling `setReputation(registry_listing_id, bps)`; the confirmed receipt writes `settlements.reputation_tx_hash` and `refreshListingFromChain` updates `reputation_bps`
**And** a `not_scored` row triggers no reputation write, and a listing with zero `passed` or `failed` rows keeps "no score yet"
**And** the marketplace (Story 3.5) shows the new percentage and scored-call count within five seconds of the confirmation, and its Reputation sort reorders accordingly
**And** the listing's Reputation history is the ordered `reputation:` rows of `chain_tx` with their payload `{ before, after }` (bps) and tx hashes, exposed by `GET /api/listings/<id>/history` for Epic 5

### Story 4.5: Stake Reservation Refuses Uncovered Calls

As a Builder,
I want the engine to refuse to pay a research or risk Agent whose unreserved Stake cannot cover my Call,
So that every paid, unscored Call is backed by Stake that can be slashed.

**Covers:** FR-25 (Stake reservation check), FR-7 (coverage) · AD-3, AD-5

**Acceptance Criteria:**

**Given** the reservation query of AD-3 (`locked_price` of the listing's `research` and `risk` Calls with `kind = 'run'` in `paid_awaiting_result`, `succeeded`, `failed_after_payment` with no `settlements` row; verification Calls are excluded because they are never scored and so could never be released) and the listing's `stake` from the cache
**When** `signPayment` runs inside the signing lock for a `research` or `risk` Call
**Then** it refuses when `stake − reserved < locked_price`, marks the Call `payment_failed` with `failure_reason = 'refused_stake'`, ends the Run `failed at <Type>` with `runs.failure_reason = 'stake exhausted'`, and the `notify` filter still runs with that reason
**And** `data`, `execution`, and `notify` Calls are never checked
**And** a unit test proves: stake 0.3 tUSD, two unscored 0.03 Calls reserved, third 0.03 Call allowed; stake 0.06 with two unscored 0.03 Calls, third refused; a scored Call releases its reservation; a `kind = 'verification'` Call reserves nothing
**And** the refusal is visible in the Run view with the reason and pays nothing; the Builder's budget releases the Call's `locked_price` when the Run ends

### Story 4.6: Demo Warm-Up and Slash Rehearsal

As an Operator,
I want the seed to pre-score the good research Agent and a rehearsal of the sloppy chain to end in a visible Slash and Refund inside the demo timing,
So that the demo's settlement beat and the closing reputation ranking work on the real stack.

**Covers:** FR-44 (demo outcomes), NFR-1 (settle ≤ 10 s), NFR-2 (`research-good` pre-scored), NFR-4 · AD-9, AD-10, Structural Seed

**Acceptance Criteria:**

**Given** the stack in demo mode with the Workflows of Story 2.10
**When** `pnpm seed --warm` runs
**Then** it starts three Runs of the good chain one after another, waits for each Run to end and for its research and risk Settlements to be written, and exits 0 only when Alpha Research shows Reputation 100 percent with 3 scored Calls on the marketplace and the Guardrail Risk Call results are `passed` or `not_scored` (`no_fill`)
**And** it prints each Run id, the Settlement results, and the reputation tx hashes

**Given** a rehearsal Run of the sloppy chain in demo mode
**When** it ends `completed, no order`
**Then** the Sloppy Research Call is scored `failed` under `demo settlement rule: 24h trend` within 20 s plus one 2 s poll of its `ended_at`, the `slash:` transaction confirms within 10 s after that, the Builder's wallet balance rises by 0.03 tUSD, the listing's Stake drops by 0.03 tUSD and its Reputation reads 0 percent with 1 scored Call, and the Run view shows the settlement result, the slash tx hash, and the refund amount
**And** the Guardrail Risk Call is `not_scored` with reason `reject_decision`
**And** a second sloppy Run started after the Slash confirms still passes the reservation check (Stake 0.27 ≥ 0.03), and the previous Run's `GET /api/runs/<id>` body carries the Slash and Refund

**Given** the timeline of the demo
**When** the rehearsal is timed
**Then** from the sloppy Run's start to the Slash confirmation is under 60 s, and the whole sequence (good Run, listing, sloppy Run, Slash, ranking) is recorded as the backup video before the demo

## Epic 5: Dashboard and Demo Views

A Builder sees every Run, payment, and scored Call with tx hashes and explorer links, opens any Agent's page with its identity, Stake, price and Reputation history and its verification Call, and opens a Run in the demo split view with the agent log on the left and the money flow on the right. Day 3 target; the first epic to cut if time runs short, since Epics 1–4 already expose their data through the Run view and the API. Every story is read-only over existing tables; no new writers.

Story order is the build order, but all five stories are independent of each other and can run in parallel.

### Story 5.1: Dashboard Home and Live Run Feed

As a Builder,
I want a dashboard that lists my Runs with status, Nodes, total cost, and start time, updating live,
So that I can follow every Run from one place.

**Covers:** FR-39, NFR-5 · AD-3, AD-12, AD-13

**Acceptance Criteria:**

**Given** a signed-in Builder on `/dashboard`
**When** the page loads
**Then** `GET /api/runs?limit=&cursor=` returns `{ items, next }` of the account's Runs newest first, each with `id`, `workflow_name`, `status`, `failure_reason`, an ordered list of Node Types with each Call's status, `total_cost` (sum of `locked_price` over Calls in `paid_awaiting_result`, `succeeded`, `failed_after_payment`) as a base-unit string, `created_at`, `started_at`, `ended_at`
**And** each row renders those fields with the cost as decimal tUSD, a status badge using the PRD status text verbatim, and links to `/runs/<id>` and `/runs/<id>/split`
**And** the feed refetches every 2 s while any listed Run is `running` and every 10 s otherwise, so a new Run appears at the top within two seconds of starting
**And** the page links to `/marketplace`, `/workflows`, `/payments`, `/settlements`, `/settings`, and `/operator` (operators only), and the header carries the mode and Emergency Stop badge from Story 2.2

### Story 5.2: Payments View

As a Builder,
I want to see every payment I made with Run, Node, Provider, amount, from and to addresses, status, and tx hash,
So that I can reconcile my spending against the chain.

**Covers:** FR-40, NFR-4, NFR-5 · AD-3, AD-13

**Acceptance Criteria:**

**Given** `/payments`
**When** a signed-in Builder opens it
**Then** `GET /api/payments?run_id=&cursor=` returns `{ items, next }` over `calls` joined to `runs`, `listings`, and `wallets` for the account's Runs where `payment_payload` is not null: `run_id`, `node_type`, `provider` (listing name), `amount` (`locked_price`), `from` (the Run's wallet address), `to` (`locked_pay_to`), `status`, `payment_tx_hash`, `started_at`, `ended_at`
**And** each row renders amounts as decimal tUSD, addresses checksummed, and the tx hash as an explorer link, or "not settled" when `payment_tx_hash` is null with status `payment_failed`
**And** the view groups rows by Run with a per-Run subtotal, and a unit test over fixture rows proves the subtotal equals the Run's `total_cost` from Story 5.1
**And** a `failed_after_payment` row of Type `data`, `execution`, or `notify` shows "no refund", while `research` and `risk` rows link to their Settlement

### Story 5.3: Settlement View

As a Builder,
I want to see every scored Call with the rule applied, mode, prices and their source, result, Slash tx hash, and Refund amount,
So that I can check why an Agent passed or failed and see my Refund land.

**Covers:** FR-41, NFR-4 · AD-3, AD-9, AD-13

**Acceptance Criteria:**

**Given** `/settlements`
**When** a signed-in Builder opens it
**Then** `GET /api/settlements?run_id=&listing_id=&cursor=` returns `{ items, next }` over `settlements` joined to `calls`, `runs`, and `listings` for the account's Runs: `run_id`, `node_type`, `provider`, `result`, `not_scored_reason`, `rule_label`, `mode`, `start_price`, `end_price`, `change_24h_pct`, `p_fill`, `window_min`, `window_max`, `price_source`, `scored_at`, `slash_amount`, `slash_tx_hash`, `refund_to`, `reputation_tx_hash`
**And** each row renders the rule label verbatim (a demo row reads "demo settlement rule: 24h trend"), the prices used with their source, the result, and for `failed` rows the Refund amount as decimal tUSD, `refund_to` (the Builder's own wallet) and the Slash tx hash as an explorer link, plus the Reputation tx hash
**And** a `failed` row whose slash is still `pending` shows "slash pending" and the page refetches every 2 s until every visible `failed` row has a `slash_tx_hash`
**And** `not_scored` rows show the reason in words ("REJECT decision", "no fill", "no reference price")

### Story 5.4: Agent Detail Page

As a signed-in user,
I want an Agent's page with its identity, Stake, price history, Reputation history, scored-call count, and verification Call,
So that I can judge an Agent from its on-chain record before choosing it.

**Covers:** FR-42, FR-5 (agent id shown), FR-9 (price history), FR-11 (verification Call shown) · AD-2, AD-8, AD-13

**Acceptance Criteria:**

**Given** `/agents/<listing_id>`
**When** any signed-in user opens it
**Then** `GET /api/listings/<id>` supplies name, Type, description, endpoint, owner address, status with pause reason, price, Stake, `reputation_bps`, scored-call count, `agent_id`, and `registry_listing_id`, and `GET /api/listings/<id>/history` (Story 4.4, extended) supplies the ordered `list:`, `price:`, `stake:`, `pause:`, `slash:`, and `reputation:` rows of `chain_tx` with payload `before` and `after` values, tx hashes, and `confirmed_at`, plus the listing's `kind = 'verification'` Call (request, response, status, `payment_tx_hash`, timestamps)
**And** the page renders the ERC-8004 agent id linked to the IdentityRegistry on the explorer, the registry listing id linked to `AgentDeskRegistry`, the price history as a table (timestamp, old price, new price, tx hash), the Reputation history as a line with one point per `reputation:` row, the Stake with its `stake:` and `slash:` rows, and the verification Call with its request and response JSON and tx hash
**And** an `execution` listing shows "listed by the platform without a verification Call", and an unknown id answers 404 `not_found`
**And** marketplace cards link to this page

### Story 5.5: Demo Split View

As a Builder,
I want to open a Run in a split view with the agent request and response log on the left and the money flow on the right,
So that a judge can watch agents talk and money move at the same time.

**Covers:** FR-43, FR-28 · AD-12, AD-13

**Acceptance Criteria:**

**Given** `/runs/<id>/split`
**When** the Builder opens it during or after a Run
**Then** the left pane lists each Call in Node order with Provider, status, elapsed time, and the request and response JSON (collapsed by default, expandable), appending rows as Calls advance
**And** the right pane shows, per paid Call, an arrow from the Builder's wallet to the payout wallet labelled with the amount as decimal tUSD and the tx hash link, and for a scored Call an arrow back to the Builder's wallet labelled with the Refund amount and the slash tx hash when the Settlement failed, with running totals of paid and refunded
**And** both panes consume the same `GET /api/runs/<id>` query polled every 2 s (Story 4.3's polling rule) so they update together without a reload
**And** the view shows the Run status, the mode, and the Emergency Stop badge in its header, and both panes are fully visible without horizontal scrolling in a 1280 × 720 viewport, which is the screen-recording size

## Validation Notes

- **Coverage:** every FR-1..FR-45 and NFR-1..NFR-10 appears in at least one story's Covers line; the FR Coverage Map names the primary epic and the three FRs split across epics (FR-1, FR-3, FR-25, FR-44).
- **Starter:** Story 1.1 sets up the pnpm monorepo and `apps/web` from `create-next-app`, as the spine's stack table fixes.
- **Schema landed once:** Story 1.4 creates the whole ER schema on day 1 instead of table-by-table. This is a deliberate exception to the create-only-what-you-need rule, taken from the spine's migrations convention ("one owner lands the ER schema on day 1, others add columns by PR") so that five people building in parallel never race on migrations. Later stories add only columns (Story 4.1 adds the `settlements` scoring columns).
- **Cross-epic dependencies (all backward):** Epic 2 needs Epic 1. Epic 3 needs Epic 1 and Story 2.1 (session); Story 3.7 needs Stories 2.3 and 2.10 (the :4107 instance and the demo stack). Epic 4 needs the worker loop of Story 2.9, the execution reference price of Story 2.8, and the per-Account wallets of Epic 3 for refunds. Epic 5 reads only tables and routes that Epics 1–4 created, including `GET /api/listings/<id>/history` from Story 4.4.
- **Within-epic order:** no story depends on a later story. Each agent story (2.3 to 2.6) extends `pnpm seed` to list its own Agent, so Stories 2.7 to 2.9 have Providers without waiting for Story 2.10; forward mentions ("Story 3.4 replaces this") are notes, not dependencies.
- **File churn:** `apps/web` and `apps/worker` are touched by every epic. The split is kept because each epic ends in a rehearsal that is a real feedback loop (paid Call, full Run, live listing, Slash) and because it matches the team split by files on day 2; consolidation was considered and rejected for that reason.
- **Deliberate divergence from a PRD bullet:** Story 2.8 has the engine enforce only the per-Workflow Order Cap and the 5 USDT minimum notional, not Emergency Stop or the global ceiling. This follows normative addendum §2 and AD-11 (the executor alone enforces those, as a paid `REJECTED`) and the patched FR-25 and FR-31; the older FR-25 bullet naming the engine as the Emergency Stop enforcer is superseded.
- **Readiness gate:** an adversarial trace-back review on 2026-09-06 returned CONCERNS with ten findings; all ten are resolved in this file (verification Calls excluded from scoring and from Stake reservation, worker heartbeat decoupled from the settlement loop, `execution` listings never verified from any path, seed listings moved into the agent stories, operator account lookup, `POST /api/listings/<id>/refresh`, `slash:` payload, `failed_after_payment` swept by the periodic tick, FR-8 locked-price clause, Epic 5 pages behind the signed-out guard).
- **Cut order:** Epic 5 first, then Epic 4 stories from 4.6 upward, then Epic 3 stories 3.6 and 3.7; Epics 1 and 2 are the demo's minimum.

