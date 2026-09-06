# Reconciliation: brief.md vs PRD (AgentDesk)

Input: `_bmad-output/planning-artifacts/briefs/brief-agent-desk-2026-09-05/brief.md` (status final).
Checked against `prd.md` and `addendum.md` in this directory. The brief's own addendum was consulted only where brief.md points to it by reference (demo script, build order, risk table, technical unknowns).

Severity: High changes the pitch or a demo beat; Medium changes a build decision; Low is housekeeping.

## Gaps

Things the brief states that the PRD drops or contradicts without naming them as out of scope.

### G1. Non-custody claim vs. platform-held keys for everyone (High)

- Brief, "What Makes This Different" point 3: "No intermediary holds funds. Money goes wallet to wallet. The platform takes a percentage fee and never custodies anyone's money. For unattended runs the engine holds a hot wallet key, funded by the user and capped by the daily budget." The hot key is framed as an exception for unattended runs.
- PRD §3 (System Wallet), FR-2, FR-7, FR-10, §5: the platform generates and holds the key of every Account, Builder and Creator alike. The Creator's payout wallet defaults to a platform-held wallet, Stake is funded from it, and withdrawals, key export and external wallets are non-goals. In the MVP the platform therefore holds all Builder fees, all Creator earnings by default, and all Stake. The brief's judge answer "Who holds the money? Nobody." (brief addendum §11) is not true of the MVP as specified.
- The PRD names withdrawals and external wallets as out of scope but never reconciles this with the positioning. It should say in §1 or §8 that transfers are wallet to wallet on-chain while key custody is platform-side for the demo, and that the Creator JTBD "get paid to my own wallet directly" (§2.1) holds only when the optional payout wallet in FR-10 is set.

### G2. User-set sub-account limit and user trading capital (High)

- Brief, Executive Summary and "The Solution" (Workflow engine): "The execution node places orders through Binance Agent OS in a sub-account with a user-set limit." "The Solution" (Identity and money): "trading capital lives in the Binance sub-account." Read with the Builder persona, each user trades their own capital under their own limit.
- PRD §3 (Sub-account), FR-24, FR-31, §8: one Binance Spot Testnet sub-account operated by the platform, credentials held by the `execution` Agent. `balance_usdt` is read from that shared sub-account. The user only sets a per-Workflow Order Cap, and the exchange-side limit is platform-configured. No user has trading capital of their own.
- Not listed in §5 or §6.2. Either add "per-user sub-accounts and user-held exchange credentials" to §6.2 as deferred, or reword the Builder JTBD in §2.1 so it does not imply the user's own capital.

### G3. Settlement demo determinism: mocked price feed dropped, "clearly wrong" tolerance lost (High)

- Brief, "The Solution" (Accountability): "A clearly wrong result slashes stake." Brief, Scope: settlement with "a shortened window for the demo." Brief, Success Criteria, by reference to the demo script (brief addendum §9, 2:20) and the risk table (brief addendum §10): if the one-hour rule cannot play out in three minutes, "make the settlement window configurable, and give the demo a price source that moves within seconds (a short-window Binance ticker or a mocked feed behind a demo-mode flag)."
- PRD FR-33 fixes the price source as a platform-fetched live Binance ticker (tagged assumption), and addendum §6 demo mode only shortens the window to 60 seconds. The mocked-feed fallback is gone. FR-33 also fails on any move in the wrong direction, with a tolerance only for HOLD, so "clearly wrong" became "wrong by any amount."
- Consequence for the demo: over a 60-second window on BNB/USDT the direction is close to a coin flip for both `research-good` and `research-sloppy`. Addendum §2 makes the sloppy agent bet against the 24-hour direction, which says little about the next minute. The UJ-4 beat "the marketplace now ranks Minh's agent below the original" and FR-44's "research-sloppy fails Settlement more often than it passes in demo mode" are not reproducible from one scored call each, and `research-good` can be slashed on stage. Restore a demo-mode price source, or define demo-mode settlement so the sloppy agent fails deterministically.

### G4. Demo beat "Risk rejects it" is not reachable with the seeded risk rule (Medium)

- Brief, Success Criteria: "The script is in addendum.md." Brief addendum §9 at 2:20: "The new agent gives a sloppy signal. Risk rejects it. Settlement scores it wrong."
- PRD UJ-4 drops the risk rejection, and the seeded Guardrail Risk agent (addendum §2) decides on `volatility_24h_pct` only, ignoring signal and confidence. It rejects the sloppy signal only if volatility happens to exceed 6 percent on demo day. Either cut the beat from the script or give the seeded risk agent a rule that reacts to the signal, for example REJECT when confidence is at or above 0.9 against the 24-hour direction.

### G5. Centralised settlement is not recorded as an assumption (Medium)

