---
title: "AgentDesk: Submission Brief"
event: "Binance hackathon"
track: "Payment Workflows (Agent-to-Agent payments)"
date: 2026-09-06
---

# AgentDesk

**AgentDesk is a marketplace where AI agents hire and pay each other per call over x402, and every listed agent posts an on-chain stake that is slashed when it is wrong.**

## The problem

An agent that wants to buy a capability from another agent already has most of what it needs. Binance Agent OS, launched 20 August 2026, gives agents market data and trading through MCP inside a permissioned sub-account, and x402 payments have been live inside it since 19 May 2026. ERC-8004 gives every agent an on-chain identity, and BNB Smart Chain is where those identities live: more than 200,000 registered agents as of 16 July 2026, about 60 percent of all such agents across 26 networks. Discovery exists too, as x402 directories and agent marketplaces. Calling a stranger's agent and paying it is solved.

What is missing is the consequence. Nothing on that stack makes a wrong agent pay for being wrong. An agent that returns a confident, useless answer keeps the fee, the buyer absorbs the loss, and the seller's reputation is a claim on a website. Neither ERC-8004 nor ERC-8183, the agent escrow standard, specifies a stake or a slash. Virtuals ACP comes closest, with escrow, an evaluator, and a reputation gate, but no native stake and no slashing; Coinbase's Agentic.Market has payment and discovery with no identity, stake, or reputation; Olas Mech Marketplace has run 19.9 million agent-to-agent transactions and explicitly does not slash. The rails are there, the market is there, the accountability is not.

## What AgentDesk is

A workflow builder on top of an agent marketplace, where every node is an agent rented from a stranger and paid per call.

There are five agent types, and only five: `data`, `research`, `risk`, `execution`, `notify`. Each type has one standard input and output schema, published on a page anyone can read without an account. Fixed types are the core design choice: they are what lets a stranger's agent plug into anyone's workflow with no integration work and no code change.

A builder composes a chain of nodes, picks one provider per node, and sees the maximum cost of a run before starting it, checked against a daily fee budget. Each node then runs as one x402 handshake, and the money moves on-chain from the builder's wallet straight to the agent owner's payout wallet, with no platform account in the middle. Prices are locked when the run starts, so a 402 whose amount, asset, network, or payee differs from the lock is refused and paid nothing. That is what stops an owner raising the price mid-run.

Listing is permissionless. A creator submits an endpoint, a type, a price, and a stake; the platform makes one real paid call to check the response against the type's schema, registers an ERC-8004 identity owned by the creator's wallet, locks the stake into the registry contract, and shows the card. Nobody approves it. The stake, at minimum ten times the price per call, is what replaces review.

Then the part nothing else on the stack does. After a settlement window, a job scores each `research` and `risk` call against real market data: a research call passes if the price moved in the direction of its signal. A failed score slashes exactly the call's price from that agent's stake, sends it to the buyer's wallet in the same transaction, and rewrites the agent's reputation, its pass rate over the last 30 scored calls, on-chain. An agent whose stake reaches zero is paused until topped up.

## What you will see in the demo

Three beats, live on BSC testnet and Binance Spot Testnet, with no human approving anything.

**A five-node run that ends in a real order.** A builder composes `data`, `research`, `risk`, `execution`, `notify`, and the screen shows a maximum cost of 0.095 tUSD. She presses run once. Five payments leave her wallet, one per node, each with a hash on the BSC testnet explorer, beside the live agent log. The risk agent reduces the position size, the execution agent places a market order on Binance Spot Testnet, and Telegram receives the summary, the cost table, and every hash. Target is 45 seconds end to end.

**A stranger goes live and earns, in 30 seconds.** In a second tab, a developer nobody on the platform knows signs up, pastes an endpoint, picks `research`, sets a price, accepts the default stake, and submits. The platform pays his endpoint once to verify the schema, mints the identity, locks his stake, and the listing appears. The builder then swaps her research node to his agent, the cost preview drops to 0.075 tUSD, and she runs again. The payment lands in his wallet.

**A bad agent is slashed and the user refunded.** The stranger's agent returns a confident signal against the day's trend. The risk agent rejects it, execution is skipped, and the run ends "completed, no order". Twenty seconds after the research call, settlement scores it wrong, slashes the call's price from his stake, refunds it to the builder's wallet, and writes the new reputation to the registry. The settlement view shows the rule applied, the prices used, and both transaction hashes. His agent now ranks below the one it replaced.

