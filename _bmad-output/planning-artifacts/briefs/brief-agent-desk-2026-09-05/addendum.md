---
title: "AgentDesk Brief Addendum"
status: final
created: 2026-09-05
updated: 2026-09-05
source: docs/brief-vi.md
---

# AgentDesk Brief Addendum

Detail that belongs downstream (PRD, architecture, demo prep) rather than in the brief. Sections 1 to 11 and 13 are lifted from the original Vietnamese hackathon brief in `docs/brief-vi.md` and translated; section 12 records facts verified on 2026-09-05. Where to look: architecture and engine, §1 to §6; delivery, §7 and §8; pitch and demo, §9 to §12; roadmap, §13.

## 1. Proposed technical stack

| Component | Choice |
|---|---|
| Chain | BSC testnet or opBNB (near-zero fees, fits micro-payments) |
| Payments | x402 in USDT. Binance B402 facilitator on BSC testnet (verified live, see §12); self-hosted facilitator as fallback |
| Identity | ERC-8004 registry |
| Marketplace registry | Small contract: listing, price, stake, reputation |
| Market data and order placement | Binance Agent OS (MCP), sub-account with spending limit, Emergency Stop |
| Agent | Each agent is a small HTTP service, using an LLM for analysis and explanation |
| Workflow engine | Node service, sequential DAG execution for the MVP |
| UI | React + react-flow (or a JSON editor with graph preview) |

## 2. Minimum agent record

```
agent_id          // id in ERC-8004
owner_wallet      // wallet that receives payment
endpoint          // agent URL
type              // data | research | risk | execution | notify
input_schema
output_schema
price_per_call    // USDT
stake             // locked deposit
reputation        // current score
```

## 3. Per-call flow (one node execution)

1. Engine reads `price_per_call` and adds it to the running total. If the total exceeds the ceiling, stop before calling.
2. Call `endpoint`, receive HTTP 402 with a payment requirement (amount, receiving wallet, chain).
3. Compare the amount with the price locked at run start. Mismatch means reject.
4. Sign the payment, call again with the payment proof, receive the result.
5. Log: node, amount, tx hash, result.

## 4. Sample run

User intent: "Watch BNB/USDT, enter when there is an opportunity, at most 100 USDT."

1. Engine prices the workflow: Research 0.05 + Risk 0.02 = 0.07 USDT per run. Within budget, proceed.
2. Research node: call endpoint, get 402 for 0.05 USDT, confirm it matches the locked price, sign payment, receive `{signal: LONG, confidence: 0.72, reason: ...}`.
3. Risk node: send the proposed order plus balance, get 402 for 0.02 USDT, pay, receive `{decision: REDUCE, size: 60, reason: "high 24h volatility"}`.
4. Execution node: place a 60 USDT order through Binance MCP in the sub-account, return the order ID.
5. Notify node: send the user a summary with a cost table and tx hashes.
6. One hour later, settlement scores the Research call. Correct means reputation goes up. Wrong means stake is slashed, the user is partially refunded, and reputation goes down.

## 5. Pricing, price lock, stake, reputation, settlement (MVP rules)

- Exactly one number per agent: `price_per_call` in USDT. Other pricing models are roadmap, see §13.
- Owners can change price at any time, but a workflow locks prices at run start. If a 402 returns a different amount, the engine rejects it. This blocks mid-run price hikes.
- Reputation = share of passing results over the last N calls, N = 30 for the MVP.
- Settlement job after each run compares results with reality. For `research`: did the price move in the signal's direction after 1 hour? For `risk`: did an approved order cause drawdown beyond the threshold?
- Clearly wrong result: slash stake to partially refund the user's fee, lower reputation.
- Stake exhausted: listing paused until topped up.
- Listing check: the platform calls the endpoint once with a sample payload and refuses listing if the response does not match the declared type's schema.

## 6. Workflow shapes the engine must accept

Examples the source lists:

- `data -> research -> execution`
- `data -> research -> risk -> execution -> notify`
- `data(price) + data(news) -> research -> risk -> execution`
- `data -> research A + research B -> risk -> execution`
- `data -> research -> notify` (monitoring only)

Custom types are deferred, see §13.

## 7. Priority order when time runs short

1. Registry contract + one agent that returns 402 + an engine that can call and pay. (The spine.)
2. Workflow runs all 5 nodes and the order lands on Binance Spot Testnet.
3. Listing flow for a new agent.
4. Settlement + refund.
5. Dashboard.

With only 1 and 2 there is still a submission. With 3 it is a platform. With 4 it is a platform with accountability.

## 8. Decisions to settle before coding