- Brief, Open Questions and Assumptions: "The MVP settlement job is run by the platform, so slashing is centralized even though funds are not. The roadmap's independent judge agent is the answer."
- PRD §6.2 defers the judge Agent and FR-35 says "the platform slashes", but nothing states that the platform holds slash authority over Creator Stake, and it is absent from §11 Assumptions Index. Addendum §7 asks architecture for "a Slash that pays the Builder" without saying who may call it. Add it to §8 or §11 so the trust model is explicit for architecture and for the pitch.

### G6. Hackathon outcome goals dropped from Success Metrics (Low)

- Brief, Success Criteria: "Placement in the Payment Workflows track of the Binance hackathon, and a follow-up conversation about listing on BNB Agent Studio."
- PRD §9 measures only demo mechanics (SM-1 to SM-5). The post-hackathon signal is kept, but placement and the BNB Agent Studio follow-up are gone. Fine for a build document if intentional; say so in §9.

## Drifts

Things the PRD says that the brief does not support, or whose meaning changed.

### D1. "Free-form graph" became a strict linear chain with a fixed type order (High)

- Brief, "The Solution" (Marketplace): "Types are fixed, workflows are free-form, providers compete." Workflow engine: "The user composes nodes into a graph." Scope out: "Complex branching" only.
- PRD §3 (Workflow), FR-17, FR-18: a linear chain, at most one Node per Type, and a mandatory order (research needs data before it, risk needs research, execution needs risk, notify last). Branching, fan-in and parallel Nodes are named as non-goals in §5, which is acceptable. The ordering rules and one-per-type are new constraints with no tag. Brief addendum §6 lists `data -> research -> execution` as a shape "the engine must accept"; FR-17 forbids it because execution requires risk.
- Recommend tagging FR-17 as an assumption and stating that "free-form" is reduced to "any valid subset of the five-node order" for the MVP.

### D2. Refund changed from partial to the full call price (Medium)

- Brief, "The Solution" (Accountability): a wrong result "slashes stake to partially refund the user."
- PRD §3 (Slash, Refund), FR-35: slash "exactly the Call's locked price" and transfer all of it to the Builder, which is a 100 percent refund of that fee. A defensible simplification; record it as a decision so the pitch does not say "partial."

### D3. Cost figures no longer add up once all five Types are paid (Medium)

- Brief, Executive Summary diagram prices only research (0.05) and risk (0.02) and shows "max 0.07 USDT per run". Scope says data, execution and notify "are paid but not scored" without pricing them.
- PRD UJ-1 and UJ-3 keep 0.07 and 0.05, but addendum §2 prices data at 0.01, execution at 0.01 and notify at 0.005, so the full chain costs 0.095 and the swap yields 0.075. FR-20 sums every Node. Pick one set of numbers for the journeys, the seed table and the demo script.

### D4. Untagged new rules: Stake minimum and budget default (Low)

- PRD §3 (Stake), FR-7: Stake must be at least ten times the price per call. FR-3: default Daily Fee Budget 1 USDT. Neither appears in the brief and neither carries an `[ASSUMPTION]` tag or an entry in §11. The 1 USDT default also sits awkwardly next to the brief's "hundreds of calls a day" ("What Makes This Different" point 4): at 0.095 per run it allows about ten runs per day.

### D5. Price-mismatch beat added to the demo (Low)

- PRD UJ-1 edge case and SM-5 ("rejected in the demo") add a beat where a 402 arrives at 0.06 instead of 0.05. The brief's demo script (referenced from Success Criteria; brief addendum §9) has no such beat, and it is already three minutes long. Make SM-5 a test rather than a demo obligation, or update the script.

### D6. Build-order mapping puts Account-level FRs before Accounts exist (Low)

- Brief, Scope (build order): spine, full run, listing, settlement, dashboard. PRD §6.3 follows it but places FR-3 (per-Account budget) and FR-32 (Telegram chat id in account settings) in stage 2 while FR-1 and FR-2 (Accounts, System Wallet) arrive in stage 3. Extend stage 1's "hard-coded Builder wallet" note to stage 2 with a hard-coded budget and chat id, or move FR-1 and FR-2 up.

### D7. Timing tension between NFR and demo (Low)

- PRD §7 says a Run completes "in under 60 seconds" and "the demo has 50 seconds per Run"; SM-3 uses 60. The brief script gives 50 seconds between "press run" and the second-tab moment. Pick 50 for the NFR or adjust the script.

### D8. Binance MCP dropped for market data (Low)

- Brief addendum §10 fallback row: if MCP does not run on Spot Testnet, "keep MCP for market data." PRD addendum §2 has the `data` Seed Agent read Binance public REST, and FR-31 uses MCP only for execution. The brief's ecosystem positioning ("inside Binance's own rails", brief "Who This Serves", Ecosystem) leans on Agent OS; the PRD keeps it as an open question (§10 Q2) but no longer uses it for data.

### D9. Unattended runs in the JTBD, no scheduling in the FRs (Low)

