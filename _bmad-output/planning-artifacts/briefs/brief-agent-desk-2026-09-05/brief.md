---
title: "Product Brief: AgentDesk"
status: final
created: 2026-09-05
updated: 2026-09-05
source: docs/brief-vi.md
event: "Binance hackathon"
track: "Payment Workflows (Agent-to-Agent payments)"
deadline: 2026-09-08
team_size: 5
---

# Product Brief: AgentDesk

**Tagline:** A trading-workflow platform where agents hire agents, pay per call, and every agent has an accountable on-chain identity.

## Executive Summary

AgentDesk is workflow automation for trading. A user composes specialized agents (data, research, risk, execution, notify) into a process of their own. The agents are built by third-party developers and listed on a marketplace. Each agent has an ERC-8004 identity tied to a wallet, a price per call, a locked stake, and an on-chain reputation. Every time a node runs, an x402 payment flows directly from the user's wallet to the agent owner's wallet. The execution agent connects to Binance Agent OS through a sub-account with a spending limit.

```
data -> research (0.05) -> risk (0.02) -> execution -> notify      max 0.07 USDT per run
```

Why now. Binance Agent OS, launched in August 2026, gives agents trading and market data through MCP, and x402 payments have been live inside it since May, capped per agent per day. ERC-8004 identity is already at scale on BNB Smart Chain: more than 200,000 registered agents as of July 2026, about 60 percent of all such agents across chains. BNB Chain is running the Build the Era hackathon to pick the official marketplace for BNB Agent Studio, with submissions closing 9 September 2026. The rails exist. What is missing is the layer where an agent hires another agent and holds it to the result. AgentDesk is that layer, packaged so a non-coder can use it: a marketplace, a workflow engine, and a settlement rule that makes the paid agent accountable.

## Who This Serves and Why

**Workflow builder.** A semi-professional trader who knows what they want and does not want to code. Today every trading bot is a sealed box: better analysis means rewriting it, risk control means writing code, and nobody can rent one capability from someone better at it. With AgentDesk they compose existing agents, set a budget, and run. Success: a strategy with better analysis and risk control than they could write, under a spend cap they trust.

**Agent creator.** A developer or small fund with one capability, such as on-chain analysis, news reading, or a risk model. Today the only channel to strangers is selling signals through Telegram: no per-call sales, no accountability, no verifiable track record. With AgentDesk they list the agent, set a price, and earn per call. Success: income from strangers and an on-chain reputation, without running a Telegram channel.

**Ecosystem.** Binance Agent OS gives agents trading, market data, and x402 payments inside Binance's own rails. Agent-pays-agent with accountability is the missing piece for agents to work for each other, not only for their user, and it brings Binance and BNB Chain more x402 volume.

## The Solution

**Identity and money.** Every agent registers an ERC-8004 record pointing to its owner's receiving wallet. The owner locks a stake when listing. Users have a dedicated workflow wallet with a daily budget; agent fees are paid in USDT on-chain, while trading capital lives in the Binance sub-account.

**Marketplace.** Each listing carries a type, the standard input and output schema for that type, price per call, stake, reputation, and owner. Standard schemas per type are the core idea: a stranger's agent plugs into anyone's workflow without code changes. Anyone can list without approval; stake and reputation replace review.

Types are fixed, workflows are free-form, providers compete. Arbitrary types are refused because they cannot plug into a stranger's workflow. At each node the user picks one provider, a listed agent of that type, among many, so switching provider is one click and the workflow does not change.

**Workflow engine.** The user composes nodes into a graph; each node is an agent rented from the marketplace. Before running, the engine computes the workflow's maximum cost and locks each node's price. Each node run is one x402 handshake: receive 402, check the quoted price against the locked price, pay, receive the result. The execution node places orders through Binance Agent OS in a sub-account with a user-set limit.

**Accountability.** Price is one number per agent, in USDT per call. Reputation is the pass rate over the last 30 calls. After each run a settlement job compares results with reality. A clearly wrong result slashes stake to partially refund the user and lowers reputation; an exhausted stake pauses the listing. This turns "pay an agent" into "pay an accountable agent".

## What Makes This Different

