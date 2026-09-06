---
title: "Adversarial pair review: AgentDesk architecture spine"
reviewed: _bmad-output/planning-artifacts/architecture/architecture-agent-desk-2026-09-05/ARCHITECTURE-SPINE.md
lens: "Construct two units one level down that each obey every AD to the letter yet build incompatibly; every pair is a hole to close with a new or tightened AD."
inputs: [prd.md, addendum.md]
created: 2026-09-05
---

# Adversarial pair review

## Verdict

**Not build-safe yet. Fixable without touching the paradigm.** The dependency direction, the single signer, the intent-first chain writes, and the enum discipline are strong and foreclose most of the tempting clashes (listed at the end). The holes are almost all in **row ownership and lifecycle**: the spine names entities and statuses but not who inserts which row, which columns exist, and what happens to rows the happy path never reaches. Four of those are critical because two builders on the same day will each make a reasonable choice and integrate on day three with incompatible tables. Ten more are high because they sit on the day-one payment path (address case, price units, EIP-712 domain, persisted signatures) or on the demo-critical settlement path (tick cadence, stake reservation release).

Counts: **4 critical, 10 high, 13 medium, 11 low.** Ten Rules are unenforceable as written; most become enforceable with a Postgres role split, three eslint entries, and two branded types.

Recommended closure order: C1, C2, C3 (one fixed column list closes all three), C4 + H4 + H9 (one resumable `run.execute` design closes all three), then the rest of High as one-line tightenings.

---

## Critical

### C1. `POST /api/listings` vs `listing.verify` vs marketplace reader: the listing row before the chain write

- **Units:** web listing form handler (Stage 3); `listing.verify` job (Stage 3); marketplace and Workflow Builder listing queries (Stage 2/3/5).
- **What each obeys:** AD-2 says the `listings` row is "written only by `chainWrite` after a confirmed receipt, never by a UI handler". AD-8 keys the identity intent as `identity:<listing_id>`, so a `listing_id` must exist before any chain write. AD-5 says web enqueues.
- **Clash:** Builder A (web) inserts a `listings` row in status `verifying` from the handler because the job needs an id and the Creator needs to see progress. Builder B (worker) reads AD-2 literally, carries the form fields in the job payload, and **inserts** the row from the `list` receipt. Result on integration: a duplicate row or a duplicate-key error, and the marketplace query has three candidate filters (`status = 'active'`, `agent_id IS NOT NULL`, `verified_at IS NOT NULL`) because no pre-chain status exists. Also, a failed verification (FR-11 "specific error shown to the Creator") has nowhere to live under the literal Rule.
- **Proposed Rule (AD-2, replace the cache sentence):** "`POST /api/listings` inserts the `listings` row with `status = 'verifying'` and the form-owned columns (`name`, `description`, `type`, `endpoint`, `declared_price`, `declared_stake`, `payout_wallet`, `creator_account_id`) and publishes `listing.verify` with singleton key `listing_id`. `listing.verify` sets `status = 'failed'` with `verify_error` on any refusal, and the `list` receipt (through `chainWrite`) sets `status = 'active'`, `agent_id`, `registry_listing_id`, and the chain-owned columns. The chain-owned columns (`price`, `stake`, `reputation_bps`, `paused`, `payout_wallet`, `endpoint`) are written only by `chainWrite` and by `refreshListingFromChain()` (see M5), never by a handler. Listing statuses are exactly `verifying`, `failed`, `active`, `paused`; marketplace, Workflow Builder, and Price Lock read only `active` and `paused`."

### C2. Web run handler vs `run.execute` vs Run view: who inserts Call rows, and the row schema itself

- **Units:** `POST /api/runs` (Stage 2 web); `run.execute` (Stage 1 worker); `GET /api/runs/<id>` and the dashboard (Stage 2/5).
- **What each obeys:** AD-4 says web "inserts the Run" and "every Run and Call status transition happens in the worker"; AD-3 counts `pending` Calls of `running` Runs as reserved spend.
- **Clash 1 (creation):** Engine builder creates each `calls` row lazily when the Node starts (insert is not a "transition", so this obeys AD-4). Then AD-3's reservation counts zero for a just-started Run, FR-3's "reserved at Price Lock time" is silently false, and two Runs of one account pass the budget check together. Web builder, reading FR-3, inserts one `pending` Call per Node at Run insert. Both cannot be true; the worker's lazy insert collides with rows that already exist.
- **Clash 2 (never reached):** on `failed at research`, the Calls for `risk`, `execution`, and `notify` are either absent (lazy) or stuck in `pending` forever (eager). The Run view for a finished Run shows "pending" Nodes in one implementation and missing Nodes in the other. PRD FR-28's status list has no "not reached" value.
- **Clash 3 (columns):** the spine names `payment_required`, tx hash, `reference_price`, `reference_at`. The Run view needs request, response, node type, provider, locked price, timestamps, and a failure reason (FR-28, FR-29). Five people will add `error`, `reason`, `failure_reason`, `error_message`, `request_body`, `input`, and so on to the same Drizzle file on different branches.
- **Proposed Rule (AD-4, add):** "`POST /api/runs` inserts the Run and, in the same transaction, one `calls` row per Node in `pending` with `node_index`, `node_type`, `listing_id`, `locked_price`, `locked_pay_to`. The worker only transitions rows. When a Run ends, the engine sets every Call still `pending` to `skipped` with `skip_reason = 'not_reached'` (chain-rule skips carry `skip_reason = 'hold'` or `'reject'`), so no Call on an ended Run is `pending`. Fixed column set: `calls(id, run_id?, listing_id, kind, node_index, node_type, status, locked_price, locked_pay_to, request, response, payment_required, payment_payload, payment_tx_hash?, reference_price?, reference_at?, failure_reason?, skip_reason?, attempt, started_at?, ended_at?)`; `runs(id, workflow_id, account_id, wallet_id, status, price_lock, failure_reason?, created_at, started_at?, ended_at?)`. Nothing else is added without a spine update."

