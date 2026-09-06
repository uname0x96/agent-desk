---
title: "AgentDesk: Demo Video Script"
event: "Binance hackathon"
date: 2026-09-06
runtime: "3 minutes 10 seconds"
recording: "1280 x 720, one continuous take per beat, no cuts inside a beat"
---

# Demo Video Script

Three beats, one narrator, no human approving anything on screen. Every number
below is what the stack actually produces; if a take shows a different number,
read the number on screen rather than the number here.

The recording size is 1280 x 720 because `/runs/<id>/split` is laid out for it.
Record each beat as one unbroken take. Cut only between beats.

## Before you record

Run this checklist and do not start until every line passes.

1. `docker compose up -d`. On a fresh database the seven agents crash-loop
   until step 3, because `AGENT_PAYTO` is a wallet the seed has not created yet.
2. `corepack pnpm seed` — six agents `active`, three Workflows created,
   mode `demo`.
3. `docker compose up -d` again, so all seven agents read the `AGENT_PAYTO` the
   seed just wrote. The six platform agents take it from `.env.seed.platform`
   and only `agent-sloppy-research-2` takes it from `.env.seed`; getting that
   backwards fails every Call with `price_mismatch` (AD-6). Wait for every
   `/health` to answer 200.
4. `corepack pnpm run doctor` — passes, including the exchange checks.
   The `run` matters: `pnpm doctor` is pnpm's own command and always passes.
5. `corepack pnpm seed --warm` — exits 0, Alpha Research reads 100 percent over
   3 scored Calls. This is what makes the closing ranking mean something.
6. Two browser windows, both at 1280 x 720: the Builder signed in, and a second
   window signed out for the stranger.
7. Telegram open on the Builder's chat, and Binance Spot Testnet open on the
   order history tab.
8. Record the whole sequence once as the backup video before the live take.

## Beat 1 — a five-node run that ends in a real order (0:00 to 1:10)

**On screen:** `/workflows/<good-chain>`, then `/runs/<id>/split`.

> Narration, 0:00
>
> This is AgentDesk. Every node in this workflow is an agent rented from a
> stranger, and every node is paid per call.

Show the chain: Ticker, Alpha Research, Guardrail Risk, Spot Executor,
Notifier. Point at the cost preview.

> Narration, 0:12
>
> Five agents, five prices, one total. Ninety-five thousandths of a test dollar,
> locked before anything runs. If an owner raises a price mid-run, the payment
> is refused and nothing is paid.

Press Run once. Navigate to the split view.

> Narration, 0:25
>
> On the left, the agents talking. On the right, the money moving. Same data,
> polled every two seconds, no reload.

Let it run. Do not narrate over the first two payments; let the arrows land.

> Narration, 0:45
>
> Five payments, wallet to wallet, no platform account in the middle. Every one
> of these hashes is on the BSC testnet explorer right now.

Click one tx hash, show the explorer tab, come back.

> Narration, 0:58
>
> The risk agent cut the position size. The execution agent placed the order.

Switch to Binance Spot Testnet, show the `FILLED` order. Switch to Telegram,
show the message with all five hashes.

> Narration, 1:05
>
> Filled on Binance Spot Testnet, and the summary in Telegram with every hash.
> Forty-five seconds, start to finish.

## Beat 2 — a stranger goes live and earns, in 30 seconds (1:10 to 2:00)

**On screen:** the second window, signed out, then `/marketplace`.

> Narration, 1:10
>
> Nobody at AgentDesk knows this developer. He has never spoken to us.

Sign up. Show the System Wallet appear on `/settings`. Go to `/listings/new`,
paste the endpoint, pick `research`, set the price, accept the default stake,
submit.

> Narration, 1:25
>
> An endpoint, a type, a price, and a stake. No approval queue. The platform
> pays his endpoint once, with real money, to check that the response matches
> the schema for his type.

Watch the pipeline steps land: verified, identity registered, stake locked,
listed.

> Narration, 1:40
>
> That is an ERC-8004 identity, owned by his wallet, not ours. And that is his
> stake, locked in the registry. Ten times his price per call. The stake is what
> replaces the review we did not do.

Back to the Builder window. Swap the research node to his agent. Show the cost
preview drop.

> Narration, 1:52
>
> The cost preview drops, because he is cheaper. Run it again.

Run. Show the payment landing in his wallet.

> Narration, 1:58
>
> That is a stranger earning, thirty seconds after he arrived.

## Beat 3 — a bad agent is slashed and the user refunded (2:00 to 3:00)

**On screen:** `/workflows/<sloppy-chain>`, then `/runs/<id>/split`, then
`/settlements`, then `/marketplace`.

Run the sloppy chain.

> Narration, 2:00
>
> Now the interesting case. This research agent is confident and wrong. It calls
> a long against the day's trend.

Show the risk agent's REJECT, execution `skipped`, Run ends `completed, no
order`, Telegram message ending in "no order".

> Narration, 2:12
>
> The risk agent rejected it, so no order was placed, and the run says so. But
> the research agent was still paid. Watch what happens next.

Wait for the settlement. Open `/settlements`.

> Narration, 2:28
>
> Settlement scored that call against real market data. The rule is on screen,
> labelled as the demo rule: twenty-four hour trend, because a twenty-second
> price move is noise and we would rather say that than hide it.

Point at the row: result `failed`, the prices used and their source, the slash
amount, the slash tx hash, the refund.

> Narration, 2:42
>
> Failed. Three hundredths of a test dollar slashed out of his stake and sent to
> the buyer's wallet, in the same transaction. Here is the hash.

Click the slash tx hash, show the explorer, come back. Open `/agents/<id>`.

> Narration, 2:52
>
> And his reputation is now on-chain, rewritten by that settlement. Zero percent
> over one scored call.

Open `/marketplace`, show the ranking: Alpha Research at 100 percent over three
scored calls, above the sloppy agent at 0 percent.

> Narration, 2:58
>
> The agent that was right ranks above the agent that was wrong, and the
> difference is money, not a rating anyone typed in.

## Closing line (3:00 to 3:10)

> Narration
>
> Payment for agent labour is solved. Consequence is not. AgentDesk is a
> marketplace where being wrong costs the agent that was wrong. On BSC testnet,
> with x402, ERC-8004 identity, and a stake that actually gets slashed.

## If something fails on the take

- A payment stalls: the run ends `failed` with the reason on screen. Say the
  reason out loud and restart the beat. Do not cut around it.
- The exchange rejects the order: the executor answers `REJECTED` with a reason,
  which is a paid call and a legitimate outcome. Read the reason and continue.
- Settlement is slow: the settlement view shows "slash pending" and polls. Wait
  on it rather than reloading.
- Anything worse: cut to the backup recording made in step 8 above.
