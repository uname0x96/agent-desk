# Reconciliation: PRD vs Architecture Spine (AgentDesk)

Sources: `ARCHITECTURE-SPINE.md`, `prd.md`, `addendum.md` (all 2026-09-05). PRD §0 makes addendum §1 to §4 normative, so they count as PRD text here. Missing rationale and missing implementation detail were not flagged.

## Verdict

Revise before freeze. Call and Run statuses, the x402 values, the settlement rules, the mode table, and the stage-to-FR split all match the PRD. What does not land is concentrated in three places: the `AgentDeskRegistry` surface (stake currency, price change, pause and resume, stake release, slash versus refund), exchange reads that FR-24 and FR-31 need outside the execution agent, and Run concurrency and refusal handling. Eight contradictions, sixteen gaps, eight quiet requirements, five map issues.

## Contradictions

C-1. FR-7, FR-35, Glossary "Stake" and "Refund" vs Structural Seed registry surface. Stake is USDT in the PRD; the spine's `list(...)` and `addStake(...)` are `payable`, which locks native BNB, and `slash(..., to)` would then refund BNB. AD-13 itself calls stakes tUSD amounts. Fix: make both functions non-payable with a `uint256 amount` in tUSD pulled by `transferFrom` (approval granted at wallet creation per FR-2) or `receiveWithAuthorization`; the contract holds tUSD and `slash` transfers tUSD.

C-2. FR-24 (`balance_usdt` from the Platform Exchange Account) and FR-31 ("verify on Binance" action in the Run view) vs AD-11 (exchange access only in the execution agent, no exchange keys in the worker). The engine and the web both need exchange reads the spine forbids. Fix: spot-executor exposes unpaid `GET /balance` and `GET /orders/{order_id}` behind `INTERNAL_TOKEN`; the engine calls the first when building the risk input; web proxies the second as `GET /api/runs/{id}/calls/{call_id}/exchange-order`. Record the exception in AD-11.

C-3. FR-30 ("Two Runs of the same Workflow cannot execute at the same time") vs AD-4 (pg-boss singleton key `run_id`). That key only stops one Run executing twice. Fix: singleton key `workflow_id` plus a partial unique index `runs(workflow_id) WHERE status = 'running'`, so the web insert fails with 409 while a Run is open.

C-4. FR-8, FR-37 (Settlement pauses at zero Stake; top-up to ten times price resumes) vs Structural Seed (`setPaused` by the creator only). The platform address cannot pause, and nothing un-pauses on `addStake`. Fix: `slash` sets `paused` when stake reaches zero; `addStake` clears it when stake >= 10 x price; keep `setPaused` for creators. Both effects arrive with the existing receipts, so AD-8 needs no new intent key.

C-5. FR-11 (verification runs after Stake is locked; on failure "the Stake is released back") and FR-12 (order FR-7, FR-11, FR-5, FR-6) vs Structural Seed (`list()` takes the stake and creates the entry in one tx and needs `agentId` first; "Stake withdrawal is deferred", so nothing can release it). Fix: state the `listing.verify` order explicitly as verify, then `IdentityRegistry.register` (creator wallet), then `list` with stake, and record that this deviates from FR-12 (stake is never locked on failure rather than released); or, if the PRD order must hold, add `cancelUnverified(listingId)` that returns the stake.

C-6. Addendum §1 (normative: "All amounts are decimal strings in USDT"; `notify.cost_table[].amount` is `"0.05"`) vs AD-13 (token amounts transported as base-unit integer strings, decimals only in UI). A third-party notify agent would receive `"50000"`. Fix: AD-13 carve-out: payloads defined by the `packages/schemas` Type contracts carry USDT decimal strings as addendum §1 defines; base-unit integers apply to the database, the platform API, and the x402 `amount` field.

C-7. FR-35 and UJ-4 ("Slash and Refund are on-chain transactions", "both tx hashes") vs Structural Seed `slash(listingId, callRef, amount, to)`, which does both in one tx, while AD-8 lists separate `slash:` and `refund:` intent keys. Fix: split into `slash(listingId, callRef, amount)` and `refund(callRef, to, amount)` (two txs, two hashes, matches the PRD); otherwise drop the `refund:` intent and state that the Settlement view shows the one hash under both labels.

C-8. FR-11 ("The verification Call ... not in any Run") vs ERD `RUN ||--o{ CALL` (every Call belongs to a Run). Fix: `calls.run_id` nullable, add `calls.kind` in `{run, verification}` and `calls.listing_id`; ERD becomes `RUN |o--o{ CALL`.

