---
title: "Rubric review: ARCHITECTURE-SPINE.md (AgentDesk)"
reviewer: rubric walker (reviewer gate)
reviewed: 2026-09-05
subject: _bmad-output/planning-artifacts/architecture/architecture-agent-desk-2026-09-05/ARCHITECTURE-SPINE.md
inputs: prd.md, addendum.md (prds/prd-agent-desk-2026-09-05)
---

# Rubric review of the AgentDesk architecture spine

## Verdict: pass with fixes

The spine fixes the right things at the right altitude: the run engine, signing, x402 binding, chain-write idempotency, settlement, and money formats are all pinned tightly enough that stories written by different people will interoperate. The Capability to Architecture map covers all 45 FRs with no gaps and no accidental duplicates. Every dimension the altitude owns is decided or deferred except one (migrations).

Six high findings must land before epics are cut. Two of them are contradictions between ADs (AD-1 versus AD-5 on where signing lives; AD-2 against itself on the listing row), one is an Open Question that undermines AD-2's own precondition on day 1, and one is a PRD deviation (Builder gas floor) that would refuse every demo Run if a story implements FR-23 as written. All six are local edits, not a rethink; only the AD-1/AD-2/AD-5 edits need a second look after the author applies them. Two of the four flowcharts do not parse in mermaid 11 (verified by rendering); fixes are given and were verified to render.

Counts: critical 0, high 6, medium 15, low 19.

## Checklist verdicts

| # | Item | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Fixes the real divergence points, misses none | Partial | Strong on engine, signing, x402, chain writes, settlement, formats. Missed: listing lifecycle and status (H2), Call-row insertion time (H6), stake-reservation definition (M1), mid-run budget refusal (M2), intent-key `<n>` allocation (M4), risk p_fill source (M5), job and API payload schemas (M6), Platform Wallet key custody (M7), UI library (M8), error codes (M9), chain_tx status (M10), migrations (M13). |
| 2 | Every Rule enforceable and covers its Prevents | Partial | AD-1's Rule is unenforceable as written because AD-5 puts viem-dependent signing in core (H1). AD-2's "stable host" clause is aspirational with no check and is undercut by Open Question 1 (H3). AD-4's Rule does not cover "a failed Run that never notifies" for the settlement-tick timeout (H5). AD-8's Prevents is not covered for `<n>`-keyed intents (M4). AD-5 has no import or env scoping to enforce "only the worker" (L15). The rest are testable. |
| 3 | Deferred and Open Questions cannot let units diverge | Partial | Open Question 1 (tunnel hostname) is on the day-1 critical path through AD-2 (H3). Deferred "UI component library ... owned by the code" is a live divergence across three stages of pages (M8). The rest are safe: B402 switch, event indexing, scaling, fee hook, DAG, rate limiting. |
| 4 | Named technology internally consistent (Stack vs ADs vs tree) | Partial | React Query (AD-12) is absent from the Stack (M11); `@x402/evm` is in the Stack but not placed in the AD-1 diagram (L2); Tailwind, iron-session, pino, bcrypt named in conventions but not in the Stack (M11). Versions are consistent where repeated (Zod 4, Next 16, Express 5, Postgres 18). Not web-verified, per instructions. |
| 5 | Covers the PRD's capabilities; map vs §6 and FR list | Pass | Stage rows match PRD §6 exactly: S1 FR-3, 5-7, 15, 16, 23, 25, 26, 28, one of 44; S2 FR-4, 17-22, 24, 29-32, 44, 45; S3 FR-1, 2, 9-14; S4 FR-8, 27, 33-38 (+ FR-25 reservation); S5 FR-39-43. All 45 FRs appear; FR-44 appears in S1 and S2 by design, as in the PRD. Minor "Lives in"/"Governed by" omissions (L7). |
| 6 | Every dimension decided, deferred, or open | Partial | Paradigm, boundaries, state ownership, data ownership, integration contracts, deployment, environments, infra, secrets, backups, seeding, security, logging: decided. Migrations: silent (M13). Testing: unit only, no integration statement (L17). Health: facilitator and agents only (L18). |
| 7 | Internal consistency | Fail on specifics | AD-1 vs AD-5/tree (H1); AD-2 vs itself and vs AD-8 keys and AD-12 polling (H2); ER `PAYMENT` and `WORKFLOW_NODE` entities vs AD-3 and naming row (M3); two mermaid diagrams invalid (M15); AD-9 start price wrong for the risk rule (M5); Structural Seed omits `listing.verify` publish (L4); `/internal/settings` breaks the route convention (L3); `maxTimeoutSeconds` 60 vs 15 s client timeout (L8); ER `PLATFORM_SETTINGS` vs AD-10 columns (L9). |
| 8 | Terseness; no template residue | Pass with cuts | No template comments or placeholders. A handful of implementation and demo-runbook passages to cut (L19). |

