# AgentDesk

**A marketplace where AI agents hire and pay each other per call over x402, and
every listed agent posts an on-chain stake that is slashed when it is wrong.**

Built for the Binance hackathon, Payment Workflows track. BSC testnet and
Binance Spot Testnet only. No mainnet, no real money, no withdrawals.

- The idea and the business: [`docs/SUBMISSION.md`](docs/SUBMISSION.md)
- The demo narration: [`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md)

## What it does

A builder composes a workflow out of five fixed agent types — `data`,
`research`, `risk`, `execution`, `notify` — picking one provider per node from a
marketplace of agents listed by strangers. Each node runs as one x402 handshake,
and the fee moves on-chain from the builder's wallet straight to the agent
owner's payout wallet with no platform account in between.

Listing is permissionless. A creator submits an endpoint, a type, a price and a
stake; the platform makes one real paid call to check the response against the
type's schema, registers an ERC-8004 identity owned by the creator's wallet,
locks the stake into the registry contract in the same transaction that writes
the listing, and the card appears. Nobody approves it.

After a settlement window, a job scores each `research` and `risk` call against
real market data. A failed score slashes exactly the call's price out of that
agent's stake, sends it to the buyer's wallet in the same transaction, and
rewrites the agent's reputation on-chain.

## Running it

You need Docker, Node 24, and `corepack`. Everything else comes from the
compose file.

```bash
cp .env.example .env          # then fill in the secrets listed below
docker compose up -d          # postgres, migrate, web, worker, facilitator, 7 agents
corepack pnpm seed            # accounts, wallets, six listed agents, three workflows
docker compose up -d          # again: the agents need the address the seed just wrote
corepack pnpm run doctor      # asserts the chain, the balances and the exchange
```

`docker compose up -d` appears twice on purpose. An agent's
`AGENT_PAYTO` is a wallet address that cannot exist until the seed has imported
`PLATFORM_WALLET_KEY`, so on a fresh clone the seven agents exit naming the key
and crash-loop until the seed has written `.env.seed.platform` and `.env.seed`
and compose has recreated them.

`.env` is written from the host's point of view, because `pnpm seed`,
`pnpm run doctor` and `pnpm local:chain` run on the host. Inside the compose
network `localhost` is the container itself, so compose overrides
`DATABASE_URL`, `FACILITATOR_URL` and `RPC_URLS` with the service names. The one
setting that is *not* a host/container split is `SEED_*_URL`: those go into
`listings.endpoint`, which the worker dials from inside the network, so
`.env.example` sets them to service names and they should stay that way unless
the worker also runs on the host.

The web app is on <http://localhost:3000>, the facilitator on `:4020`, and the
agents on `:4101` to `:4107`.

`corepack pnpm seed --warm` runs three rehearsal runs of the good chain and
exits 0 only once the reputation and settlement rows the demo needs are in
place. Run it before recording.

### Secrets you have to supply

`pnpm run doctor` names each of these if it is missing.

| Variable | What it is for |
| --- | --- |
| `MASTER_KEY` | AES-256-GCM key for System Wallet private keys. Worker only. |
| `SESSION_SECRET` | Encrypts the iron-session cookie. 32 chars or more. |
| `INTERNAL_TOKEN` | Shared bearer for every internal route. |
| `PLATFORM_WALLET_KEY` | The Platform Wallet. Imported once by `pnpm seed`. |
| `FACILITATOR_RELAYER_KEY` | Relays every x402 settlement, and pays its gas. |
| `EXCHANGE_API_KEY` / `EXCHANGE_PRIVATE_KEY` | Binance Spot Testnet, for the `execution` agent. |
| `TELEGRAM_BOT_TOKEN` | The `notify` agent. |
| `ANTHROPIC_API_KEY` | The `alpha-research` agent. |

Generate fresh keys for development. Never reuse a personal key, and never give
the exchange credentials to a third-party agent — the `execution` type is
platform-operated for exactly that reason.

### Running without a funded testnet wallet

The BSC testnet faucet needs a human. Until the wallets are funded, the whole
stack runs against a local chain that presents the same `eip155:97` binding, so
no application code changes:

```bash
corepack pnpm local:chain up     # anvil on 97, funds the wallets, deploys, rewrites deployments/97.json
corepack pnpm local:chain down   # kills anvil and restores the BSC testnet addresses
```

This needs Foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`);
`~/.foundry/bin` does not have to be on your PATH. Anvil listens on `0.0.0.0`
so the compose services can reach it, and `up` sets `RPC_URLS_CONTAINER` in
`.env` to point them at `host.docker.internal`. Bring the chain up before
`docker compose up -d`, and re-run `docker compose up -d` after it so the
services pick the address up.

`up` also places a mock ERC-8004 IdentityRegistry at the real BSC testnet
address with `anvil_setCode`, so the identity path is exercised rather than
stubbed. The mock lives under `contracts/test/` and can never reach a public
network.

## Layout

```
apps/web           Next.js 16. Inserts Runs whole; never transitions one.
apps/worker        The only process that transitions Runs and Calls. Signs payments.
apps/facilitator   Self-hosted x402 facilitator. Relays transferWithAuthorization.
apps/agents/*      The six seed agents, one service each.
packages/schemas   Every cross-process contract. Zod.
packages/core      Pure rules: the run machine, signing policy, settlement.
packages/db        Drizzle schema, migrations, repositories.
contracts          Foundry. tUSD (EIP-3009) and AgentDeskRegistry.
scripts            seed, doctor, local:chain, and the wiring that composes the worker.
```

The dependency direction is inward — apps depend on packages, packages never
depend on apps — and `eslint.config.js` enforces it rather than documenting it.

## Contracts

`AgentDeskRegistry` holds each agent's price, stake, reputation in basis points,
pause flags, payout wallet, endpoint, and ERC-8004 identity id. The chain is the
system of record for listings; the database keeps a cache written by exactly one
function, `refreshListingFromChain()`, and refreshed from transaction receipts.

The payment asset is `tUSD`, a test token implementing EIP-3009
`transferWithAuthorization`, so the facilitator relays the transfer and a buyer
wallet needs no gas of its own. BSC's USDT does not implement EIP-3009, which is
why the reference facilitator cannot use it directly.

Deployed addresses live in `deployments/97.json`, read through
`@agent-desk/schemas`. Nothing hard-codes an address.

## Tests

```bash
corepack pnpm test                          # everything
corepack pnpm vitest run --project unit     # no database needed
corepack pnpm vitest run --project integration
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm run doctor                    # note `run`: `pnpm doctor` is pnpm's own
cd contracts && forge test
```

Integration tests need Postgres and take a per-file advisory lock, which is why
they are a separate project that does not run files in parallel.

## What is deliberately not here

Mainnet. Real money. Custody by anyone but the platform's hot wallets. Agent
types beyond the fixed five. Third-party `execution` agents. Branching or
scheduled workflows. Dispute handling. An independent settlement judge. Fee
collection. The settlement rules are crude on purpose, and the demo labels its
shortened rule on screen rather than hiding it.

## The agentURI decision

`PUBLIC_BASE_URL` is deliberately left unset, so every ERC-8004 `agentURI` is a
self-contained `data:` URI rather than a URL on a host we would have to keep
resolving. That needs no DNS, no tunnel, and no human, and an indexer can read
the record with no request back to us. Set `PUBLIC_BASE_URL` to a real public
origin only if you want the hosted `agent.json` instead; `pnpm run doctor`
refuses a loopback or a `trycloudflare.com` host, because an identity row
pointing at a name nobody else can resolve is worse than no name at all.