### C3. Engine vs FR-40 payments view: the `PAYMENT` entity that nobody writes

- **Units:** `run.execute` (Stage 1); payments view (Stage 5).
- **What each obeys:** AD-3 says the Call row records the x402 tx hash and lists "payments" among bound entities; the ER diagram has `CALL ||--o| PAYMENT : paid_by`.
- **Clash:** Engine builder stores the tx hash on `calls` (the AD-3 sentence) and never creates a `payments` table. Dashboard builder scaffolds `payments(call_id, from, to, amount, status, tx_hash)` from the ER diagram and FR-40's column list, and reads an empty table on demo day. Two owners of one entity, one of them imaginary.
- **Proposed Rule (AD-3, add):** "There is no `payments` table. A payment is the Call row: `from` is the Run's wallet address, `to` is `locked_pay_to`, `amount` is `locked_price`, status is the Call status, hash is `payment_tx_hash`. FR-40 is a query over `calls` joined to `runs` and `listings`." Remove `PAYMENT` from the ER diagram.

### C4. `settlement.tick` timeout sweep vs an in-flight `run.execute`: two writers of one Run, and nobody notifies

- **Units:** `settlement.tick` (Stage 4); `run.execute` (Stage 1/2).
- **What each obeys:** AD-4: the engine checks the deadline "before each Node and each paid retry"; the tick "marks any `running` Run older than 120 s as `timed out`"; `notify` runs on every Run end "with an engine-built input".
- **Clash 1 (overwrite):** a paid retry started at t = 115 s legally runs until t = 145 s (15 s + 15 s). At t = 120 s the tick sets `timed out`. At t = 145 s the engine, holding the Run in memory, writes `completed` through `machine.ts` (`running → completed` is a legal transition from the state it last read). The `timed out` write is lost, or, in the other implementation, the `completed` write is lost and a paid, filled order belongs to a "timed out" Run.
- **Clash 2 (double execution):** the partial unique index frees at `timed out`, so a second Run of the same Workflow starts at t = 121 s while the first is still paying agents. This is exactly what AD-4 says it prevents.
- **Clash 3 (notify):** the tick owner assumes the engine notifies on timeout; the engine owner assumes the tick does (it set the status). The `timed out` Run either never notifies (both assume the other) or notifies twice. The tick cannot build the notify input without the engine, and AD-9 forbids it from calling agents.
- **Proposed Rule (AD-4, replace the timeout sentences):** "Every Run status write is a compare-and-set from `running` (`UPDATE runs SET status = $1 WHERE id = $2 AND status = 'running'`); a write that affects zero rows means another writer ended the Run, and the engine records the in-flight Call's outcome, runs nothing further, and exits. `settlement.tick` sets `timed out` only for `running` Runs whose `started_at` is older than 120 s plus a 45 s grace for an in-flight paid retry, and then publishes `run.execute` for that `run_id` with `{ phase: 'finalize' }`. `run.execute` on a Run that is no longer `running` performs only the terminal filter: it resolves any `paid_awaiting_result` Call (H4), sets `not_reached` skips (C2), and runs `notify` once, guarded by the `notify` Call's own `pending → ...` transition so it cannot run twice. The unique index on `runs(workflow_id) where status = 'running'` therefore frees only after the engine has exited or the grace period has passed."

---

## High

### H1. Web builds the Price Lock, engine compares it to `accepts`: normalisation

- **Units:** `POST /api/runs` (builds lock from the listings cache, lower-case addresses per AD-13); `adapters/x402` + `core/run` (compares to the 402 `accepts` entry per AD-6).
- **Clash:** the cache stores `0xabc...` lower-case; the agent's `AGENT_PAYTO` is `0xAbC...` checksummed; the engine compares strings and records `price_mismatch` on every Call. Same for `asset`. And `amount`: `"50000"` vs `"050000"` or a number. And a 402 may carry several `accepts` entries; one engine takes `[0]`, another searches.
- **Proposed Rule (AD-6, add):** "The engine selects the first `accepts` entry whose `scheme`, `network`, and `asset` (compared with `isAddressEqual`) match the lock; none matching is `price_mismatch`. It then compares `payTo` with `isAddressEqual` and `amount` as `bigint`. `network` is compared as an exact string. Both compared values are written to `calls.payment_required` and `calls.failure_reason` on mismatch."

### H2. `createAgent({ price })` and `AGENT_PRICE` units vs the listing form and the lock

