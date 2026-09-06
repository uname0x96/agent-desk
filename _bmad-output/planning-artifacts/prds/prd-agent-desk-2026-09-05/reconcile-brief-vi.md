# Reconciliation: Vietnamese brief vs PRD

Input: `docs/brief-vi.md` (original hackathon brief, 14 sections)
Against: `prd.md` and `addendum.md` in this folder
Date: 2026-09-05

Scope note: the PRD (§0) delegates the why-now facts, competitive landscape, demo script, risk table, and positioning arguments to the English brief and its addendum. Those documents were not among my inputs, so items marked "delegated" below are confirmed as intentionally absent from the PRD but not verified against the English brief.

## Gaps

Items in the original that the PRD does not carry.

1. **Demo beat "Risk rejects the sloppy signal" is missing.**
   Input §10 (2:20): "Agent mới đưa tín hiệu ẩu. Risk từ chối. Settlement chấm sai..." The original shows two layers of defence in one run: the risk node blocks the bad trade, then settlement slashes the agent.
   PRD §2.3 UJ-4 only has the settlement half. Worse, the seed risk agent (addendum §2, Guardrail Risk) decides on `volatility_24h_pct` alone, so nothing in the design can make it reject a sloppy research signal. The PRD also leaves open whether the sloppy run places a real order on Spot Testnet before the refund. Either add a signal-quality rule to the seed risk agent (e.g. REJECT when the signal contradicts the 24h direction with confidence above 0.85) or drop the beat explicitly.

2. **Demo beat "reputation drops below the old agent" has no mechanism behind it.**
   Input §10 (2:20): "uy tín tụt xuống dưới agent cũ."
   PRD UJ-4 asserts "ranks Minh's agent below the original research agent", and FR-44 asserts research-sloppy "fails Settlement more often than it passes in demo mode". Neither is backed by the design: the sloppy agent picks against the 24h direction (addendum §2), but the demo settlement window is 60 seconds (addendum §6), and 60-second price direction is a coin flip against 24h direction. Alpha Research's own score from Run 1 is the same coin flip. Both agents can land at 0 percent, or sloppy can pass. Needs a seeded scored history for seed agents, a demo-mode price fixture, or a settlement rule in demo mode that is deterministic. FR-33 and FR-36 have no demo-mode provision beyond the window length.

3. **Binance MCP dropped from market data.**
   Input §8 (stack table: "Market data & đặt lệnh | Binance Agent OS (MCP)") and §11 row 2: if MCP does not run on Spot Testnet, "Giữ MCP cho phần market data" (keep MCP for market data). The original wants Binance Agent OS visibly in the loop.
   PRD addendum §2 has the data seed agent fetch from "Binance public REST"; FR-33 uses a platform-fetched ticker; FR-31 keeps MCP only for execution with a REST fallback. If the FR-31 fallback triggers, the product touches Binance Agent OS nowhere, and the pitch's Agent OS integration claim has no substance. The PRD should say where MCP is required to appear.

4. **Stage-claim framing for cuts is lost.**
   Input §9 last paragraph: "Nếu chỉ kịp 1 và 2, vẫn có bài. Nếu kịp 3, đó là nền tảng. Nếu kịp 4, đó là nền tảng có trách nhiệm." (Stages 1 and 2 alone are still a story; stage 3 makes it a platform; stage 4 makes it an accountable platform.)
   PRD §6.3 has the same five stages but not what each stage lets the team claim on stage. This framing guides both the cut decision and the pitch rewrite if a stage is cut.

5. **Graph nodes lighting up during a Run is not a requirement.**
   Input §10 (0:30): "Từng node sáng lên" (each node lights up in turn). This is what judges watch on the left half of the screen.
   PRD UJ-1 repeats it in prose, but no FR requires per-node live state on the workflow graph. FR-28 is a log, FR-43 is a split view of "agent exchange log" and "money flow". A log line updating is not a node lighting up. Add it to FR-28 or FR-43.

6. **UI fallback idea lost: JSON editor with graph preview.**
   Input §8: "React + react-flow (hoặc JSON editor có preview đồ thị)".
   PRD §4.5 says only that the graph is "rendered so it is readable". The JSON-editor-plus-preview option is the cheap path if react-flow eats time, and matches SM-C2. Worth recording as the fallback for architecture.

7. **Chain alternative opBNB not recorded.**
   Input §8: "BSC testnet hoặc opBNB (phí gần 0, phù hợp micro-payment)".
   PRD §7 fixes BSC testnet chain id 97 and addendum §7 does not list chain choice among decisions handed to architecture. Low priority, but the choice was made silently.

8. **Ecosystem as a third beneficiary.**
   Input §6 third bullet: Binance and BNB Chain gain agents trading through Agent OS and x402 volume.
   PRD §2 has only Builder and Creator. Delegated positioning; noting because the judges are that ecosystem.