## Findings

### Critical

None.

### High

**H1. AD-1 contradicts AD-5 and the tree on where signing lives.**
Location: AD-1 Rule ("`packages/core` imports only `packages/schemas`"; Prevents "core depending on a vendor SDK"), AD-5 Rule (`core/signing` exposes `signPayment` and `sendTx`), tree (`core/ ... signing`).
Problem: `signPayment` signs EIP-3009 typed data and `sendTx` sends to the RPC; both need viem (and Node crypto for AES-GCM). The eslint rule AD-1 prescribes would reject the signer on day 1, and two builders will resolve it two ways (viem in core, or signing moved out with AD-5 silently rewritten).
Fix: split by port. `core/signing` keeps policy: the per-wallet mutex, the budget/stake/cap/gas-floor checks inside the lock, and intent building; it calls a `Signer` port (`decryptKey`, `signTypedData`, `sendRawTx`) implemented in `packages/adapters/signer` over viem and Node crypto. Add the port to the layer table, the adapter to the tree, and state in AD-5 that only `apps/worker` wires `adapters/signer` into `core/signing`. (Alternative: move signing wholesale to `packages/adapters/signing` and amend AD-1's diagram and AD-5; less clean because the budget checks then live outside core.)

**H2. AD-2's listing row rule contradicts itself and three other places; the listing lifecycle has no status enum.**
Location: AD-2 Rule ("listings row is a cache written only by `chainWrite` after a confirmed receipt, never by a UI handler"; "`agentURI` is `PUBLIC_BASE_URL/api/listings/<id>/agent.json`"; "read from chain refresh overwrites the cache"), AD-8 keys `identity:<listing_id>`, `list:<listing_id>`, AD-12 ("a pending wallet or listing job").
Problem: (a) `register(agentURI)` needs `agent.json` to resolve at registration, so a `listings` row must exist before any receipt; (b) the intent keys and the `listing.verify` job need a listing id before any chain write; (c) the refresh is a second writer; (d) the UI polls a "listing job" that has no row to poll. The PRD's status set (active, paused) has no pre-chain or failed state, and the conventions say status enums are verbatim from the PRD, so every stage-3 story will invent its own.
Fix: rewrite the Rule: the `POST /api/listings` handler inserts the `listings` row in `status = 'verifying'` with the form fields and null chain fields, then publishes `listing.verify`. Chain-derived columns (`price`, `stake`, `reputation_bps`, `paused`, `agent_id`, `payout`, `endpoint`) are written only by `chainWrite` receipts and by the explicit refresh route. Status enum: `verifying`, `failed` (with `last_error`), `active`, `paused`. `agent.json` serves from any row; the marketplace shows `active` and `paused` only. Add `listings.status` to the naming row.

**H3. Open Question 1 blocks AD-2's day-1 precondition; the "stable host" clause is untestable.**
Location: AD-2 Rule ("`PUBLIC_BASE_URL` must be a stable host before any `identity:` intent is sent"), Open Questions bullet 1, Structural Seed (tunnel "only if the submission needs a URL").
Problem: Stage 1 (day 1) registers an ERC-8004 identity for the first seed agent, so an agentURI is written on-chain before the hostname question is answered. Builders will register against localhost or a throwaway tunnel URL, producing exactly the dead-host URIs AD-2 says it prevents, with no rule that catches it.
Fix: decide now. Create the named Cloudflare tunnel hostname on day 1 regardless of the submission format (it is free and reversible) and fix `PUBLIC_BASE_URL` to it in every env. Make the clause testable: `listing.verify` refuses to send `identity:` when `PUBLIC_BASE_URL` is `localhost`/`127.0.0.1`/a `*.trycloudflare.com` quick tunnel; `pnpm doctor` fetches `PUBLIC_BASE_URL/api/settings/public`. If the hostname truly cannot be fixed on day 1, add an `identity-uri:<listing_id>:<n>` intent (`setAgentURI`) so seeds can be repaired, and say so.

**H4. Builder BNB gas floor: the spine silently drops a PRD consequence that, if built, refuses every demo Run.**
Location: PRD FR-23 ("BNB below the gas floor refuses the Run"), Structural Seed ("Builder System Wallets need no BNB"), AD-4 Rule ("budget and balance checks by query and chain read", balances unnamed), AD-5 ("Creator gas-floor checks").
Problem: A story derived from FR-23 checks the Builder's BNB; seed funds no BNB into Builder wallets; every Run is refused with `refused_balance`. The spine's own decision (facilitator relays, Builders need no gas) is correct but is stated only in the deployment paragraph, not where the check is defined.
Fix: in AD-4 state "the balance check is tUSD balance >= Price Lock total; no BNB check for Builders, because EIP-3009 transfers are relayed by the facilitator". Add a Deferred line naming it as a deviation from FR-23 so the PRD can be reconciled.

**H5. AD-4's Rule does not cover "a failed Run that never notifies" for the settlement-tick timeout, and leaves the engine's behaviour on a Run it finds already terminal undefined.**
Location: AD-4 Rule ("`settlement.tick` marks any `running` Run older than 120 s as `timed out`"; "`notify` runs on every Run end, including failure and timeout").
Problem: `settlement.tick` and `run.execute` are different jobs in the same worker. When the tick marks a Run `timed out` while the engine is mid-Call, nobody runs `notify`, and the engine may then try `timed out -> completed`. Two builders will resolve this differently (tick runs notify itself, or engine ignores the tick, or both).
Fix: `machine.ts` treats any transition out of a terminal status as a no-op that returns the current status. `settlement.tick` marks `timed out` and re-publishes `run.execute` for that `run_id` with `{ finalize: true }`; the engine, on entering a Run in a terminal status or on `finalize`, persists any in-flight Call outcome and runs only the `notify` filter. No new job name is needed. State it in AD-4.

**H6. Who inserts Call rows, and when, is unassigned; AD-3's spend and reservation queries silently require all of them at Run start.**
Location: AD-3 Rule (spend counts "`pending` Calls of Runs still `running`"), AD-4 Rule ("a passing request inserts the Run in `running`"; "every Run and Call status transition happens in the worker").
Problem: If the worker inserts Calls lazily as it reaches each Node, budget reservation for unreached Nodes is zero and two concurrent Runs of one Account can both pass the check. If the web inserts them, AD-4's "web never updates these rows" reads as a contradiction to a careful builder.
Fix: AD-4: "the web handler inserts the Run and one `pending` Call per Node, each carrying its locked price, payTo, asset and network, in the same transaction; the worker only transitions them". Clarify "web reads and never updates" to "never updates after insertion".

### Medium

**M1. "Unscored" for stake reservation and the source of the stake figure are undefined.**
Location: AD-3 Rule ("sum of locked prices of unscored `research` and `risk` Calls"), AD-5 ("Stake minimum ... inside the lock").
Problem: which Call statuses count (do `pending`, `price_mismatch`, `skipped` count?) and whether stake is read from the chain or the listings cache is left to the story writer; two builders will differ, and AD-5's "Stake minimum" reads as the Creator's 10x rule, not the FR-25 reservation.
Fix: define once in AD-3: reservation = locked prices of `research`/`risk` Calls in {`pending` of a `running` Run, `paid_awaiting_result`, `succeeded`, `failed_after_payment`} with no `settlements` row; stake = `listings.stake` from the cache (AD-2). In AD-5 name the check "FR-25 stake reservation" separately from the Creator 10x minimum.

**M2. A budget refusal inside `signPayment` mid-Run has no Call or Run status.**
Location: AD-4 (singleton key `workflow_id`), AD-5 (checks inside the lock).
Problem: two Workflows of one Account can run concurrently, both pass the web check, and the second is refused inside the lock; the PRD enums have no refused state for a Call, so the outcome is undefined.
Fix: either make the `run.execute` singleton key `account_id` for the MVP (one Run per Account at a time; simplest and matches the demo), or state: a refusal inside the lock records the Call as `payment_failed` with `error.code = refused_budget` and the Run as `failed at <Node>`.

**M3. ER diagram entities that no AD or convention names.**
Location: erDiagram (`PAYMENT`, `WORKFLOW_NODE`), AD-3 Binds ("payments"), AD-3 Rule (payment fields on the Call row), naming row.
Problem: AD-3 puts the 402 payload, tx hash and reference price on `calls`, so a `payments` table has nothing to hold; one builder will create it, another will not. `WORKFLOW_NODE` is not in the naming row or any AD.
Fix: drop `PAYMENT` from the diagram and "payments" from AD-3 Binds (the payments view is a read model over `calls`), or name the table and its distinct columns. Add `workflow_nodes` to the naming row.

**M4. `<n>` in `stake:`, `price:`, `pause:` intent keys has no allocator, so AD-8's idempotency does not hold for them.**
Location: AD-8 Rule, AD-5 (`listing.write` job).
Problem: if the worker allocates `n` when the job runs, a pg-boss retry after a crash allocates a new `n` and sends again.
Fix: the web handler allocates the full intent key when it enqueues `listing.write` (a `listing_writes` row with a per-listing sequence, inserted in the same transaction as the publish) and passes it in the job payload; the job never computes a key.

**M5. AD-9 names the wrong start price for the risk rule.**
Location: AD-9 Rule ("takes the start price from the Call's `reference_price`"), addendum §4 (p_fill = production `lastPrice` at fill time).
Problem: for the risk rule p_fill is the `execution` Call's reference price, not the risk Call's; a literal reading scores drawdown from the wrong anchor.
Fix: "research rule: start = the research Call's `reference_price`; risk rule: p_fill = the same Run's `execution` Call's `reference_price`; a risk Call whose Run has no `FILLED` execution Call gets `not_scored`".

**M6. Cross-process payload schemas have no home.**
Location: Data & formats row, tree (`packages/schemas`: "five Type schemas, samples, Price Lock, API envelopes").
Problem: pg-boss job payloads (web to worker), `/api/*` response DTOs (route handlers to React), and `/internal/*` bodies (agents to web/worker) are built by different people in every stage; only the envelope is fixed.
Fix: add to the row: "every job payload, `/api/*` body, and `/internal/*` body has a Zod schema in `packages/schemas` (`jobs/`, `api/`, `internal/`); both sides parse".

**M7. Platform Wallet key custody has two readings.**
Location: Structural Seed ("the Platform Wallet key ... stored in the team password manager"; "Three keys pay gas"), AD-5 ("`core/signing` is the only code that generates or decrypts a wallet key").
Problem: either the Platform Wallet is a `wallets` row under `MASTER_KEY` like every other wallet, or the signer has a special env-key path; builders will pick differently and the verification-cap check in AD-5 depends on it being a normal wallet.
Fix: `pnpm seed` imports `PLATFORM_WALLET_KEY` into the `wallets` row of `platform_account_id` (encrypted); the env var is read only by seed; the signer has one path.

**M8. Deferred "UI component library ... owned by the code" is a live divergence.**
Location: Deferred, last-but-one bullet; Stack (no UI library, no Tailwind).
Problem: pages are built in stages 2, 3 and 5 by different people in parallel; without a named choice the first three PRs will each pick one.
Fix: name it (Tailwind plus shadcn/ui, or "Tailwind only, no component library") and add it to the Stack; leave layout and theme to the code.

**M9. Error codes: two are fixed, the rest will be invented per story.**
Location: AD-4 (`refused_budget`, `refused_balance`), Data & formats row (envelope only).
Fix: add a short fixed set and a naming rule: `validation_failed`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `refused_budget`, `refused_balance`, `refused_stake`, `refused_execution_type`, `verification_failed`; snake_case; new codes go in `packages/schemas/api/errors.ts`.

**M10. `chain_tx` status enum and reverted-transaction handling are undefined.**
Location: State & cross-cutting row ("the `chain_tx` row stays `pending`"), AD-8.
Problem: a reverted `setPrice` (stake would fall below 10x) or `list` must reach the Creator; nothing says how, and only one status value is named.
Fix: `chain_tx.status` in `pending`, `confirmed`, `reverted`, `failed`; AD-8 updates domain rows only from `confirmed`; on `reverted`/`failed` the job writes `listings.last_error` (H2) and the polled UI shows it.

**M11. Stack table misses load-bearing packages named by ADs and conventions.**
Location: AD-12 (React Query), conventions (iron-session, pino, bcrypt, eslint), Deferred (Tailwind).
Fix: add `@tanstack/react-query`, `iron-session`, `pino`, `bcrypt`, Tailwind with versions, or state that the table lists only packages whose version is pinned by an AD.

**M12. Slash clamping when stake is below the locked price is assigned to nobody.**
Location: AD-9 Rule ("amount = locked price"), contract surface (`slash(listingId, callRef, amount, to)`), PRD FR-35 ("the whole remaining Stake is slashed").
Problem: if neither the contract nor the job clamps, the tx reverts on an under-collateralised agent, which is the demo's own scenario after a few slashes.
Fix: the contract clamps to remaining stake and emits `Slashed(listingId, callRef, amount)`; the settlement row's `slash_amount` is read from the receipt event, not from the intent.

**M13. Migrations are silent (operations dimension).**
Location: none; tree (`packages/db: Drizzle schema, migrations, repositories`), deployment diagram.
Problem: who runs `drizzle-kit migrate` and when is undecided; web and worker racing migrations on `docker compose up` is a day-1 failure, and five people generating migration files in parallel will collide.
Fix: one compose service `migrate` that web and worker depend on with `service_completed_successfully`; `pnpm seed` runs after it; one owner lands the ER-diagram schema first on day 1 and others add columns by PR.

**M14. Whether `not_scored` settlements count toward Reputation is unstated.**
Location: AD-9 (`result` in `passed`, `failed`, `not_scored`), PRD FR-36 ("last 30 scored Calls").
Problem: Guardrail Risk's REJECT in demo Run 2 produces a `not_scored` row; one builder shows "no score yet", another shows 1 of 1, and the on-chain bps differ.
Fix: reputation = passed / (passed + failed) over the last 30 settlements with result in {`passed`, `failed`}; `not_scored` rows are excluded and do not trigger a `reputation:` write.

**M15. Two flowcharts do not parse in mermaid 11 (verified with `mmdc`).**
Location: AD-1 dependency flowchart line 14 (`x402core[@x402/core]`: a leading `@` is a link id in mermaid 11) and the Structural Seed flowchart line 4 (`web -.publish run.execute, ... .-> pg`: dots inside dotted-link text end the link).
Problem: AD-1's Rule is "imports follow the diagram above and nothing else"; a diagram that does not render cannot be followed.
Fix (verified to render): quote the three labels `["@x402/core"]`, `["@x402/express"]`, `["@x402/fetch"]`; rewrite the two dotted links as `web -.->|publish run.execute, wallet.create, listing.write| pg` and `agents -.->|GET /internal/settings| web`; quote `fac["facilitator: @x402/core"]`. The sequence, ER and deployment diagrams render as-is.

### Low

**L1. `@x402/evm` is in the Stack but not placed in AD-1.** The facilitator and `adapters/x402` need it for the exact EVM scheme. Fix: add it to the facilitator and adapters edges in the diagram and the Rule.

**L2. Route naming.** `GET /internal/settings` on web breaks the `/api/<resource>` convention; the operator routes, the Run "verify on Binance" proxy, and the listing refresh route are unnamed. Fix: `/api/internal/settings`, `/api/operator/settings`, `GET /api/runs/<id>/order`, `POST /api/listings/<id>/refresh`, and a one-line rule that internal routes live under `/api/internal/*`.

**L3. Structural Seed flowchart omits that web publishes `listing.verify`.** Fix: add it to the dotted-edge label (with the M15 rewrite).

**L4. `pnpm seed` and `pnpm doctor` have no home in the tree**, yet AD-5 says seed uses the worker's jobs. Fix: add `scripts/` (or `apps/worker/src/cli/`) to the tree and say seed publishes through pg-boss.

**L5. `packages/adapters/*` (layer table, map) versus `packages/adapters` (tree).** One package with sub-modules or one package per adapter? Fix: one package with `chain/`, `x402/`, `market-data/`, `exchange/` (plus `signer/` from H1); make the tree and table agree.

**L6. Capability map omissions.** Stage 1 "Lives in" lacks `packages/schemas`, `packages/agent-kit`, `packages/db`, `apps/worker`, where most day-1 code lands; Stage 4 "Governed by" lacks AD-2 (pause and stake are chain facts); Stage 3 lacks AD-12 (wallet and listing polling). Fix: add them.

**L7. `maxTimeoutSeconds` up to 60 accepted while the paid-request timeout is 15 s.** A 402 can promise 60 s the engine never waits for. Fix: refuse above 15, or state why 60 is tolerated.

**L8. ER `PLATFORM_SETTINGS` lacks `default_daily_budget` and the seed toggles AD-10 lists.** Fix: align the diagram with AD-10.

**L9. Run status after a `REJECTED` execution result is not fixed** (FR-31: the Run continues to `notify` with "no order"). Fix: `completed, no order` for both a skipped and a `REJECTED` execution.

**L10. AD-4's "notify's own outcome never changes the Run status" deviates from FR-29's "a failure in the notify Node itself ends the Run".** Fix: state the deviation (Run stays `completed`; the `notify` Call carries the failure) so the PRD can be reconciled.

**L11. AD-2 runs verification and `register` concurrently while FR-12 orders them.** A failed verification leaves an orphan ERC-8004 identity and spends Creator gas; a resubmission creates a new listing id and a second identity. Fix: accept and state it, or run `register` after verification (about 3 s of the 30 s budget) and say which.

**L12. AD-9's 2 s demo poll cannot use pg-boss cron (minute granularity).** Fix: one clause: "`settlement.tick` re-publishes itself with `startAfter = poll interval` under singleton key `settlement`".

**L13. AD-6's replay cache only helps after the first attempt completes.** A second paid attempt arriving while the first is still settling re-runs the handler and fails settlement on a used nonce, and the engine then records `failed_after_payment` for a Call that actually produced output. Fix: "agent-kit is single-flight per `PAYMENT-SIGNATURE`: a concurrent duplicate waits for the in-flight result".

**L14. AD-5 has no enforcement for "only the worker".** `core/signing` sits in a package web may import; `MASTER_KEY` is not scoped. Fix: eslint restricted-import of `core/signing` (or `adapters/signer` after H1) outside `apps/worker`; `MASTER_KEY` appears only in the worker's env schema and compose service env.

**L15. AD-13 names `explorerLink()` but not the base-unit conversion helpers**, although decimal USDT strings (Type payloads, listing form) meet base-unit integers (402 amount, chain, DB) at every boundary. Fix: `toBaseUnits()` and `fromBaseUnits()` in `packages/schemas` as the only conversion.

**L16. Testing dimension is unit-only with no integration statement.** Fix: one line: "no local chain; integration = `pnpm doctor` plus rehearsal Runs on testnet; `forge test` covers the contract rules; no e2e".

**L17. Health for web and worker is unstated**; `pnpm doctor` checks facilitator and RPC only. Fix: `GET /api/health` on web (db ping) and a worker heartbeat (a `platform_settings.worker_seen_at` write per tick that doctor and the dashboard header read), or state it is out of scope.

**L18. Price history and reputation history sources are half-assigned.** AD-2 reads price history from `price:` rows, which misses the initial price in the `list:` row; reputation history (FR-42, one point per Settlement) is not assigned to `reputation:` rows or to recomputation. Fix: price history = `list:` row plus `price:` rows; reputation history = `reputation:` `chain_tx` rows.

**L19. Terseness cuts and a contract gap.** Cut: AD-7 "`telegram-notifier` retries the send twice inside the budget"; AD-10 "(it stands in for the exchange-side limit Spot Testnet lacks)"; AD-11 "(a one-container restart)"; conventions "answers `/start` with the chat id" (PRD behaviour); Structural Seed `pnpm seed --warm`, `--activate-spare`, `--reset` and "the stranger-developer beat uses a second browser profile" (demo runbook); Open Question "Demo-day trend ... rehearsal one hour before" (runbook). Contract gap: `list(...)` should revert when stake is below ten times price like `setPrice` and `addStake` do, so FR-7 holds on-chain and not only in the form. No template comments or placeholders remain.

## Coverage record (item 5)

| PRD §6 stage | PRD FRs | Spine map row | Match |
| --- | --- | --- | --- |
| 1 Spine | FR-3, 5, 6, 7, 15, 16, 23, 25, 26, 28, one of 44 | FR-3, 5..7, 15, 16, 23, 25, 26, 28, 44 (one agent) | yes |
| 2 Full run | FR-4, 17..22, 24, 29..32, 45, all 44 | FR-4, 17..22, 24, 29..32, 44, 45 | yes |
| 3 Listing | FR-1, 2, 9..14 | FR-1, 2, 9..14 | yes |
| 4 Settlement | FR-8, 27, 33..38, FR-25 reservation | FR-8, 27, 33..38 (reservation named in the row) | yes |
| 5 Dashboard | FR-39..43 | FR-39..43 | yes |

All 45 FRs are assigned once; FR-44 is assigned to stages 1 and 2 deliberately, matching the PRD.