The demo shortens the settlement window to 20 seconds and scores research against the 24 hour trend, because a 20 second price move is noise. The screen says so, labelled "demo settlement rule: 24h trend".

## How it works

x402 v2 only, the `exact` scheme, network `eip155:97`, which is BSC testnet. The facilitator is self-hosted from the x402 reference packages rather than Binance's B402, which needs partner onboarding we do not have; switching to it and its `permit2-exact` scheme is a configuration change plus a one-time approval per wallet.

The payment asset is `tUSD`, a test token the team deployed implementing EIP-3009 `transferWithAuthorization`. BSC's USDT does not implement EIP-3009, which is why B402 routes it through Permit2 instead; with our own token the facilitator relays the transfer, so a buyer wallet needs no gas of its own to pay. Trading capital on the exchange side stays in testnet USDT.

On-chain state lives in one contract, `AgentDeskRegistry`, holding each agent's price, stake, reputation in basis points, pause flags, payout wallet, endpoint, and ERC-8004 identity id. The chain is the system of record for listings; the database keeps a cache written by exactly one function and refreshed from transaction receipts. Identity is registered directly against the ERC-8004 IdentityRegistry on BSC testnet, signed by the creator's own wallet, so the creator owns it.

Off-chain is a modular monolith in TypeScript. One background worker is the only process that transitions run and call state; a web request inserts a run and its calls whole and never touches them again. Signing sits behind a single port wired only into the worker, takes a per-wallet lock, and enforces the budget and stake reservation before signing, so an authorisation is never signed twice for one call.

The trade-offs, plainly. Testnet only. Wallets are platform-managed hot wallets: we hold the keys, capped by a daily budget, though a creator can already direct payouts to an external address. Settlement is run and signed by the platform wallet, so the judge is centralised even though the money is not.

## The business

The buyer is the workflow builder: a semi-professional trader who knows what strategy they want and does not want to write it, paying per call from a wallet with a daily budget they set. The seller is the agent creator: a developer or small fund with one good model, whose only channel today is a Telegram signals group with no accountability and no track record anyone can check. The same account can be both.

The revenue model is a fee of 2 to 5 percent on each x402 call. It is not implemented, and that is an open question rather than a missing feature: on a rail where money moves wallet to wallet with no intermediary, there is nowhere obvious to take a cut, and no hook for one is reserved in the contract or the engine.

The stake is the wedge rather than a feature. Every other piece of this product exists already: ERC-8004 identity, x402 payment, agent directories, workflow builders. Stake with slashing is the one piece no marketplace or standard in the landscape provides. It lets listing be permissionless, because stake and reputation replace human review, and it makes reputation mean something: a score backed by money at risk is a different object from a self-reported rating.

Be precise about how much that buys. The refund is the call fee, not the trading loss: a wrong signal that costs a trader real money on the exchange returns the few cents they paid for it, and the stake minimum bounds how many refunds an agent can owe, not how much damage it can do. Accountability here is fee-level, and the reputation hit, which follows the agent into every workflow, is the larger part of the deterrent.

The realistic first market is the one this MVP is built for: crypto trading workflows on BNB Chain. Not because it is the biggest market for agent labour, but because its settlement rule is objective in a way most domains are not. Did the price move in the direction of the signal has a cheap answer, from public data, with no human judging anything. Research, operations, content, and compliance need a judge before they need a marketplace.

Four things have to become true at scale. Volume has to be large enough for a small take rate on cents to be a business: the cautionary number is Olas, 19.9 million agent-to-agent transactions against about 108,000 USD of lifetime turnover, on which a 5 percent fee is a rounding error. Stake has to be sized against loss rather than fee, which means much larger stakes or outcome-linked pricing. Settlement has to stop being run by the platform. And buyers have to want composed processes rather than single agents, because if they only want one good research agent, this is a directory with extra steps.

## What is real today, and what is not

Real: an x402 rail with a self-hosted facilitator on BSC testnet, an on-chain registry holding price, stake, and reputation, ERC-8004 identities, a permissionless listing flow with paid schema verification, a workflow engine with price locking and budget enforcement, agents that trade on Binance Spot Testnet and post to Telegram, and settlement that slashes stake and refunds the buyer on-chain.

Not real: mainnet, real money, custody by anyone but the platform's hot wallets, agent types beyond the fixed five, third-party `execution` agents (that type is platform-operated because it holds the exchange credentials, and every order goes through one shared exchange account), branching or scheduled workflows, dispute handling, an independent judge, and fee collection. The settlement rules are deliberately crude. Built by five people in three days.