## Gaps

G-1. FR-9 price change: AD-2 puts price on-chain, but the registry surface has no `setPrice` and AD-8 has no intent key; the FR-9/FR-42 price history (timestamp, old, new) has no home. Fix: add `setPrice(listingId, price)` (creator; reverts if stake < 10 x price), intent key `price:{listing_id}:{n}`, and state that price history is read from `chain_tx` rows with `price:` keys carrying old and new in the intent payload.

G-2. FR-7 top-up and FR-9 price change are chain writes signed by the creator wallet, which only the worker may do (AD-5), but the only jobs are `run.execute`, `listing.verify`, `settlement.tick`. Fix: add job `listing.write` (payload: intent key and build args) for both; web enqueues and never signs.

G-3. FR-23 refusal: AD-4 has the web insert the Run in `running`, but "refused: budget" and "refused: insufficient balance" are not Run statuses and occur before any Call; two builders would place the check in different processes. Fix: the web route handler builds the Price Lock, runs the budget and balance checks (chain read through `adapters/chain`, allowed by AD-1), returns 409 with `error.code` `refused_budget` or `refused_balance` and the shortfall in `details`, and inserts no Run; only a passing request inserts `running`.

G-4. FR-23 BNB gas floor: no value anywhere. Under the self-hosted facilitator the relayer pays gas for payments, so a Builder needs no BNB for a Run; Creator wallets still need BNB for register, list, addStake, setPrice. Fix: `platform_settings.gas_floor_wei` (default 0 for Runs) and a creator floor checked by `listing.write` before signing.

G-5. FR-3 spend as a query (AD-3): which Call statuses count is undefined, so reservation semantics diverge. Fix: spend for a UTC day = locked prices of the account's Calls in `paid_awaiting_result`, `succeeded`, `failed_after_payment`, plus locked prices of `pending` Calls in Runs still `running`; `price_mismatch`, `payment_failed`, `skipped`, and Calls of `timed out` Runs count zero.

G-6. FR-45 "reset an Account's Daily Fee Budget" has no meaning when spend is derived (AD-3). Fix: `accounts.budget_window_start`; reset sets it to now; the spend query counts Calls after max(UTC midnight, `budget_window_start`).

G-7. FR-29 120 s Run timeout: no mechanism. Worst case per Node is 15 s + 15 s + 15 s, so five Nodes can exceed 120 s. Fix: `run.execute` checks `started_at + 120 s` before each Node and each paid retry; `settlement.tick` (or a `run.sweep` job) marks `running` Runs older than 120 s as `timed out`.

G-8. FR-25 "failed_after_payment if the settlement is found on-chain, otherwise payment_failed": no way to find it is stated, and event indexing is deferred. Fix: after the second paid attempt fails, call `TUSD.authorizationState(from, nonce)` through the chain port; true gives `failed_after_payment` with `tx_hash` null, false gives `payment_failed`. Reject a 402 whose `maxTimeoutSeconds` exceeds 60 so a late settle cannot land after the decision.

G-9. FR-34 "not scored" and FR-41 columns: the settlements row has no result enum and no named columns, and AD-3's "derived amounts are never stored" could be read to exclude the prices used (they are observations, not derivations). Fix: add `settlements.result` in `{passed, failed, not_scored}` to AD-4's verbatim enums and name `rule`, `mode`, `ref_price`, `ref_price_ts`, `end_price` or `change_24h_pct`, `price_source`, `slash_amount`.

G-10. Addendum §4 reference price "fetched within five seconds of the Call's success": `settlement.tick` polls every 60 s in production, so the engine must record it, but AD-9 says the engine never scores. Fix: state that `run.execute` writes `calls.ref_price` and `ref_price_ts` from `adapters/market-data` right after a `research` or `risk` Call succeeds (recording, not scoring).

G-11. FR-44 and UJ-3: Minh's live Listing must answer 402 with Minh's payout wallet, but `AGENT_PAYTO` is per process and the deployment reserves ports 4101 to 4106 for six agents; one endpoint cannot pay two wallets, so FR-11 would refuse the live Listing or the money would not land in Minh's wallet. Fix: reserve `:4107` for a second `sloppy-research` instance with `AGENT_PAYTO` = demo Creator wallet in docker compose and `pnpm seed`; the `:4103` seeded Listing stays the failover.

G-12. FR-10 HTTPS rule vs the compose deployment: the worker reaches agents by service name, the browser by localhost, and no agent has an HTTPS URL. Fix: state the `http://` allow-list (`localhost`, `127.0.0.1`, `host.docker.internal`, compose service names) and the host name Minh pastes in the demo.