- **Units:** `packages/agent-kit` (Day 1, engine builder or agent builder); `apps/agents/*` env files; listing form (Stage 3).
- **What each obeys:** AD-13 says the x402 `amount` field is base-unit integer strings; addendum §2 lists prices as decimal USDT; the listing form takes "price per call in USDT".
- **Clash:** kit A takes `price` as decimal `"0.05"` and converts; kit B passes `price` through to `amount` verbatim, so an agent with `AGENT_PRICE=0.05` emits `amount: "0.05"` and every 402 is a `price_mismatch`, while an agent with `AGENT_PRICE=50000` works against kit B and mis-prices by 10^6 against kit A.
- **Proposed Rule (AD-13, add):** "`AGENT_PRICE`, `createAgent({ price })`, the listing form, and every Type payload carry decimal USDT strings. `packages/schemas` exports `toBaseUnits(decimal): bigint` and `toDecimalUsdt(base): string` over one `TUSD_DECIMALS = 6` constant, plus branded types `BaseUnits` and `UsdtDecimal`; these are the only conversions in the repo, and the kit converts to base units when it builds the 402."

### H3. `TUSD.sol` vs agent-kit `accepts[].extra` vs facilitator: the EIP-712 domain

- **Units:** `contracts/TUSD.sol` (Day 1 contracts); `packages/agent-kit` 402 construction (Day 1 agents); `apps/facilitator` supported-asset config.
- **What each obeys:** AD-6 fixes scheme, network, and the asset address from `deployments/97.json`. Nothing fixes the EIP-712 domain `name` and `version` the `exact` EVM scheme signs and verifies.
- **Clash:** the contract constructor says `EIP712("Test USD", "1")`; the kit publishes `extra: { name: "tUSD", version: "2" }` (or nothing, so `@x402/evm` uses its default for USDC); the facilitator verifies the signature against the contract and every payment fails with an opaque "invalid signature".
- **Proposed Rule (AD-6, add):** "`forge script` writes `deployments/97.json` with `tusd: { address, name, version, decimals }` and `registry`, `identityRegistry` addresses. Agent-kit fills `accepts[].extra.name` and `.version` from that file; the facilitator lists the same asset from the same file. `forge test` asserts `eip712Domain()` returns those values, and a kit unit test asserts the 402 `extra` equals them. The public schema page prints `name` and `version` for third-party agents."

### H4. AD-6's `authorizationState` check vs AD-3's Call columns vs pg-boss retry: the signature that is never persisted