9. **Role assignment before coding.**
   Input §14: "Phân công: ai làm contract, ai làm engine + agent mẫu, ai làm UI + demo."
   PRD frontmatter has `team_size: 5` and nothing else. Project management rather than requirements, but §6.3 stages map cleanly to three roles and the PRD could say so.

## Contradictions

Items where the PRD states something the original does not, or states the opposite.

1. **"Nobody holds the money" vs platform-held wallet keys.**
   Input §5 point 3 ("Không có trung gian giữ tiền"), §7 ("Nền tảng không giữ tiền, không chịu rủi ro custody"), §12 ("Ai giữ tiền? Không ai.").
   PRD §3 System Wallet: "The engine holds its key." FR-2: the platform "holds its private key". FR-25 says "no platform wallet is in the path", which is true on-chain, but the platform can sign for every Builder and every Creator. The MVP is custodial in practice. If a judge asks the §12 question, the honest answer is not the brief's. The PRD should either state that System Wallets are a demo shortcut with external wallets on the roadmap, or the pitch answer must change. §5 lists external wallets as a non-goal but does not surface the positioning cost.

2. **Max-cost figures do not match the PRD's own paid agents.**
   Input §4.4 step 1 and §10 (0:00): max cost "Research 0.05 + Risk 0.02 = 0.07 USDT/lượt". The original counts only research and risk; data, execution, and notify are implicitly free.
   PRD FR-14 ("a normal paid Listing"), FR-29 ("The notify Call is paid at its locked price"), FR-44 and addendum §2 price data at 0.01, execution at 0.01, notify at 0.005. A five-node run therefore locks 0.095 USDT (0.075 with Sloppy), yet UJ-1 shows "max 0.07 USDT per run" and UJ-3 shows the preview dropping to 0.05. Pick one: make the three platform-operated types free (matches the original) or update every demo number.

3. **"Free workflow" vs a fixed-order chain.**
   Input §4.1 "Loại cố định, workflow tự do, provider cạnh tranh": the workflow is "không phải pipeline cứng" (not a rigid pipeline), with `data → research → execution` listed as a valid example.
   PRD FR-17: `execution` requires `risk` earlier, `risk` requires `research`, `notify` only last, one Node per Type. Under FR-17 the original's `data → research → execution` example is invalid. The PRD's rule is a defensible safety choice but is not marked as an assumption or a decision, and it turns the original's composition freedom into a pipeline with optional slots. Fan-in examples from the same section are out by PRD §5 and by input §9, so they are not counted here.

4. **Sub-account: user-owned with a user-set limit vs one platform sub-account.**
   Input §1 and §4.1 layer 3: execution runs "qua sub-account có hạn mức do người dùng đặt" (through a sub-account with a limit the user sets); §8 stack row says the same.
   PRD §3 Sub-account is "The Binance Spot Testnet sub-account" (one, platform-owned) with a limit "configured on Binance as a second ceiling" (§8). FR-24 feeds the risk node `balance_usdt` from that shared account, so the risk agent judges against the platform's balance, not the Builder's, and every Builder trades from the same pot. Order Cap (FR-4) carries the user-set limit at the workflow level. The PRD should say this is one shared demo sub-account and that per-user sub-accounts are deferred.

5. **Demo timeline vs 60-second settlement window.**
   Input §10: second run starts at 1:50, the slash and refund beat lands at 2:20, close at 2:50. That gives 30 seconds from run start to settlement result.
   PRD addendum §6 sets the demo Settlement Window to 60 seconds, and §7 budgets "50 seconds per Run". A research call completing at about 2:00 is scored at about 3:00, after the closing line. Either the demo window must be around 15 to 20 seconds, or the script needs a longer gap, or the sloppy agent should fail through FR-27 (invalid response after payment), which is scored immediately.

6. **Refund size: partial vs exactly the call price.**
   Input §4.3: "trừ từ cọc để hoàn một phần phí cho người dùng" (slash the stake to refund part of the fee).
   PRD FR-35 and §3 Slash: "exactly the Call's price". The PRD's rule is simpler and better for the demo, but it is a change from the source and is not tagged.

7. **Facilitator default inverted.**
   Input §8 and §11 row 1: self-hosted facilitator is the MVP baseline; plug in Binance's facilitator later and say so in the pitch.
   PRD §7, addendum §3 and §7, Open Question 1: Binance B402 is the primary path if partner access lands by day two, self-hosted is the fallback. With three build days, the original's ordering carries less risk. The PRD should at least say the self-hosted path is built first.

8. **Schema verification call is paid.**
   Input §4.1 layer 2: "gọi thử endpoint một lần với payload mẫu" (a trial call with a sample payload).
   PRD FR-11 makes it a real x402 payment from a platform wallet. Not wrong, and the stated reason (the creator sees the first payment land) is a good demo touch, but it adds a funded platform wallet and a cost per listing that the original did not have.

## Qualitative intent lost

How the product should feel and what judges should notice, where the PRD's wording drifts.

