---
title: "Reconciliation: Architecture Spine vs PRD Addendum"
created: 2026-09-05
spine: _bmad-output/planning-artifacts/architecture/architecture-agent-desk-2026-09-05/ARCHITECTURE-SPINE.md
addendum: _bmad-output/planning-artifacts/prds/prd-agent-desk-2026-09-05/addendum.md
scope: "Addendum §1-§4 normative, §5-§7 architecture inputs; §8 ignored. Missing rationale and implementation detail are not flagged."
---

# Reconciliation: Architecture Spine vs PRD Addendum

Severity: **High** = build would diverge from a normative rule or a required flow has no path; **Medium** = a rule exists on both sides but they disagree on actor or timing; **Low** = wording or format alignment.

## Verdict

The spine matches the addendum on header names, timeouts and retry count, scheme, network, asset, facilitator path, settle-once, slash and refund actors, reputation storage, the signing service, and stake reservation. It contradicts normative §3 on the verify/handler/settle order, denominates Stake in native BNB where §4 and AD-13 need tUSD, and gives the engine no way to obtain `balance_usdt` for the `risk` input. Three High items need a decision before Stage 1 code; the rest are wording alignments and small gaps. All five §7 decisions are answered in the spine.

## Contradictions

### C-1 High — x402 agent-side order (§3 vs AD-6 and the sequence diagram)
§3: the Agent verifies, settles, "and only then does the work". AD-6 and the sequence diagram: verify, run handler, then settle; a handler error is 5xx and never settled. §4 "failure after payment" (FR-27) presumes the §3 order.
Fix: pick one and edit the other. Recommended: keep AD-6 (it is the `@x402/express` default and never charges for a failed handler), amend §3 to "verify, do the work, settle", and add to AD-6 the Call status when a paid attempt ends in 5xx or timeout with no `PAYMENT-RESPONSE`: `payment_failed` when no settlement tx is found, `failed_after_payment` only when the engine finds the settlement tx on chain.

### C-2 High — Stake denomination (§4, §5, AD-13 vs the Registry surface)
The Registry surface declares `list(...)` "payable with the stake" and `addStake(listingId)` payable, which means native tBNB. §4 slashes "exactly the Call's locked price" (a tUSD amount), §5 funds Creators with testnet USDT for the Stake, and AD-13 lists stakes among tUSD base-unit amounts with 6 decimals.
Fix: `list` and `addStake` take a tUSD `amount` pulled through EIP-3009 `receiveWithAuthorization` (Creator signs via AD-5, no approval tx) or `transferFrom` after an approval; `slash` transfers tUSD to `to`. Remove `payable`.

### C-3 High — `balance_usdt` for the `risk` input (§1, §5 vs AD-11)
§1 `risk.in` requires `balance_usdt`; §5 says it is the Platform Exchange Account balance and the exchange key is held only by the execution Agent's process. AD-11 gives the engine no exchange access and names no route to ask the agent.
Fix: add an unpaid `GET /balance` on `spot-executor`, guarded by `INTERNAL_TOKEN`, which the engine calls before the `risk` Node. Name it in AD-11 and in AD-7 as an agent-kit extra route.

### C-4 Medium — Failure-after-payment scoring time (§4 vs AD-9)
§4: scored "at the moment of failure, no window". AD-9: "scored in the same job at the moment of failure", but the job is `settlement.tick`, which runs every 60 s in production, and AD-9 also forbids the engine scoring a Call.
Fix: AD-9 to read: the engine records `failed_after_payment` with `failed_at`; the next `settlement.tick` writes the Settlement with `scored_at = failed_at` and no window. Alternatively the engine publishes an immediate `settlement.tick` for that `call_id`.

### C-5 Medium — Reference price capture (§4 vs AD-9)
§4 needs `lastPrice` within five seconds of the Call's success, and `p_fill` at fill time. AD-9 makes `settlement.tick` the only settlement reader of market data, and it polls every 60 s in production.
Fix: state in AD-3 and AD-9 that `run.execute` writes `reference_price` and `reference_at` on the Call row at success through the market-data port; `settlement.tick` reads them and never refetches the start price.