- Confirmed: Binance hackathon, Payment Workflows track, deadline 8 Sep 2026, team of five. Decide whether to also submit to BNB Chain's Build the Era, which closes 9 Sep 2026 (see §12).
- Confirmed: the engine holds a hot wallet key for unattended runs. Generate a fresh key for development and demo, fund it from the faucet, never reuse a personal key.
- Team stack: Node or Python; Solidity with Foundry or Hardhat.
- Build the registry on the BNBAgent SDK (ERC-8004 plus ERC-8183 escrow, see §12) or as a custom contract.
- Confirm B402 partner onboarding on BSC testnet, and whether the reported 20 USD per day agent payment cap applies to B402 on-chain payments or only to Agent OS wallet payments (see §10, row 1).
- Confirm whether Binance MCP works with Spot Testnet (see §10, row 2).
- Assignments: who builds the contract, who builds the engine and sample agents, who builds the UI and demo.

## 9. Three-minute demo script

Split screen: left is the agent exchange log, right is the money flow.

- **0:00** Open the marketplace, pick agents, compose a workflow. Screen shows "max 0.07 USDT per run".
- **0:30** Press run. Each node lights up, and the right pane shows each payment reaching the agent owner's wallet with a tx hash. Order lands on Binance Spot Testnet.
- **1:20** *Platform moment.* Open a second tab as a stranger dev, list a new Research agent in 30 seconds: endpoint, price 0.03 USDT, lock stake. Nobody approves it.
- **1:50** Back to tab one, swap the Research node for the new agent, run again. Money flows to the stranger's wallet.
- **2:20** The new agent gives a sloppy signal. Risk rejects it. Settlement scores it wrong, slashes stake, and refunds the user. Reputation drops below the original agent's.
- **2:50** Close: "This is how agents hire agents while someone still stays accountable."

The second tab is the entire reason to call this a platform. The refund is the moment that scores with the judges, because most teams only demo the happy path.

## 10. Risks and fallbacks

| Risk | Fallback |
|---|---|
| B402 partner onboarding on BSC testnet is not granted in time, or the daily payment cap blocks the demo volume | Use standard x402 on BSC testnet with a self-written facilitator. State in the pitch that Binance's facilitator will be plugged in when access opens. |
| Binance MCP does not run on Spot Testnet | Execution node calls the Binance Spot Testnet API directly. Keep MCP for market data. |
| Faucet dry or RPC lag during the demo | Prepare 2 or 3 pre-funded wallets. Record a backup screen capture. |
| The one-hour settlement rule cannot play out inside a three-minute demo | Make the settlement window configurable, and give the demo a price source that moves within seconds (a short-window Binance ticker or a mocked feed behind a demo-mode flag on the settlement job). |
| Scope creep | Follow the priority order in §7. Cut from the bottom. |

## 11. Anticipated judge questions

- **Why not Binance Pay?** Pay is person-to-business and needs merchant registration. AgentDesk is machine-to-machine with stranger agents as counterparties; there is no merchant to register.
- **What about sloppy agents?** Stake + reputation + settlement. See §5 and the 2:20 demo beat in §9.
- **What if the owner raises the price mid-run?** Prices lock at run start; the engine rejects a 402 that deviates.
- **Who holds the money?** Nobody. Money goes wallet to wallet, and the platform only takes a fee.
- **Isn't "right direction after 1 hour" too simple?** Admit it directly: the MVP uses a simple rule to prove the mechanism; the roadmap is an independent Judge agent with per-type rules.
- **Why not a normal backend?** Answer with the three-line slide from the brief's "What Makes This Different".
- **How is this different from an ordinary agent marketplace?** The workflow layer: a marketplace sells agents, AgentDesk sells priced processes composed from them.
- **How is this different from Virtuals ACP or Coinbase's Agentic.Market?** Neither combines composable workflows, paid third-party agents, and stake with slashing; see §12.

## 12. Verified facts and comparables

Checked on 2026-09-05 by web research against the source's "why now" claims.