1. **The triad "fixed types, free workflow, competing providers" (input §4.1).** The PRD keeps fixed types (§4.4) and provider swap (FR-21), but FR-17 makes the middle term read as "fixed pipeline with provider slots". The original wants the judge to see a person drawing their own process from parts, with "twenty research agents" that differ in method and are swapped with one click.

2. **The two beats that win (input §10 last paragraph).** "Tab thứ hai là toàn bộ lý do gọi đây là nền tảng. Cú refund là khoảnh khắc ăn điểm, vì đa số đội chỉ demo happy path." The PRD's SM-1 lists listing, swap, and slash among six equal items. The PRD should name the second tab and the refund as the two must-not-fail beats, and note that its own price-mismatch edge case (UJ-1) is a third non-happy-path beat.

3. **"Agent pays agent" as the missing piece (input §2 third paragraph, §5).** The original argues that Binance Agent OS has trading and data but the machine-to-machine payment layer is still being added, and that AgentDesk supplies it so agents work for each other rather than only for users. PRD §1 says "Marketplaces and rails exist; the consequence does not." That reframes what is missing and drops the ecosystem argument. For an agent-to-agent payments track, the PRD should also state plainly that the engine is the paying agent, acting for the Builder.

4. **"Pay the agent" becomes "pay the accountable agent" (input §4.3 closing line).** Present in PRD §1 in substance. The phrase itself is the closing line of the demo (input §10, 2:50) and should survive into the pitch.

5. **"A payment graph computable in advance" (input §12, last answer).** The PRD has the max-cost preview (FR-20) but not the framing that distinguishes AgentDesk from an agent marketplace: it sells processes, and every process is a payment graph priced before it runs. Delegated positioning; noting because it is the answer to "how is this different from an agent store".

6. **Honesty about the simple settlement rule (input §11 row 4).** "Thừa nhận thẳng" (admit it directly). PRD §6.2 defers the judge agent but does not carry the instruction to say so on stage. Delegated to the brief's risk table.

## Confirmed coverage (short)

- Three-layer architecture, ERC-8004 identity owned by the creator, registry entry, stake lock, on-chain reputation after settlement: input §4.1 layer 1, PRD §4.2.
- Five fixed types with standard schemas, no custom types, schema verification at listing, no approval, listing in 30 seconds: input §4.1 layer 2, §9; PRD §4.3, §4.4, FR-10 to FR-13, SM-2.
- Price per call as the only model; owner can change price; price lock at run start; engine rejects a 402 that differs from the locked price: input §4.2, §8 per-call flow, §12; PRD FR-9, FR-23, FR-26, SM-5.
- x402 handshake per node, direct wallet-to-wallet payment, per-call log with tx hash: input §4.1 layer 3, §8; PRD FR-25, FR-28, FR-40.
- Reputation as pass rate over the last 30 scored calls; research rule (direction after the window); risk rule (drawdown threshold); slash to refund; pause at zero stake; shortened window for the demo: input §4.3, §9; PRD FR-33 to FR-37, addendum §4 and §6.
- Sample run numbers 0.05, 0.02, 100 USDT cap, REDUCE to 60, confidence 0.72, order id, notify with cost table and tx hashes: input §4.4; PRD UJ-1, addendum §1 and §2.
- Two competing research agents, one deliberately sloppy: input §9; PRD FR-44.
- Daily budget per user wallet, run refused when over budget: input §1, §4.1, §8 step 1; PRD FR-3, FR-23.
- Split-screen demo view, log left and money right: input §10; PRD FR-43.
- Build order stages 1 to 5, cut from the bottom: input §9; PRD §6.3.
- Risk fallbacks: self-hosted facilitator, REST fallback for execution, two or three pre-funded wallets, recorded backup: input §11; PRD §7, FR-31, Open Question 1.
- Pre-code decisions 1 to 3 (runtime and toolchain, which chain B402 settles on, MCP on Spot Testnet): input §14; PRD §10, addendum §7.
- Non-goals match input §9 "Không làm": branching, scheduling, backtest, versioning, disputes, governance, multi-chain, multi-asset, drag-and-drop polish: PRD §5, SM-C2.
- Roadmap items (judge agent, outcome pricing, branching and scheduling) appear as deferrals: input §13; PRD §5, §6.2. BNB Agent Studio listing and expansion beyond trading are delegated to the brief.
- Acknowledged deviations the PRD lists explicitly and I did not count: third-party execution agents (input §4.1 says anyone can list any of the five types; PRD FR-14 and §5 restrict execution to the platform), platform fee of 2 to 5 percent (input §7; PRD §5), fan-in workflows (input §4.1 examples; PRD §5).
- Positioning delegated by PRD §0 to the English brief, not verified here: why-now facts (Agent OS launch date, about 200,000 ERC-8004 agents on BSC, BNB Chain seeking a marketplace), the four-point "why A2A" test, the Binance Pay answer, "a bot with five functions", the two-sided network effect.
