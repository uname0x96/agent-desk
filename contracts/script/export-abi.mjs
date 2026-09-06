#!/usr/bin/env node
// Exports the ABI of every contract AgentDesk talks to into
// packages/adapters/src/chain/abi/ (AD-8). Run by `pnpm --filter contracts build`
// straight after `forge build`; the adapters import only these files, never `out/`.
//
// The exported JSON is a bare ABI array, which is what viem's `abi:` option takes.
//
// Nothing here is cosmetic: the assertions below are the guard that a refactor in
// contracts/src cannot silently change the shape the TypeScript side is compiled against.

import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs'
import {dirname, join, relative} from 'node:path'
import {fileURLToPath} from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const contractsRoot = join(here, '..')
const repoRoot = join(contractsRoot, '..')
const outDir = join(contractsRoot, 'out')
const abiDir = join(repoRoot, 'packages', 'adapters', 'src', 'chain', 'abi')

/**
 * `artifact` is the path under `out/`; `as` is the exported file name.
 * IdentityRegistry is exported from an interface, not an implementation: the contract is
 * already deployed on BSC testnet and AgentDesk only calls it.
 */
const targets = [
  {artifact: 'TUSD.sol/TUSD.json', as: 'TUSD.json'},
  {artifact: 'AgentDeskRegistry.sol/AgentDeskRegistry.json', as: 'AgentDeskRegistry.json'},
  {artifact: 'IIdentityRegistry.sol/IIdentityRegistry.json', as: 'IdentityRegistry.json'},
]

/** Human-readable signature, e.g. `transferWithAuthorization(address,uint256,uint8)`. */
const signatureOf = (entry) => `${entry.name}(${(entry.inputs ?? []).map(typeOf).join(',')})`
const typeOf = (input) =>
  input.type === 'tuple' || input.type === 'tuple[]'
    ? `(${input.components.map(typeOf).join(',')})${input.type.slice(5)}`
    : input.type

/** Every function and event a downstream package is entitled to find. */
const required = {
  'TUSD.json': {
    function: [
      'authorizationState(address,bytes32)',
      'transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
      'approve(address,uint256)',
      'balanceOf(address)',
      'decimals()',
      'eip712Domain()',
      'mint(address,uint256)',
    ],
    event: ['AuthorizationUsed(address,bytes32)', 'Transfer(address,address,uint256)'],
  },
  'AgentDeskRegistry.json': {
    function: [
      'list(uint256,string,uint256,string,address,uint256)',
      'addStake(uint256,uint256)',
      'setPrice(uint256,uint256)',
      'setPaused(uint256,bool)',
      'slash(uint256,bytes32,uint256,address)',
      'setReputation(uint256,uint16)',
      'getListing(uint256)',
    ],
    event: [
      'Listed(uint256,address,uint256,string,uint256,string,address,uint256)',
      'Staked(uint256,address,uint256,uint256)',
      'PriceSet(uint256,uint256)',
      'Paused(uint256,bool,bool)',
      'Slashed(uint256,bytes32,uint256)',
      'ReputationSet(uint256,uint16)',
    ],
  },
  'IdentityRegistry.json': {
    function: ['register(string)', 'setAgentURI(uint256,string)'],
    event: ['Registered(uint256,string,address)'],
  },
}

/**
 * x402 sends unordered random 32-byte nonces. OpenZeppelin's ERC20TransferAuthorization
 * reads the same bytes32 as an ERC-4337 keyed sequential nonce and rejects anything out of
 * sequence, so tUSD must never inherit it. Its distinguishing surface is the
 * `bytes signature` overload; if that ever appears in the exported ABI, the token was
 * rebuilt on the wrong base and every payment would start failing on the second call.
 */
const forbidden = {
  'TUSD.json': [
    'transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)',
    'nonces(address,uint192)',
  ],
}

if (!existsSync(outDir)) {
  console.error(`[export-abi] ${relative(repoRoot, outDir)} is missing. Run \`forge build\` first.`)
  process.exit(1)
}

mkdirSync(abiDir, {recursive: true})

let failures = 0
for (const {artifact, as} of targets) {
  const source = join(outDir, artifact)
  if (!existsSync(source)) {
    console.error(`[export-abi] no artifact at ${relative(contractsRoot, source)}`)
    failures += 1
    continue
  }

  const {abi} = JSON.parse(readFileSync(source, 'utf8'))
  if (!Array.isArray(abi) || abi.length === 0) {
    console.error(`[export-abi] ${artifact} carries no ABI`)
    failures += 1
    continue
  }

  const present = new Set(abi.filter((e) => e.name).map((e) => `${e.type}:${signatureOf(e)}`))
  for (const [kind, signatures] of Object.entries(required[as] ?? {})) {
    for (const signature of signatures) {
      if (!present.has(`${kind}:${signature}`)) {
        console.error(`[export-abi] ${as} is missing ${kind} ${signature}`)
        failures += 1
      }
    }
  }
  for (const signature of forbidden[as] ?? []) {
    if (present.has(`function:${signature}`)) {
      console.error(`[export-abi] ${as} must not expose ${signature} (keyed sequential nonces)`)
      failures += 1
    }
  }

  const destination = join(abiDir, as)
  const json = `${JSON.stringify(abi, null, 2)}\n`
  const unchanged = existsSync(destination) && readFileSync(destination, 'utf8') === json
  if (!unchanged) writeFileSync(destination, json)
  console.log(
    `[export-abi] ${unchanged ? 'unchanged' : 'wrote'} ${relative(repoRoot, destination)} ` +
      `(${abi.length} entries)`,
  )
}

if (failures > 0) {
  console.error(`[export-abi] ${failures} problem(s); the ABI export is not usable.`)
  process.exit(1)
}
