# contracts

Foundry 1.8.1. Two contracts: `TUSD`, the ERC-3009 token every x402 payment settles in
(AD-6), and `AgentDeskRegistry`, the on-chain system of record for Listings (AD-2).

## Dependencies

Vendored into `lib/` with `--no-git`, and `lib/` is gitignored, so a fresh clone restores
them with:

```sh
pnpm --filter contracts deps
```

That pins `forge-std` at `v1.11.0` and `openzeppelin-contracts` at the **`v5.7.0` tag**.
The tag matters: `v5.7.0` still ships `token/ERC20/extensions/draft-ERC3009.sol`, which is
the ERC-3009 base tUSD is built on. `remappings.txt` is checked in, so the import paths do
not depend on auto-detection.

## Build, test, export

```sh
pnpm --filter contracts build   # forge build, then export the ABI into packages/adapters
pnpm --filter contracts test    # forge test
```

Those two need `- contracts` added to `packages:` in `pnpm-workspace.yaml`; it is not there
yet, so pnpm answers "No projects matched the filters". Until then, run `forge build &&
node script/export-abi.mjs` and `forge test` from this directory. Deploying also wants
`ETHERSCAN_API_KEY` in `.env.example`, which is likewise not there yet.

`script/export-abi.mjs` writes `packages/adapters/src/chain/abi/{TUSD,AgentDeskRegistry,
IdentityRegistry}.json` and fails the build if a function or event the adapters rely on has
gone missing, or if tUSD ever grows the keyed-sequential-nonce ERC-3009 variant (see below).

## Deploying to BSC testnet

The deployer key is the Platform Wallet, and it becomes the registry's immutable `platform`
address — the only account that may `slash` or `setReputation`. Getting it wrong means
redeploying the registry.

```sh
export PLATFORM_WALLET_KEY=0x...        # 0x-prefixed, 64 hex characters
export ETHERSCAN_API_KEY=...            # Etherscan V2, multichain; serves testnet.bscscan.com
export RPC_URL=https://bsc-testnet-dataseed.bnbchain.org   # RPC_URLS[0] from .env

pnpm --filter contracts deploy
```

That runs `forge script script/Deploy.s.sol:Deploy --broadcast --verify`, which deploys both
contracts, verifies them on `testnet.bscscan.com` through the Etherscan V2 API, and writes
`deployments/97.json` — the only place any process reads a contract address from (AD-10,
AD-14). It then runs `script/sync-deployment.mjs`, which replaces the block numbers with the
exact ones from the broadcast receipts; the script itself can only record the block it
forked from, because Solidity cannot see its own receipts.

Afterwards, put the deploy key, `deployments/97.json`, and both addresses in the team
password manager.

## Two things that are load-bearing and easy to undo by accident

**tUSD must not inherit `ERC20TransferAuthorization`.** OpenZeppelin ships two ERC-3009
bases. `draft-ERC3009.sol` tracks nonces as a set, which is what ERC-3009 specifies and what
x402 needs: it generates random 32-byte nonces and settles them in whatever order the
facilitator gets to them. `ERC20TransferAuthorization` reads the same `bytes32` as an
ERC-4337 keyed *sequential* nonce and rejects anything out of order, so every payment after
the first would fail. `TUSDTest.test_UnorderedRandomNoncesBothSettle` settles the maximum
nonce and then nonce 1 to prove the set behaviour, and `export-abi.mjs` fails the build if
the keyed variant's `bytes signature` overload ever appears in the ABI.

**The EIP-712 domain is `("tUSD", "1")`.** It reaches clients as the 402's
`extra { name, version }`, published from `deployments/97.json`. `Deploy.s.sol` reads both
values back out of the deployed token's `eip712Domain()` instead of hardcoding them, and
`TUSDTest.test_Eip712DomainIsTUSDVersion1` asserts them, so the file cannot publish a domain
the token does not verify against.

## IdentityRegistry

Not deployed here. The ERC-8004 registry is already live on BSC testnet at
`0x8004A818BFB912233c491871b3d84c89A494BD9e` (an ERC-1967 proxy over
`0x7274e874ca62410a93bd8bf61c69d8045e399c02`). `src/interfaces/IIdentityRegistry.sol` declares
only the slice AgentDesk calls, so `export-abi.mjs` can emit a compiler-checked ABI for it.
Every member was verified against that deployment on 2026-09-06: the selectors are present in
the implementation's dispatcher, `register(string)` returns the new agent id under `eth_call`,
and a live `Registered` log carries three topics (signature, `agentId`, `owner`) with the URI
in `data`.