G-13. AD-11 minimum notional (5 USDT) check "before calling": the outcome is undefined when `risk` reduces below 5 USDT. Fix: fail the `execution` Call before payment with reason `below exchange minimum notional`, Run `failed at execution`, notify still runs (same path as the Order Cap check in FR-25).

G-14. §7 Demo reliability RPC retry (three attempts, never re-sign): absent from Consistency Conventions. Fix: add "chain reads and sends are retried three times with backoff inside `chainWrite` and the chain port; a payment signature is never regenerated".

G-15. FR-14 and §7 server-side enforcement: only the form restriction is implied, and `accounts` has `is_operator` but no platform flag. Fix: `POST /api/listings` rejects `type = execution` unless `account.id = platform_settings.platform_account_id`.

G-16. Openness NFR: a third-party agent off the laptop must reach the Facilitator, but the tunnel covers web only. Fix: extend the open question so the tunnel decision covers `FACILITATOR_URL` too (second quick tunnel, or a `/facilitator` path proxied by web).

## Quiet requirements dropped

Q-1. FR-45: Emergency Stop and demo mode visible on the dashboard header for every signed-in user, not only Operators. Fix: `GET /api/settings/public` returning `{ mode, emergency_stop }`, polled with the dashboard; Operator routes stay flag-gated.

Q-2. FR-33 and addendum §8: the Settlement view label "demo settlement rule: 24h trend". Fix: `settlements.rule` stores the verbatim label from a constant in `core/settlement`, not only the mode.

Q-3. FR-15, FR-16, Openness NFR: the public schema page must show the five schemas, sample payloads, and the HTTP contract, not only the four x402 values, and be reachable signed-out. Fix: `packages/schemas` exports `samples` per Type (used by both `listing.verify` and the page, with the notify sample's recipient filled from the Platform Account at verify time); the page renders `z.toJSONSchema` output; list the public routes (`/schema`, `/api/listings/{id}/agent.json`, `/internal/settings` with token).

Q-4. FR-26 "with both values shown": the Call must keep the offending 402. Fix: `calls.payment_required` JSON column written on every 402.

Q-5. FR-28, FR-5, Trust NFR: explorer links for every tx hash and for the agent id. Fix: `EXPLORER_URL` (testnet.bscscan.com) in env and one `explorerLink()` helper in web.

Q-6. FR-24 skips and FR-29 notify-after-failure are not filters in the paradigm's linear list (lock check, 402, pay, validate, persist), and the notify input comes from Run context, not the previous output. Fix: add a "skip decision" filter before the lock check and say that `notify` input is built from Run context.

Q-7. §7 Demo reliability: `research-good` scored before the demo and two prepared wallet sets. `pnpm seed` covers accounts, wallets, mint, and gas only. Fix: `pnpm seed --warm` runs N Runs of the good chain in demo mode; `--set b` creates the spare wallet set.

Q-8. AD-10's "global order ceiling" is not in the PRD (FR-45 lists three controls); it stands in for the missing exchange-side limit (PRD Open Question 2, addendum §7). Fix: say so in AD-10, fix a default that cannot block the demo (1000 USDT), and have the execution agent read `/internal/settings` per request so FR-45's five-second rule holds.

## Map issues

M-1. Stage 1 lists FR-5..FR-7 (identity, registry entry, stake), and PRD §6 stage 1's outcome is "Registry entry for one Agent", but `contracts/AgentDeskRegistry.sol` and `adapters/chain` live only in the stage 3 row and AD-2, AD-8 are missing from stage 1's Governed by. Fix: move both into stage 1 Lives in; add AD-2 and AD-8.

M-2. Stage 1 omits "one Seed Agent from FR-44" from its FR list (PRD §6) although `apps/agents/binance-ticker` is in Lives in. Fix: add "FR-44 (one agent)".

M-3. Stage 5's title "dashboard, marketplace, schema page" carries FR-13 (stage 3) and FR-15 (stage 1) capabilities without their FRs. Fix: retitle "dashboard and views (FR-39..FR-43)"; put marketplace pages in stage 3 Lives in and the public schema page in stage 1 Lives in.

M-4. AD-7 binds "verification Call (FR-9, FR-10)"; the verification Call is FR-11. Fix: cite FR-11.

M-5. The Security and custody NFR row omits AD-11 (exchange credentials only in the execution agent; Order Cap checked before payment and inside the agent). Fix: add AD-11.

All 45 FRs are otherwise covered exactly once; FR-25's stake reservation split into stage 4 matches PRD §6.