### C-6 Medium — Notify on a failed Run (§1 vs Design Paradigm and AD-4)
§1 requires `notify` to run after a failed Run with an engine-built summary, only the paid Calls in `cost_table`, and no `order`. The spine's pipeline is "a linear list of Nodes, each fed by the previous Node's output", so a failure at Node 3 never reaches Node 5.
Fix: add to the Design Paradigm or AD-4: `notify` is the terminal filter, executed on every Run end (`completed`, `completed, no order`, `failed at <Node>`, `timed out`) with an engine-built input; the notify Call's own outcome never changes the Run status.

### C-7 Low — Amount format on the wire to agents (§1 vs AD-13)
§1 sends `cost_table[].amount` as a decimal USDT string ("0.05"); AD-13 says token amounts are transported as base-unit integer strings and rendered as decimals "only in UI components".
Fix: AD-13 to say: on the wire to agents every amount follows §1 (decimal strings); base-unit integers apply to the database, the API, and the chain.

### C-8 Low — Mode names and where §6 values live (§6 vs AD-9, AD-10, deployment paragraph)
§6 names the columns "Production default" and "Demo mode"; `platform_settings.mode` takes `live` and `demo`. AD-9 reads "mode, window, and rule from `platform_settings`", while the deployment paragraph says §6 owns the values, which implies a constant table keyed by mode.
Fix: rename one side (`production` and `demo` recommended); state that §6 values are a constant table in `packages/core` keyed by `mode`, and that `platform_settings` stores only `mode`, Emergency Stop, order ceiling, default budgets, and seed toggles.

### C-9 Low — Slash and refund as one or two transactions (§4 vs AD-8 and the Registry surface)
§4: "Both transactions are signed by the Platform Wallet". Registry `slash(listingId, callRef, amount, to)` already pays `to`, yet AD-8 keeps both `slash:{call_id}` and `refund:{call_id}` intent keys.
Fix: one transaction: `slash(..., to = Builder System Wallet of the Run)` is the refund; drop `refund:{call_id}` from AD-8 and amend §4 to "one transaction signed by the Platform Wallet". Add to AD-9 that `amount` equals the Call's locked price.

### C-10 Low — Facilitator URL in the 402 payload (§3 vs AD-6)
§3 says the `PAYMENT-REQUIRED` payload names the Facilitator URL. x402 v2 `PaymentRequirements` has no such field, and AD-6 neither puts it in the 402 nor compares it.
Fix: drop it from §3 (the schema page publishes it), or have AD-6 place `facilitatorUrl` in `accepts[].extra` and exclude it from the comparison.

### C-11 Low — Comparison target wording (§3 vs AD-6)
§3: amount, asset, network, pay-to "must equal the Listing exactly". AD-6 compares to the Price Lock, which is the FR-26 intent.
Fix: amend §3 to "must equal the Price Lock exactly".

### C-12 Low — "Every agent" (AD-7 title vs §3 third-party agents)
§3 lets any Creator use the raw x402 reference middleware and write only the handler. AD-7 binds only the six seed agents and the sample third-party agent, so its title over-claims.
Fix: retitle AD-7 "Every platform-built agent uses agent-kit"; engine-side output validation (already in the sequence diagram) stays the guard for third-party output.

### Judged not a contradiction — execution Agent duties (§2, §5 vs AD-11)
§2: "enforces Order Cap and Emergency Stop". AD-11: the agent applies Emergency Stop and the global order ceiling; the engine applies the per-workflow Order Cap and the 5 USDT minimum notional. §1 `execution.in` carries only `symbol`, `side`, `size_usdt`, so the agent cannot know a per-workflow cap; AD-11's split is the only reading that satisfies §1.
Fix: amend §2 to "enforces the global order ceiling and Emergency Stop"; keep AD-11.

### Note — agents cannot import the adapters AD-11 names (spine-internal, touches §2 and §5 duties)
AD-11 places exchange access in `packages/adapters/exchange`, and the Structural Seed puts telegram, llm, and market-data clients there too. AD-1 lets `apps/agents/*` import only `packages/schemas` and x402 packages, and `packages/adapters` imports `core`, so no agent can reach its adapter.
Fix: keep chain, x402 client, and market-data in `packages/adapters`; move exchange, telegram, and llm clients into the agent processes (vendor SDK direct, small port interfaces in `agent-kit`). Update AD-1, AD-11, and the Structural Seed tree.