- PRD §2.1 Builder JTBD: "Let runs happen unattended at any hour without confirming payments." FR-22: Runs start only from an explicit action, no scheduling. The brief also excludes scheduling, so the JTBD reads as positioning ("runs at 3 AM", "What Makes This Different" point 1). The MVP property is "no per-payment confirmation", which SM-4 already states; align the JTBD wording.

### D10. Acknowledged narrowings (no action)

- Six Seed Agents (FR-44) instead of the brief's "four or five" (Scope). SM-C1 already caps this.
- Only the platform may list `execution` Agents (FR-14) narrows the brief's "Anyone can list without approval" ("The Solution", Marketplace). Named in §5, so acknowledged.
- Reputation over the last 30 scored Calls (FR-36) rather than "last 30 calls" (Accountability). A refinement.
- Paid verification call at listing (FR-11). The brief addendum §5 describes an unpaid sample call; the PRD makes it a paid x402 call from a platform wallet. A decision, not a conflict.

## Qualitative ideas lost

- **"Types are fixed, workflows are free-form, providers compete"** (brief, "The Solution"). The clearest one-line statement of the design. The PRD keeps fixed Types and Provider competition, but the free-form part became FR-17's ordering rules. Worth keeping as the principle line in §4.4 or §4.5.
- **"Every process is a payment graph priced before it runs"** (brief, "What Makes This Different"). FR-20 and FR-23 keep the behaviour; the phrase that makes it a pitch line is absent from §1.
- **"Switching provider is one click and the workflow does not change"** (brief, "The Solution"). FR-21 has no interaction bar; "one click" is the quality the demo needs at 1:50.
- **The "sealed box" pain** (brief, "Who This Serves", Workflow builder). §2.1 keeps the outcome but not the problem statement; useful for UX copy and the pitch.
- **"Rent one capability from someone better at it"** (same section). Partly in JTBD-1; the renting framing is what separates the marketplace from a bot store.
- **Ecosystem stakeholder** (brief, "Who This Serves", Ecosystem): more x402 volume for Binance and BNB Chain. Not a PRD user, but it is the answer to "why should Binance care" and has no home in the PRD.
- **"Clearly wrong"** (brief, Accountability) as a tolerance idea. See G3.
- **Stage value framing** (brief addendum §7, referenced from brief Scope): "With only 1 and 2 there is still a submission. With 3 it is a platform. With 4 it is a platform with accountability." §6.3 lists FRs per stage without saying what each stage buys.
- **"Trading first because its settlement rule is objective"** (brief, Vision). The rationale for the vertical is absent from §1; it is the answer to "why trading."
- **The honest moat** (brief, "What Makes This Different"): stake-and-slash is AgentDesk's own layer above ERC-8004 and ERC-8183. Relevant to §10 Q3, since building the Registry on the BNBAgent SDK's ERC-8183 escrow with UMA disputes could blur that claim.

## Confirmed coverage (short)

| Brief item | PRD location |
|---|---|
| Event, track, deadline, team of five | Frontmatter, §8 Time |
| Five fixed Types with standard schemas; arbitrary types refused | §4.4, FR-15, FR-10, §5 |
| ERC-8004 identity tied to owner wallet; price, stake, reputation on-chain | FR-5, FR-6, FR-36 |
| x402 per node, wallet to wallet, tx hashes | FR-25, FR-28, FR-40 |
| Max cost computed and prices locked before run; mismatched 402 rejected | FR-20, FR-23, FR-26, SM-5 |
| Daily budget on the Builder's wallet | FR-3, §3 Daily Fee Budget |
| Stake locked at listing; exhausted stake pauses listing | FR-7, FR-8, FR-37 |
| No approval to list; listing in under 30 seconds | FR-12, SM-2 |
| Reputation as pass rate over the last 30 | FR-36 |
| Settlement scores research and risk only; data, execution, notify paid but not scored | FR-33, FR-34, FR-38 |
| Shortened settlement window for the demo | FR-33, addendum §6 |
| Testnet order through a sub-account with a limit; Emergency Stop | FR-31, §8 |
| Dashboard with every call and payment and tx hash; split view from the script | FR-39 to FR-43 |
| Seeded marketplace with good and sloppy research agents | FR-44, addendum §2 |
| Live demo with recorded backup; pre-funded wallets | §7 Demo reliability |
| Platform fee not designed, not in MVP | §5 |
| Out: branching, scheduling, backtesting, versioning, disputes, governance, multi-chain, multi-asset, drag-and-drop polish | §5, §6.2 |
| Build order, cut from the bottom | §6.3 |
| Post-hackathon signal (outside listings, repeat runs) | §9 |
| Open decisions: Build the Era submission, B402 access, MCP on testnet, registry contract choice | §10, addendum §7 |
| Non-coder builder; creator earns per call from strangers | §2.1 |

One feasibility note on a confirmed item: FR-12's 30-second bound now includes an ERC-8004 registration, a Registry write, a Stake lock and a paid verification Call, which is four or more on-chain confirmations on BSC testnet. It is reachable, but architecture should plan to batch or parallelise them.
