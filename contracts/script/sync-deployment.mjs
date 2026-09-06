#!/usr/bin/env node
// Replaces the block numbers (and re-confirms the addresses) in deployments/<chain>.json
// with the exact values from the last broadcast.
//
// Deploy.s.sol writes the file itself, but a Solidity script cannot see its own receipts,
// so the block numbers it writes are the block it forked from: correct as a floor, one or
// two blocks early as a fact. This reads broadcast/Deploy.s.sol/<chain>/run-latest.json,
// which forge writes after the transactions are mined, and corrects them.
//
// Idempotent: running it twice against the same broadcast changes nothing.

import {readFileSync, writeFileSync, existsSync} from 'node:fs'
import {dirname, join, relative} from 'node:path'
import {fileURLToPath} from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const contractsRoot = join(here, '..')
const repoRoot = join(contractsRoot, '..')
const chainId = process.env.CHAIN_ID ?? '97'

const broadcastPath = join(contractsRoot, 'broadcast', 'Deploy.s.sol', chainId, 'run-latest.json')
const deploymentPath = join(repoRoot, 'deployments', `${chainId}.json`)

const fail = (message) => {
  console.error(`[sync-deployment] ${message}`)
  process.exit(1)
}

if (!existsSync(broadcastPath)) {
  fail(`no broadcast at ${relative(repoRoot, broadcastPath)}. Run the deploy script with --broadcast first.`)
}
if (!existsSync(deploymentPath)) fail(`no ${relative(repoRoot, deploymentPath)}`)

const broadcast = JSON.parse(readFileSync(broadcastPath, 'utf8'))
const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'))

const blockByHash = new Map(
  (broadcast.receipts ?? []).map((receipt) => [receipt.transactionHash, Number(receipt.blockNumber)]),
)

/** The CREATE transaction for `contractName`, with the block its receipt landed in. */
const creationOf = (contractName) => {
  const tx = (broadcast.transactions ?? []).find(
    (candidate) => candidate.transactionType === 'CREATE' && candidate.contractName === contractName,
  )
  if (!tx) fail(`the broadcast has no CREATE transaction for ${contractName}`)
  const block = blockByHash.get(tx.hash)
  if (!Number.isInteger(block)) fail(`no mined receipt for ${contractName} (${tx.hash})`)
  return {address: tx.contractAddress, block}
}

const tusd = creationOf('TUSD')
const registry = creationOf('AgentDeskRegistry')

// Deploy.s.sol is the only writer of addresses, so that the file keeps one casing
// throughout; this only cross-checks them and then corrects the block numbers.
for (const [key, {address}] of [
  ['tusd', tusd],
  ['registry', registry],
]) {
  const recorded = deployment[key]?.address ?? ''
  if (recorded.toLowerCase() !== address.toLowerCase()) {
    fail(
      `${key} is ${recorded} in the deployment file but ${address} in the broadcast. ` +
        'These are different deployments; re-run the deploy script rather than syncing.',
    )
  }
}

deployment.deployedAtBlock = {tusd: tusd.block, registry: registry.block}

writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`)
console.log(
  `[sync-deployment] ${relative(repoRoot, deploymentPath)}: tusd ${tusd.address} @ ${tusd.block}, ` +
    `registry ${registry.address} @ ${registry.block}`,
)