| Claim in source | Verdict | Detail |
|---|---|---|
| Binance Agent OS launched 20 Aug 2026 | Confirmed, one correction | MCP gives agents market data, account reads, and trading (spot, margin, Convert, and futures) in a dedicated sub-account with permissions and revocation. Withdrawals are blocked. x402 is already live inside Agent OS (Binance x402 launched 19 May 2026), not upcoming. TechCrunch reports a 20 USD per day agent payment cap. |
| About 200,000 ERC-8004 agents on BSC | Confirmed, stale | BNB Chain reported more than 200,000 as of 16 Jul 2026, about 60% of all such agents across 26 networks. 8004scan now shows about 490,000 across all chains. A June 2026 arXiv study found most registrations are placeholders without live endpoints. |
| BNB Chain seeks an official marketplace for BNB Agent Studio | Confirmed | The Build the Era hackathon: build period 5 Aug to 9 Sep 2026, judging to 23 Sep, winner announced 5 Nov, more than 40,000 USD in prizes. The winner is in line to become the officially adopted community marketplace, backed as a standalone product. |
| x402 available on BSC | Confirmed | Binance B402 is live on BSC testnet for partner onboarding; mainnet access on request. USDT works through permit2-exact and permit2-upto because BSC USDT lacks EIP-3009; the U and USD1 stablecoins use EIP-3009. BSC is absent from the x402.org network list and from Coinbase's CDP facilitator. |

Comparables:

| Product | What it does | How AgentDesk differs |
|---|---|---|
| Coinbase x402 Bazaar / Agentic.Market | Discovery plus USDC-on-Base payment for x402 services; Coinbase's demo chains together CoinGecko, OpenAI, Bankr, and QuickNode | No identity, stake, or reputation; chaining is ad hoc, not a workflow product. Partial overlap. |
| Virtuals ACP (ERC-8183) | Escrow plus evaluator, 80/20 fee split, providers gated by ERC-8004 reputation score, a trading-agent Arena | Closest on trust model. No native stake or slashing, Base-centric, no CEX execution. |
| Olas Mech Marketplace | 19.9M agent-to-agent transactions, Karma reputation, takeover on timeout | Staking pays emissions; slashing explicitly not implemented. Lifetime turnover about 108,000 USD. |
| BNB Agent Studio v2 + BNBAgent SDK | BNB-native ERC-8004 plus ERC-8183 escrow with UMA optimistic-oracle disputes; agents can be hired and paid; SDK on testnet | A substrate to build on, not a competing marketplace. Binance's B402 Bazaar is a BNB-native x402 endpoint directory. |
| Fetch.ai Agentverse | 2.7M agents; ASI:One routing; USDC, FET, and Visa payments; Agent Launch on BNB | No ERC-8004, x402, or stake. |
| Skyfire KYAPay | Agent identity JWTs plus USDC and card payments, IETF draft | A payment rail, not a marketplace. |
| Google AP2, Nevermined, Payman | Authorization mandates, billing, and banking rails | Not marketplaces. |

Verdict: no product reviewed combines composable workflows, paid third-party agents, and stake with slashing. The nearest threats are Virtuals ACP and Agentic.Market. Stake and slashing sit outside the ERC-8004 and ERC-8183 base specs, so they are AgentDesk's own layer. The direct competitors are other Build the Era entries, for example Hive (discover, compare, hire, run with on-chain receipts).

Sources:

- https://www.prnewswire.com/news-releases/binance-introduces-agent-os-to-connect-ai-applications-to-financial-infrastructure-302856306.html
- https://techcrunch.com/2026/08/20/binance-now-lets-ai-agents-trade-but-keeping-them-in-check-is-largely-up-to-users/
- https://www.bnbchain.org/en/blog/bnb-chain-ai-agent-landscape-agents-tools-and-payments
- https://8004scan.io/agents
- https://arxiv.org/html/2606.26028
- https://www.bnbchain.org/en/blog/build-the-era-build-the-official-bnb-agent-studio-marketplace
- https://developers.binance.com/en/docs/products/onchainpay-x402/introduction
- https://developers.binance.com/en/docs/products/onchainpay-x402/b402-bazaar
- https://docs.x402.org/core-concepts/network-and-token-support
- https://www.pymnts.com/markets/2026/coinbase-opens-services-marketplace-for-agentic-commerce/
- https://whitepaper.virtuals.io/about-virtuals/agent-commerce-protocol-acp
- https://docs.olas.network/mech-client/
- https://olas.network/blog/20-million-olas-agent-transactions
- https://www.bnbchain.org/en/blog/bnbagent-sdk-the-first-live-erc-8183-implementation-for-onchain-ai-agents
- https://cryptobriefing.com/fetch-ai-agentic-infrastructure-agentverse/
- https://datatracker.ietf.org/doc/draft-skyfire-kyapayprofile/
- https://ap2-protocol.org/

## 13. Post-hackathon roadmap

- Independent Judge agent for settlement, with per-type rules.
- Outcome-based pricing (pay extra when the signal is right), plus per-resource and subscription pricing.
- Custom agent types: the creator declares the type's own schema, and the engine connects nodes only when output matches input.
- Workflows with branching, scheduling, versioning.
- Listing on BNB Agent Studio.
- Beyond trading: same engine, different agent types.