The test: if one company could own both ends of the transaction and would be willing to, agent-to-agent payment is unnecessary. AgentDesk passes on four counts.

1. **The payer is a machine.** The workflow runs at 3 AM with nobody to confirm. It needs its own wallet, its own limit, and a rail without OTP.
2. **The counterparty is unknown in advance.** Marketplace agents are built by strangers. No contract, no API key, no prior integration. Plug in, run, pay, done.
3. **No intermediary holds funds.** Money goes wallet to wallet. The platform takes a percentage fee and never custodies anyone's money. For unattended runs the engine holds a hot wallet key, funded by the user and capped by the daily budget.
4. **Payments are small and frequent.** A few cents per call, hundreds of calls a day. Cards and banks cannot do this.

Against an ordinary agent marketplace: a marketplace sells agents. AgentDesk sells processes composed from agents, and every process is a payment graph priced before it runs. The nearest existing products are Virtuals ACP (escrow, evaluator, and reputation gate, but no stake or slashing and no exchange execution) and Coinbase's Agentic.Market (x402 discovery and payment, but no identity, stake, or reputation). Neither combines composable workflows, paid third-party agents, and stake with slashing.

The honest moat is not technology. ERC-8004, x402, and MCP are all public. The moat is being the first usable workflow layer on top of them, on the chain where most ERC-8004 agents already live, with a stake-and-slash rule that neither ERC-8004 nor ERC-8183, the agent escrow standard, provides.

## Business Model

A platform fee of 2 to 5 percent per x402 call. Two-sided network effect: more agents make better workflows, more users mean more income for creators, which attracts more agents. How the fee is collected on a wallet-to-wallet rail is not designed yet and is not part of the MVP.

## Success Criteria

For the hackathon:

- The three-minute demo runs end to end: real x402 payments with tx hashes, a testnet order, an unreviewed listing, a provider swap, and a slash with refund. The script is in addendum.md. The demo is live, with a recorded backup.
- A stranger can list a working agent from the listing form in under 30 seconds.
- Placement in the Payment Workflows track of the Binance hackathon, and a follow-up conversation about listing on BNB Agent Studio.

Beyond the hackathon, the signal that this is a platform rather than a demo: agents listed by people outside the team, and repeat runs by users who are not the team.

## Scope

**In for the MVP:**

- One end-to-end sample workflow: data, research, risk, execution, notify.
- Marketplace seeded with four or five agents, including two competing research agents, one good and one deliberately sloppy to demo the refund.
- Exactly one listing flow: endpoint, schema, and price in; ERC-8004 registration; stake lock; immediate appearance on the marketplace.
- Real x402 payments on testnet with tx hashes.
- Simple settlement, scoring research and risk agents only: did the price move in the signal's direction after one hour, with a shortened window for the demo. Data, execution, and notify agents are paid but not scored.
- A dashboard showing every call and every payment with its tx hash.

**Out:**

- Complex branching, scheduling, backtesting, workflow versioning.
- Dispute handling, governance.
- Multi-chain, multi-asset.
- Polished drag-and-drop. A readable graph is enough.

**Build order when time runs short:** the spine first (registry, one agent that returns 402, an engine that pays), then the full five-node run with a testnet order, then the listing flow, then settlement and refund, then the dashboard. Cut from the bottom.

## Vision

Trading is the first vertical because its settlement rule is objective (did the price move) and the payment rail already exists. If this works, the same engine runs any domain where agents can be typed and scored: research, operations, content, compliance. In two to three years AgentDesk is where an agent goes to hire other agents and be held to its word: an independent judge agent scores results, pricing rewards accuracy, and workflows branch, schedule, and version.

## Open Questions and Assumptions

Confirmed items stay here for the record; the rest need an owner before the PRD is final.

- **Event and deadline, confirmed.** Binance hackathon, Payment Workflows track, submission deadline 8 September 2026, team of five. BNB Chain's Build the Era hackathon, the one behind the "official marketplace" claim, closes one day later on 9 September. Whether to submit there as well is an open decision.
- **Who runs settlement.** The MVP settlement job is run by the platform, so slashing is centralized even though funds are not. The roadmap's independent judge agent is the answer.
- **Technical unknowns** deferred to research and architecture; listed in addendum.md §8.
