# AgentDesk

**A marketplace for composing agent workflows, paying providers per call, and tracing payments and settlement outcomes on-chain.**

Built for the Binance hackathon, Payment Workflows track. Builders select specialist agents, set a budget, and run a sequence. Creators publish services with a call price, identity and collateral. Each run connects agent results to payment records, while settlement connects evaluated outcomes to reputation and call-fee refunds.

## Pitch and project materials

- **[English pitch deck (PDF)](pitching-deck/AgentDesk-Pitch-Deck-EN.pdf)**: 12 slides covering the problem, product, working demonstration and proposed pilot.
- [Project submission](docs/SUBMISSION.md): product rationale and hackathon narrative.
- [Demo script](docs/DEMO-SCRIPT.md): demonstration walkthrough.
- [Vietnamese product brief](docs/brief-vi.md): original vision and business hypotheses.

The submission and original brief include planned capabilities. The implementation and recorded-demo boundaries below describe the current prototype. The proposed 2–5% platform fee is a business hypothesis; fee collection is not implemented.

## What it does

### Agent marketplace

Listings expose an agent's type, endpoint, price per call, stake, reputation and ERC-8004 identity. Builders filter providers and inspect their history before selecting one for a workflow. An active listing describes registry status; it does not guarantee that the service has valid runtime credentials.

Creators register an endpoint through a paid verification call and schema check. Registration creates an identity and locks collateral in the registry. Creators can top up stake, change prices, pause or resume a listing, and refresh its state from the chain. The ownership wallet and service payout wallet can be different.

### Workflow builder and execution

The current engine supports linear workflows across five fixed types:

| Type | Responsibility | Included provider |
| --- | --- | --- |
| `data` | Fetch market data | Binance Ticker |
| `research` | Produce an analysis or signal | Alpha Research, Sloppy Research |
| `risk` | Evaluate an intended order | Guardrail Risk |
| `execution` | Submit an exchange order | Binance Spot Executor, platform-operated |
| `notify` | Deliver a run summary | Telegram Notifier |

Builders choose one provider per node. The builder validates dependency order, shows the maximum call fee, and blocks runs that exceed the account budget. An exchange order cap is separate from the budget for agent service fees.

At run creation, **Price Lock** records each node's terms. The worker validates x402 payment requests against the locked amount, network, token and recipient before signing. The facilitator relays the authorized transfer to the provider's payout wallet. The run view shows agent logs, results, costs and transaction links.

### Settlement and controls

Settlement evaluates eligible `research` and `risk` calls using the configured rules. A failed scored call can trigger a stake deduction, a buyer refund and an on-chain reputation update. A completed call and a correct research signal are separate outcomes. **Refunds cover agent-call fees, not trading losses.**

Operator tools include an emergency stop, mode controls, account lookup and budget-window reset. The prototype uses platform-managed encrypted System Wallets. Direct transfers to provider payout wallets do not make this a non-custodial system.

## Recorded demonstration

The browser recording captured on **6 September 2026** uses a **local Anvil chain**, test tokens and chain ID `97`. It does not establish public-testnet transactions or real-money trading. The English pitch deck uses screenshots from that recording.

| Demonstrated capability | Recorded result |
| --- | --- |
| Marketplace and workflow builder | Filtered providers, built a five-node workflow, checked invalid ordering and swapped research providers. |
| Data and research execution | Two completed two-node runs, each costing `0.04 tUSD`. One uses a newly registered provider. |
| Creator onboarding and registration | Created an account and wallet, verified a service, registered identity `16` and registry entry `17`, and staked `0.30 tUSD`. |
| Provider management | Added two `0.20 tUSD` top-ups, changed the price, and paused/resumed the listing. |
| Payment and settlement | Verified a `0.03 tUSD` provider payment and a `0.03 tUSD` penalty/refund. The new listing ends with `0.67 tUSD` stake. |
| Budget enforcement | A `0.005 tUSD` budget blocks a `0.01 tUSD` call before payment. |
| Operator controls | Exercised stop/resume, mode changes, account lookup and budget-window reset. |