- **Units:** `core/signing` + `adapters/x402` (sign and send); `calls` schema (AD-3 column list); pg-boss job configuration.
- **What each obeys:** AD-6 says both paid attempts failing leads to `tUSD.authorizationState(from, nonce)`; conventions say "a payment signature is never regenerated". AD-3's Call row records the 402 payload and the tx hash, not the signed payload.
- **Clash:** the nonce lives inside the `PAYMENT-SIGNATURE` payload the `@x402/evm` client generated in memory. Engine A stores nothing and cannot implement the `authorizationState` read; it records `payment_failed`, and the tUSD may settle later (the facilitator's relayer had already broadcast it), giving a paid-and-not-recorded Call. Engine B stores the payload. Separately: pg-boss retries a failed `run.execute` (default `retryLimit` is non-zero in current versions), and the retried job re-enters the Run with a Call in `paid_awaiting_result`; without the stored payload it signs again, violating the convention with no test to catch it.
- **Proposed Rule (AD-6, add; AD-4, add):** "`core/signing.signPayment` writes the decoded signed payload (including `nonce`, `validBefore`, `from`, `to`, `value`) to `calls.payment_payload` and transitions the Call to `paid_awaiting_result` in the same transaction before the paid request is sent. `run.execute` is resumable: on entry it loads the Run; a Call in `paid_awaiting_result` with `attempt < 2` is resent once with the stored header; otherwise it is resolved through `authorizationState`. `run.execute` is registered with `retryLimit: 2` and this resumption is the only retry path."

### H5. `wallet.create` vs `pnpm seed` vs AD-8's closed key list: gas for the approve, and mints

- **Units:** `wallet.create` job (Stage 3); `pnpm seed` (Structural Seed); `chainWrite` key list (AD-8).
- **What each obeys:** AD-5: `wallet.create` "generates the key, stores the wallet row, and sends the one-time `tUSD.approve(registry, max)`". Seed "creates accounts through `wallet.create`, mints tUSD into them".
- **Clash 1:** a freshly generated wallet holds zero BNB. `wallet.create` sends `approve` and it fails on gas (or sits unsent), leaving `chain_tx approve:<wallet_id>` `pending` forever; the seed funds BNB after the job returns, and no unit ever re-sends the approve because the intent row exists. Every Creator's first `list()` then reverts on allowance.
- **Clash 2:** AD-8 says "One intent key per transaction" and lists eight keys; minting and gas funding are not among them. The seed author either invents `mint:<wallet_id>` (a ninth key, obeying the spirit) or sends raw viem transactions outside `chainWrite` (obeying the letter of the list). The second breaks `pnpm doctor`'s nonce accounting and AD-5's per-wallet mutex on the Platform Wallet.
- **Proposed Rule (AD-5 and AD-8, add):** "`wallet.create` runs three intents in order from the Platform Wallet then the new wallet: `gas:<wallet_id>` (BNB top-up to `WALLET_GAS_FLOOR`), `mint:<wallet_id>` (tUSD mint of `WALLET_SEED_TUSD`, which is 0 outside demo mode), and only after both receipts `approve:<wallet_id>` signed by the new wallet. `wallets.ready_at` is set from the approve receipt; `POST /api/listings`, `POST /api/runs`, and `listing.write` answer 409 `wallet_not_ready` until it is set, and the UI polls `ready_at`, not row existence. The AD-8 key list gains `gas:` and `mint:`; there is no chain write outside `chainWrite` in any process except the facilitator."

### H6. AD-3 stake reservation vs `settlement.tick` row policy for `not_scored`

- **Units:** `core/budget` reservation query (Stage 4, FR-25); `settlement.tick` (Stage 4), possibly the same builder on different days.
- **What each obeys:** reservation counts "locked prices of unscored `research` and `risk` Calls". FR-34: "REJECT decisions are not scored". AD-9: result in `passed`, `failed`, `not_scored`.
- **Clash:** tick A writes a `not_scored` row for every REJECT `risk` Call at window end; tick B writes no row ("not scored" read as "no settlement"). Under B, "unscored" never becomes false for REJECT Calls, so Guardrail Risk (stake 0.20, price 0.02) reserves 0.02 per REJECT and refuses with "stake exhausted" after ten rehearsal Runs of the sloppy chain. Same ambiguity for a `succeeded` `research` Call in a Run that later timed out, and for Calls left in `paid_awaiting_result`.
- **Proposed Rule (AD-9, add; AD-3, tighten):** "Every `research` or `risk` Call that reaches `succeeded` or `failed_after_payment` receives exactly one `settlements` row: `passed`, `failed`, or `not_scored` (with `reason` in `reject_decision`, `no_fill`, `no_reference_price`). Reservation counts Calls of the Listing in `paid_awaiting_result`, `succeeded`, or `failed_after_payment` that have no `settlements` row. A `risk` Call whose Run has ended without a `FILLED` execution result is written `not_scored` on the first tick after the Run ends, not at window end."

### H7. `packages/schemas` samples vs `listing.verify` vs the schema page: the `notify` sample's chat id

- **Units:** `samples` in `packages/schemas` (Day 1); `listing.verify` (Stage 3); public schema page (Stage 1).
- **What each obeys:** AD-6: the schema page renders "the shared `samples`". FR-11: verification uses "the Type's sample input". Addendum §1: the `notify` verification sample "carries the Platform Account's chat id". Conventions: `PLATFORM_CHAT_ID` lives only in the worker; `packages/schemas` imports nothing and has no env.
- **Clash:** schemas ships `recipient.address: "123456789"`; `listing.verify` sends the sample verbatim; Telegram rejects the chat; the notifier returns 500 (unsettled); verification of the Telegram Notifier fails and FR-44 ("all Seed Agents except `execution` pass verification") is false on seed day. The other builder patches the address in the job and the two disagree on whether `samples` are literal.
- **Proposed Rule (AD-6/AD-7, add):** "`samples[type].in` are literal for `data`, `research`, `risk`, `execution`; for `notify`, `listing.verify` replaces `recipient.address` with `PLATFORM_CHAT_ID` and `run_id` with `null` before sending, and the schema page shows the literal placeholder. The verification Call for `notify` is expected to deliver a real message to the Platform chat."

### H8. Agent-kit replay cache vs the engine's same-header retry: the handler that runs twice

- **Units:** `packages/agent-kit` middleware ordering and cache; `adapters/x402` retry; `apps/agents/spot-executor`.
- **What each obeys:** AD-6: "the paid request is retried at most once with the same header, and agent-kit replays the cached 200 for a repeated `PAYMENT-SIGNATURE` for five minutes"; the middleware "verifies, runs the handler, then settles".
- **Clash:** kit A caches only on a sent 200. The engine's paid timeout is 15 s, the facilitator's `settle` awaits a receipt (conventions allow up to 60 s), so the retry arrives while attempt 1 is inside `settle`: verify passes (nonce not yet used), the handler runs a second time, and `spot-executor` places a second order. When `settle` fails after a successful handler (RPC blip), the same happens on the retry. Kit B keeps an in-flight promise per signature. Both obey the text.
- **Proposed Rule (AD-7, add):** "Agent-kit keys an entry on the `PAYMENT-SIGNATURE` value at request receipt; a second request with the same header awaits the first attempt's promise and returns its outcome. The handler's output is cached for five minutes even when `settle` fails, and a retry after a failed `settle` re-attempts `settle` with the cached output instead of re-running the handler. The cache is per process and in memory; two replicas of one agent are out of scope."

### H9. Mode constants (2 s poll) vs `settlement.tick` as a pg-boss scheduled job

- **Units:** `packages/core` mode table (Stage 4); worker job registration (Stage 1 scaffolding).
- **What each obeys:** AD-9: "`settlement.tick` runs every poll interval of the current mode". Conventions list `settlement.tick` as a pg-boss job name.
- **Clash:** the scaffolding builder registers `boss.schedule('settlement.tick', '* * * * *')`; pg-boss cron is minute-granular, so in demo mode the 20 s window is scored up to 60 s late and the slash misses the 2:20 mark in the demo script. The mode-table builder assumes a 2 s loop. Neither reads the other's file.
- **Proposed Rule (AD-9, replace the first clause):** "The worker runs the settlement loop in-process: a `setTimeout` chain that re-reads `platform_settings.mode` each iteration and sleeps the mode's poll interval, calling `runSettlementTick(db, {})`. pg-boss carries only targeted sends, `settlement.tick { call_id }` for immediate scoring and `run.execute { phase: 'finalize' }` (C4), and both call the same `runSettlementTick`. The loop and the targeted job share the unique index on `settlements(call_id)` and treat a unique violation as 'already settled'."

### H10. `spot-executor` internal routes vs `adapters/exchange` vs web's `/internal/settings`: unspecified JSON shapes and units

- **Units:** `apps/agents/spot-executor` (Stage 2); `packages/adapters/exchange` (Stage 2, possibly another builder); web `GET /internal/settings` (Stage 2 operator work).
- **What each obeys:** AD-11 names the routes; AD-10 names `order_ceiling` "default 1000 USDT"; the ER diagram types it `text`.
- **Clash:** `/internal/balance` returns `{ balance_usdt }` in one build and the raw Binance `balances[]` array in another; the engine's `risk` input then carries `undefined`. `/internal/settings` returns `{ emergency_stop, order_ceiling }`, where one builder stores the ceiling in base units (AD-13: token amounts are base units) and the executor compares `size_usdt` `"60"` against `"1000000000"` and never rejects, or against `"1000"` and works. On web unreachable, one executor fails open and places the order.
- **Proposed Rule (AD-11, add):** "`packages/schemas` defines `InternalBalance { balance_usdt: UsdtDecimal }` (free USDT), `InternalOrder { order_id: string, raw: unknown }`, and `InternalSettings { emergency_stop: boolean, order_ceiling_usdt: UsdtDecimal }`; the executor, `adapters/exchange`, and the web route validate against them. The order ceiling is an order size, a decimal USDT string, stored in `platform_settings.order_ceiling_usdt`. The executor answers `REJECTED` with reason `settings unavailable` when `/internal/settings` fails or is older than 10 s in its cache. The internal base URL of the executor is `SPOT_EXECUTOR_INTERNAL_URL` in web and worker env, never derived from the listing's endpoint."

---

## Medium

### M1. Engine vs executor on Emergency Stop: `failed at execution` or `completed, no order`

- **Units:** `core/run` pre-payment checks; `spot-executor`.
- **Clash:** PRD FR-25 says the engine checks Emergency Stop before paying; FR-31 and AD-11 say the executor answers `REJECTED`. Engine A implements FR-25 and the Run ends `failed at execution` with no order and no execution payment; engine B does not, and the Run ends `completed, no order` after paying 0.01. The dashboard, the notify summary, and the demo narrative differ.
- **Proposed Rule (AD-11, add):** "The engine does not read Emergency Stop. Before paying `execution` it enforces only the Order Cap and the exchange minimum notional. Emergency Stop and the global ceiling are enforced by the executor alone, always as a paid, schema-valid `REJECTED`."

### M2. `completed` vs `completed, no order`; the `<Node>` token in `failed at <Node>`

- **Units:** `core/run/machine.ts`; Run feed and filters (Stage 5).
- **Clash:** a REJECTED fill, a skipped `execution`, and a Workflow without an `execution` Node each get `completed` or `completed, no order` depending on the builder. `failed at <Node>` is stored as `failed at research`, `failed at Alpha Research`, or `failed at node 2`.
- **Proposed Rule (AD-4, add):** "A Run ends `completed` only when an `execution` Call returned `FILLED`, or when the Workflow has no `execution` Node; every other successful end is `completed, no order`. `<Node>` is the Type name (`failed at research`). `runs.failure_reason` carries the human reason."

### M3. Risk rule inputs: which `reference_price` is `p_fill`, and when `not_scored`

- **Units:** `core/settlement` risk rule; `run.execute` reference-price capture.
- **Clash:** AD-9 says "takes the start price from the Call's `reference_price`". For `risk`, builder A uses the risk Call's own `reference_price` (seconds before the fill); builder B uses the execution Call's `reference_price` (addendum: "production `lastPrice` at fill time"). Drawdown differs and a borderline 2 percent flips.
- **Proposed Rule (AD-9, add):** "For a `risk` Call, `p_fill` is the `reference_price` of the same Run's `execution` Call whose response is `FILLED`; absent that, the result is `not_scored` with reason `no_fill`. For a `research` Call the start price is its own `reference_price`. The window starts at `calls.ended_at` of the scored Call."

### M4. `AgentDeskRegistry.sol` vs `adapters/chain`: where `listingId` comes from, `callRef`'s type, and the ABI

- **Units:** contracts (Day 1); `adapters/chain` (Day 1/3).
- **Clash:** the contract returns `listingId` from `list()` and emits `Listed(listingId, agentId, creator)`; the adapter expects `ListingCreated` or reads the return value (not available from a receipt). `callRef` is `bytes32` in the contract and the adapter passes the ULID string. The adapter hand-writes the ABI and misses an overload.
- **Proposed Rule (AD-2/AD-8, add):** "`pnpm --filter contracts build` exports the Foundry ABI JSON for `AgentDeskRegistry`, `TUSD`, and the ERC-8004 `IdentityRegistry` into `packages/adapters/chain/abi/`; adapters import only those. Events: `Listed(uint256 indexed listingId, uint256 indexed agentId, address indexed creator)`, `StakeChanged(listingId, stake, paused)`, `PriceChanged(listingId, price)`, `Slashed(listingId, bytes32 callRef, amount, to, stake, paused)`, `ReputationSet(listingId, bps)`. `callRef = keccak256(utf8(call_id))`. `listings.registry_listing_id` is decoded from `Listed` in the `list` receipt."

### M5. Three writers of the listings cache: `chainWrite`, the "read from chain" refresh, and the slash

- **Units:** listing detail refresh route (Stage 5 web); `chainWrite` receipt handling; `settlement.tick` after slash.
- **Clash:** AD-2 says the cache is written "only by `chainWrite`" and, in the same paragraph, that the detail page's refresh "overwrites the cache" (a web write). `chainWrite(intentKey, buildTx)` has no hook to know which listing a `slash:<call_id>` receipt touches; builder A adds an `onReceipt` callback per intent, builder B updates the row in the calling job after the receipt, which violates the literal text.
- **Proposed Rule (AD-2, replace):** "The chain-owned columns of `listings` are written by one function, `refreshListingFromChain(listingId)` in `packages/db`, which reads `getListing` and overwrites them. It is called by `chainWrite` after every receipt whose intent names a listing (`identity:`, `list:`, `stake:`, `price:`, `pause:`, `slash:` via the Call's listing, `reputation:`), by the detail page's refresh route, and by nothing else. No column is derived from event arguments except `registry_listing_id` (M4)."

### M6. `listing.write` intent payload vs the agent detail price history

- **Units:** `listing.write` (Stage 3); Agent detail page (Stage 5).
- **Clash:** the price history "read from `chain_tx` rows with `price:` keys" needs old price, new price, and timestamp (FR-9). The job stores `{ price }` and increments `<n>` as a per-listing count; the page expects `{ old_price, new_price }` and orders by `<n>` numerically, while another job uses a millisecond timestamp for `<n>` because a count needs a query. The initial price lives only in the `list:` row under a different payload shape.
- **Proposed Rule (AD-8, add):** "`<n>` is the epoch millisecond at enqueue. Every listing intent payload is `{ listing_id, before: { price, stake, paused }, after: { price, stake, paused } }` captured from the cache at enqueue; `list:` payloads carry `before` as nulls. History readers order by `chain_tx.confirmed_at`."

### M7. Cross-field validation and unknown request fields: engine or kit

- **Units:** `core/run` output validation; `agent-kit` request and response validation.
- **Clash:** `size_usdt <= proposed_size_usdt`, `size_usdt <= balance_usdt`, `"0"` on REJECT, and the FILLED/REJECTED required fields are rules across input and output that a Zod output schema cannot see. Engine A checks them (violation is `failed_after_payment`, the risk agent is slashed); engine B does not, and the Order Cap check later fails the `execution` Call before payment (`failed at execution`, the risk agent keeps its fee). Separately, kit A declares input schemas `.strict()`; the engine adds a `run_id` tracing field; every paid request is a 400.
- **Proposed Rule (AD-7, add):** "`packages/schemas` exports `validateOutput(type, input, output)` implementing every addendum §1 rule, including the cross-field ones and the FILLED/REJECTED conditional fields; both the engine and agent-kit call it, so a violation is a 500 at the agent and `failed_after_payment` at the engine if it slips through. All Type schemas ignore unknown fields in both directions (`z.object(...).loose()`)."

### M8. `deployments/97.json` inside agent containers vs "env holds chain addresses"

- **Units:** agent Dockerfiles and agent-kit boot; worker and web boot.
- **Clash:** conventions say "chain addresses from `deployments/97.json` only, never inline"; AD-10 says env holds "secrets, URLs, and chain addresses". Agent-kit A reads the file relative to the repo root and crashes in a container whose build context copied only `apps/agents/x`; agent-kit B takes `AGENT_ASSET_ADDRESS` from env and drifts from the worker after a redeploy.
- **Proposed Rule (Conventions, replace):** "`packages/schemas/deployments.ts` imports `deployments/97.json` at build time and exports it typed; every in-repo process, agents included, reads addresses from that export, selected by `CHAIN_ID`. No in-repo env variable carries a contract address. Third-party agents copy the address from the schema page."

### M9. `GET /internal/settings` path and the web auth middleware

- **Units:** web route file layout and iron-session middleware; `spot-executor` client.
- **Clash:** conventions say API routes are `/api/<resource>`; AD-10 says `GET /internal/settings` on the web API. One builder mounts `/api/internal/settings`, the other calls `/internal/settings`. Whichever exists, the session middleware returns 401 unless the path is exempted, and the public-route list does not mention it.
- **Proposed Rule (Conventions, add):** "Internal routes on web are `/api/internal/*`, exempt from session auth and guarded only by `INTERNAL_TOKEN` in the `Authorization: Bearer` header; the same header convention applies to agent `/internal/*` routes. The route table becomes: public `/schema`, `/api/listings/<id>/agent.json`, `/api/settings/public`; internal `/api/internal/*`; everything else session-authenticated."

### M10. Unknown tx hash in the `notify` payload

- **Units:** engine notify-input builder; `telegram-notifier` and the `notify` Zod schema.
- **Clash:** AD-6 marks a settled-but-unreceipted payment's hash "unknown". Engine A emits `tx_hash: null`; the schema says `string`; the notifier's kit validation returns 400; the failure notification itself fails. Engine B emits `"unknown"` and the message shows a broken explorer link.
- **Proposed Rule (addendum §1 and AD-6, add):** "`calls.payment_tx_hash` is nullable. In the `notify` input, `cost_table[].tx_hash` is optional and omitted when unknown; `tx_hashes[]` lists only known hashes. The notifier renders a missing hash as 'settled, hash pending'."

### M11. Market-data port shape and a null `reference_price`

- **Units:** `core/ports/MarketData` as written by the Stage 1 engine builder (needs `lastPrice`) and extended by the Stage 4 settlement builder (needs `ticker24h`, `klines`); `run.execute` on a failed read.
- **Clash:** two method sets on one port, two adapters. And when the 5 s read fails, engine A fails the Call, engine B stores null; the tick then divides by null in production mode.
- **Proposed Rule (AD-3 and AD-9, add):** "`MarketData` is `lastPrice(symbol) -> { price: UsdtDecimal, ts }`, `ticker24h(symbol) -> data.out`, `klines(symbol, interval, from, to) -> { open_time, high, low, close }[]`, defined in `packages/core/ports` on day one. A failed `lastPrice` read leaves `reference_price` null and the Call `succeeded`; the production research and risk rules then write `not_scored` with reason `no_reference_price`, and the demo research rule scores anyway since it needs no start price."

### M12. `started_at` owner and `run.execute` concurrency

- **Units:** `POST /api/runs`; worker job options.
- **Clash:** web sets `started_at` at insert (FR-39 shows a start time immediately); the worker sets it at pickup. The 120 s deadline and the 45 s NFR shift by the queue wait. With pg-boss default `batchSize`/concurrency of one for the queue, the warm-up Run blocks Linh's Run.
- **Proposed Rule (AD-4, add):** "`runs.created_at` is set by web at insert and shown as the feed time; `runs.started_at` is set by the worker at job pickup and anchors the 120 s deadline; the tick's sweep uses `coalesce(started_at, created_at)`. `run.execute` is registered with concurrency 4; Runs of different Workflows execute in parallel, Runs of one Workflow are serialised by the unique index."

### M13. Kit 8 s budget vs alpha-research's own 8 s LLM timeout

- **Units:** `agent-kit` handler budget enforcement; `alpha-research` handler.
- **Clash:** kit A enforces the budget with a race and answers 500 at 8.000 s; the agent's LLM timeout fires at 8.000 s and its HOLD fallback loses the race by milliseconds. The fallback never triggers, the Call becomes `payment_failed`, and the demo's "LLM down" story fails.
- **Proposed Rule (AD-7, tighten):** "Agent-kit enforces a 10 s handler budget and answers 500 on expiry. Handlers keep their own external timeouts at or below 8 s; `alpha-research` uses 8 s and its fallback is `{ signal: 'HOLD', confidence: 0.5, reason: 'LLM unavailable; defaulting to HOLD.' }`."

---

## Low

### L1. Web budget check is not atomic across concurrent Runs of one account

- **Units:** two concurrent `POST /api/runs` for different Workflows of one account.
- **Clash:** both pass the by-query check, both insert; the signer's later check refuses mid-Run with no matching Call status.
- **Proposed Rule (AD-4, add):** "The budget check and the Run insert run in one transaction that takes `SELECT ... FOR UPDATE` on the `accounts` row. A signer refusal mid-Run records `payment_failed` with `failure_reason` `refused_budget`."

### L2. Mode switch mid-window

- **Clash:** a Call scored under the mode at tick time versus the mode at Call time; the settlement view must show "mode" (FR-41).
- **Proposed Rule (AD-9, add):** "The mode read at tick time governs; `settlements.mode` and `settlements.rule_label` record what was applied."

### L3. Default Daily Fee Budget semantics

- **Clash:** operator changes the default; one build copies it at sign-up, another treats `NULL` as "use default".
- **Proposed Rule (AD-10, add):** "`accounts.daily_fee_budget` is nullable; `NULL` means the platform default at check time; the seed sets an explicit 100 USDT on demo accounts."

### L4. Seed mechanics: execution listing without verification, the `platform_settings` row, the running worker

- **Clash:** `listing.verify` has no skip path, so the seed either adds a payload flag or bypasses the job; both the migration and the seed insert the singleton settings row; the seed enqueues jobs with no worker running and hangs.
- **Proposed Rule (Structural Seed, add):** "The migration inserts `platform_settings` row `id = 1` with defaults and `platform_account_id = NULL`; the seed updates it. `listing.verify` accepts `{ listing_id, skip_verification: true }`, set only by the seed for `execution`. `pnpm seed` requires a running worker and waits by polling rows with a 120 s timeout."

### L5. `PUBLIC_BASE_URL` at seed time versus the day-3 tunnel; `--reset` and idempotent identity keys

- **Clash:** seeded `agentURI`s point at `localhost:3000`; `identity:<listing_id>` is idempotent so a re-seed never re-registers.
- **Proposed Rule (AD-2, add):** "`pnpm seed --reset` truncates every table including `chain_tx` and registers fresh identities; `pnpm doctor` fails when `PUBLIC_BASE_URL` is a loopback or Docker-internal host and any `identity:` row exists."

### L6. Reputation denominator and "no score yet"

- **Clash:** `not_scored` rows counted in the denominator by one builder; bps `0` rendered as "0 percent" instead of "no score yet".
- **Proposed Rule (AD-9, add):** "Reputation = `passed / (passed + failed)` over the last 30 rows with result in (`passed`, `failed`); the marketplace label derives from that count (zero rows means 'no score yet'), never from `reputation_bps` alone."

### L7. Manual pause and auto-pause share one contract flag

- **Clash:** a Creator's manual pause is cleared by any `addStake` that reaches the minimum.
- **Proposed Rule (Structural Seed contract surface, add):** "`addStake` clears `paused` only when the pause was set by `slash`; a creator-set pause is cleared only by `setPaused(false)`." Or accept and document.

### L8. Missing error code for the partial unique index

- **Proposed Rule (AD-4, add):** "A unique violation on `runs(workflow_id) where status = 'running'` is answered 409 `run_in_progress`."

### L9. `/internal/orders/<order_id>` needs a symbol

- **Clash:** Binance `GET /api/v3/order` requires `symbol`; the route as named cannot call it without assuming one.
- **Proposed Rule (AD-11, add):** "`GET /internal/orders/<order_id>?symbol=BNBUSDT`; `symbol` is required."

### L10. Notifier: two long pollers on one token

- **Clash:** a developer's local notifier plus the compose one both `bot.start()`; Telegram answers 409 and `/start` stops working in the demo.
- **Proposed Rule (Conventions, add):** "Long polling is enabled only when `AGENT_TELEGRAM_POLL=true`, set only in the compose env."

### L11. The second `sloppy-research` at :4107 needs the demo Creator's address before it exists

- **Proposed Rule (Structural Seed, add):** "`pnpm seed` writes `.env.seed` with `AGENT_PAYTO` for :4107 and the demo account credentials; compose includes it, and the seed's last step restarts that container."

---

## Foreclosed pairs (tempting, but the spine already closes them)

- **agent-kit vs `adapters/x402` on x402 version, scheme, headers, and payload shape:** both are the same `@x402/*` packages at one pinned version; only the domain config (H3) and units (H2) leak.
- **`settlement.tick` vs `run.execute` writing Call status:** the tick writes only `settlements`; the only shared write is the Run timeout (C4).
- **Double slash across overlapping ticks:** closed by `slash:<call_id>` plus the unique index on `settlements(call_id)`, provided both units treat a unique violation as "already done" (H9 says so explicitly).
- **Web budget check vs signer budget check double-counting the current Call:** AD-3's status list includes `pending` and `paid_awaiting_result`, so the count is the same before and after signing.
- **Two Runs of one Workflow at insert time:** the partial unique index closes it; only the timeout release reopens it (C4).
- **Verification response validation vs engine output validation:** one Zod schema in `packages/schemas`.
- **Facilitator vs agent-kit `/verify` and `/settle` shapes:** same packages.
- **Price Lock field shape:** owned by `packages/schemas`; only the comparison is loose (H1).
- **Platform Wallet daily verification cap:** by query over verification Calls, same as the account budget.

---

## Rules that are unenforceable as written

| Rule | Why no test or lint can detect a violation | What would make it enforceable |
| --- | --- | --- |
| AD-3 "derived amounts are never stored" | A column named `spent_today` is indistinguishable from a fact to a linter | Fix the column list (C2) and add a schema test that fails on any column outside it |
| AD-4 "The web app reads and never updates these rows" | Web and worker share one Postgres role | Two roles: `web_role` with INSERT on `runs`, `calls`, `accounts`, `workflows`, `listings`, UPDATE on `platform_settings` and form-owned columns, SELECT elsewhere; `worker_role` full. The DB refuses a violation |
| AD-2 "written only by `chainWrite`, never by a UI handler" | Same as above, and the refresh action contradicts it | Role split plus M5's single refresh function |
| AD-5 "Only `apps/worker` constructs it" | No lint entry names `core/signing` | Add `core/signing` to `no-restricted-imports` for every package but `apps/worker`; likewise `@anthropic-ai/sdk` for every package but `alpha-research` and `@binance/spot` for every package but `spot-executor` |
| AD-6 "One signature per Call ... never regenerated" | Without a persisted payload there is nothing to compare | H4's `payment_payload` column plus a unit test that a resumed `run.execute` resends the stored header byte-for-byte |
| AD-6 `reference_at` "within five seconds of success" | Wall-clock timing | Test with a fake clock that the engine aborts the read at 5 s and stores null (M11) |
| AD-7 "Handlers have an 8 s budget" | Advisory unless the kit enforces it | M13 makes the kit enforce it |
| AD-10 "the worker reads it on every job tick and the API on every request" | A memoised settings module would pass every test | Forbid a settings cache by convention and give `readSettings()` a single implementation with no module-level state; a test flips the row and asserts the next call sees it |
| AD-12 "No server push anywhere" | Nothing scans for it | CI grep for `text/event-stream`, `EventSource`, `WebSocket`, `socket.io` outside `node_modules` |
| AD-13 decimal versus base-unit strings | Zod sees `"50000"` and `"0.05"` as equally valid strings | H2's branded `BaseUnits` and `UsdtDecimal` types; the compiler refuses to pass one where the other is expected |
| AD-3 "Agents keep no platform state" | The replay cache and the settings cache are state | Reword: "Agents persist nothing; in-memory caches bounded to five minutes are allowed" |
| Conventions "pino JSON logs with `run_id`, `call_id`, `tx_hash` where known" | No test | Accept as advisory, or provide one `logger.child({ run_id })` helper and lint against raw `pino()` calls |