## Gaps

### G-1 High — Where wallet keys are generated at sign-up (§5 vs AD-5)
§5: wallet generation on sign-up, key decrypted only inside the signing service. AD-5 says only `core/signing` touches keys and only the worker constructs it, yet sign-up is a web request. The spine does not say whether web holds `MASTER_KEY` to encrypt or the worker generates the wallet.
Fix: add a `wallet.create` pg-boss job (singleton key `account_id`) run by the worker; web inserts the account and the wallet row appears when the job completes. Or state that web holds `MASTER_KEY` for encrypt-only and accept the weaker boundary.

### G-2 Medium — Demo wallets, spare set, and faucet wallet (§5 vs deployment paragraph)
§5: two Builder and two Creator Accounts pre-funded with tBNB and USDT, plus a spare set for failover. The spine says `pnpm seed` mints tUSD and "funds gas from the platform faucet wallet"; that wallet is not one of AD-5's wallets, its own tBNB source is unstated, and the spare set is absent.
Fix: state in the deployment paragraph: `pnpm seed` creates 2 Builder + 2 Creator accounts plus one spare pair with §6 demo budgets; gas comes from the Platform Wallet, funded by hand from the BSC testnet faucet before day one; `pnpm seed --activate-spare` swaps the pair.

### G-3 Medium — Telegram `/start` responder and Platform chat id (§5, §1)
§5: the Builder starts the shared bot and "the bot replies with the chat id". Some process must consume Telegram updates by long polling, since the tunnel is optional. The spine shows only the notifier posting messages and defers the deep-link alternative. §1 also needs the Platform Account's chat id for the notify verification sample.
Fix: state that `apps/agents/telegram-notifier` runs grammY long polling beside its HTTP server and answers `/start` with the chat id; `TELEGRAM_BOT_TOKEN` lives only there; `PLATFORM_CHAT_ID` is worker env used by `listing.verify`.

### G-4 Low — Platform Wallet daily verification cap value (§5, FR-11 vs AD-5, AD-10)
AD-5 checks the cap inside the lock and Deferred cites 5 USDT, but AD-10's `platform_settings` list does not hold it and no constant is named.
Fix: add `verification_cap_daily` to `platform_settings` in AD-10; state in AD-3 that spend is computed by query over verification Calls in the last 24 h.

### G-5 Low — Who signs ERC-8004 `register` and who owns the `agentId` (§7 registry decision vs AD-2, AD-8)
AD-2 registers identity "directly" but does not say which wallet signs, so the `agentId` owner (Creator wallet or Platform Wallet) is undecided, and AD-8 covers both `register` and `list` with one key `register:{listing_id}`, which skips `list` if the first tx succeeded and the second failed.
Fix: the Creator wallet signs `register` and `list` (owner = Creator); split AD-8 keys into `identity:{listing_id}` and `list:{listing_id}`.

## §7 coverage

| §7 decision | Spine answer | Status |
| --- | --- | --- |
| Registry: BNBAgent SDK (ERC-8004 + ERC-8183) vs custom minimal contract | Custom `AgentDeskRegistry` with direct ERC-8004 `IdentityRegistry.register`; ReputationRegistry write deferred (AD-2, Structural Seed, Deferred) | Answered; contract surface needs C-2 and G-5 |
| Facilitator path, decide on day one | Fallback path active: self-hosted `@x402/core` facilitator, `exact`, team EIP-3009 `tUSD`, `eip155:97`; B402 and `permit2-exact` deferred as a config change (AD-6, Deferred); day-one acceptance test is an Open Question | Answered |
| Binance MCP vs direct Spot Testnet REST | Direct REST through `@binance/spot` with an Ed25519 key; Demo Mode is the same adapter on another base URL; 5 USDT minimum notional enforced by the engine (AD-11, Stack) | Answered; reachability per the AD-1 note |
| Runtime and Solidity toolchain | TypeScript on Node.js 24, pnpm monorepo; Foundry 1.8.1 (Stack, Structural Seed) | Answered |
| Hosting for the demo | docker compose on the demo laptop; cloudflared quick tunnel only if the submission needs a URL; submission format is an Open Question | Answered, tunnel conditional |

The §7 closing paragraph's summary of the spine matches the spine as written.