The five-node run completes Data and Research but encounters `exchange balance unavailable` at Risk and `no Telegram chat id linked` for notification. The recording does **not** demonstrate a completed exchange order, Telegram delivery or end-to-end exchange enforcement. Alpha Research, exchange execution and Telegram require missing credentials or configuration.

The recording uses an explorer at `http://localhost:5100`. That explorer is separate from this repository's Compose stack. Its BSC Testnet label reflects chain ID `97`, not publication to the public testnet.

## Run locally

### Prerequisites

- Node.js `24.19.0` or newer, with Corepack. The repository pins pnpm in [package.json](package.json).
- Docker with Compose.
- Foundry (`anvil` and `forge`) for the local-chain path.
- Development secrets in `.env`, based on [.env.example](.env.example).

### Start the local-chain stack

From a fresh clone:

```bash
corepack pnpm install --frozen-lockfile
cp .env.example .env
```

Fill the core secrets listed below before starting the services. Then run:

```bash
# Start Anvil, fund local wallets and deploy local contracts.
corepack pnpm local:chain up

# Start Postgres, migrations, the app, worker, facilitator and agent services.
docker compose up -d

# Create demo accounts, wallets, six listed agents and three workflows.
corepack pnpm seed

# Recreate agent services with the payout addresses written by seed.
docker compose up -d

# Check core infrastructure readiness.
corepack pnpm run doctor
```

The second Compose command is intentional. Seed writes `.env.seed.platform` and `.env.seed`, which provide the agent payout addresses. Before those files exist, agent services can restart with an `AGENT_PAYTO` configuration error. Alpha Research, execution and notification also need their service-specific configuration to support the full workflow.

| Service | Local address |
| --- | --- |
| Web application | <http://localhost:3000> |
| x402 facilitator | <http://localhost:4020> |
| Agent services | Ports `4101` through `4107` |
| Anvil RPC | <http://127.0.0.1:8545> |
| PostgreSQL | Port `5432` |

Compose starts seven agent service instances: six seed providers plus a second Sloppy Research endpoint for demonstrating a new creator listing.

### Configuration

| Variable | Purpose |
| --- | --- |
| `MASTER_KEY` | 32-byte, base64 AES-256-GCM key for System Wallet private keys. |
| `SESSION_SECRET` | Session-cookie encryption secret, at least 32 characters. |
| `INTERNAL_TOKEN` | Shared bearer token for internal routes. |
| `PLATFORM_WALLET_KEY` | Development Platform Wallet key, imported by seed. |
| `FACILITATOR_RELAYER_KEY` | Relayer key used to pay transaction gas. |
| `ANTHROPIC_API_KEY` | Required for Alpha Research. |
| `EXCHANGE_API_KEY` / `EXCHANGE_PRIVATE_KEY` | Binance Spot Testnet credentials for exchange execution. |
| `TELEGRAM_BOT_TOKEN` | Required for Telegram notification. |
| `PLATFORM_CHAT_ID` / `SEED_TELEGRAM_CHAT_ID` | Chat recipients for notification verification and seeded demo accounts. |

Use development keys, and keep `.env` and generated wallet files out of Git. Exchange credentials belong to the platform-operated execution service. See the [Telegram setup guide](apps/agents/telegram-notifier/README.md) for bot creation and account chat linking.

Host commands read host addresses from `.env`. Compose overrides `DATABASE_URL`, `FACILITATOR_URL` and `RPC_URLS` for container networking. Keep `SEED_*_URL` values as Compose service names when the worker runs inside Docker: those values become the endpoints that the worker calls.

`local:chain up` updates `deployments/97.json` and the RPC settings in `.env`. Containers reach Anvil through `host.docker.internal:8545`. Re-run `docker compose up -d` after switching RPC configuration.

### Readiness and rehearsal

`corepack pnpm run doctor` checks the database, RPC, facilitator, wallet gas floors, worker heartbeat and identity-origin configuration. A passing result does **not** verify Anthropic credentials, exchange execution or Telegram delivery. Check those integrations separately before attempting the full five-node demonstration.

Once all required integrations work, run:

```bash
corepack pnpm seed --warm
```

Warm-up runs the configured good chain and waits for the reputation and settlement records needed by the rehearsal. It can fail when downstream integrations are not configured.

### Stop the local stack

```bash
docker compose down
corepack pnpm local:chain down
```

The local-chain command stops Anvil and restores the backed-up deployment addresses and RPC configuration. Local mode places a development mock ERC-8004 IdentityRegistry at the configured identity address with `anvil_setCode`; this mock is not a public-testnet deployment.

For the public-testnet path, use funded development wallets, deployed contracts and matching RPC settings. See [contract deployment instructions](contracts/README.md). Exchange operations target Binance Spot Testnet. Mainnet and real-money operation are outside this prototype's scope.

## Architecture

| Location | Responsibility |
| --- | --- |
| `apps/web` | Next.js interface. Creates Runs and exposes account, marketplace and operator views. |
| `apps/worker` | Transitions Runs and Calls, signs payments and performs settlement work. |
| `apps/facilitator` | Self-hosted x402 facilitator that relays authorized token transfers. |
| `apps/agents/*` | Specialist HTTP agent services. |
| `packages/agent-kit` | Shared agent runtime, payment integration and schema validation. |
| `packages/schemas` | Cross-process contracts and Zod schemas. |
| `packages/core` | Run state machine, signing policy and settlement rules. |
| `packages/adapters` | External service and chain adapters. |
| `packages/db` | Drizzle schema, migrations and repositories. |
| `contracts` | Foundry contracts for tUSD and AgentDeskRegistry. |
| `scripts` | Seed, readiness checks, local-chain setup and worker wiring. |

Apps depend on packages, and packages do not depend on apps. ESLint enforces this dependency direction. The worker owns Run and Call transitions so the web layer does not independently advance execution state.

### Registry and payment asset

`AgentDeskRegistry` stores each listing's price, stake, reputation, pause state, payout wallet, endpoint and identity ID. The chain is the source of record for listings. The database caches that state through `refreshListingFromChain()` and transaction receipts.

Payments use **tUSD**, a test token implementing EIP-3009 `transferWithAuthorization`. The facilitator pays gas for call-payment transfers. This does not remove gas requirements for registration and other wallet operations. Service fees in tUSD are separate from exchange order sizes expressed in USDT.

Contract addresses come from [deployments/97.json](deployments/97.json) through the shared schemas package. Match this file to the RPC network in use.

### Identity metadata

When `PUBLIC_BASE_URL` is empty, each ERC-8004 `agentURI` uses a self-contained `data:` URI. Setting a public origin enables hosted `agent.json` metadata. The readiness check rejects loopback and `trycloudflare.com` origins for this setting.

## Development checks

```bash
corepack pnpm test
corepack pnpm vitest run --project unit
corepack pnpm vitest run --project integration
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm run doctor
```

Run contract tests from `contracts/` with `forge test`. Integration tests require PostgreSQL and use per-file advisory locks. Use `pnpm run doctor`, since pnpm has its own built-in `doctor` command.

## Current limits and next steps

The prototype has no mainnet support, real-money withdrawals, custom agent types, third-party execution providers, branching or scheduled workflows, dispute handling, independent settlement judge, or platform fee collection.

The next proposed milestone is a controlled pilot: complete the exchange and notification integrations, demonstrate the full sequence on a public testnet, strengthen signing and custody controls, and validate repeat paid usage. Independent evaluation and more flexible workflows remain planned work.
