/**
 * Bring up a local Anvil chain that behaves like BSC testnet, deploy tUSD and the
 * AgentDeskRegistry onto it, and fund every key in `.env`.
 *
 * Why this exists: the BSC testnet faucet needs a human (it gates on either a mainnet
 * balance or a captcha), so nothing can be deployed to the real testnet until someone
 * funds the Platform Wallet. Anvil closes that gap. Run with `--chain-id 97` it produces
 * the same `eip155:97` binding the x402 config publishes, so the entire stack, including
 * the facilitator and every agent, runs unmodified.
 *
 * Two things are local-only and both are visible rather than hidden. The ERC-8004
 * IdentityRegistry is a mock whose runtime code is placed at the real registry address
 * with `anvil_setCode`. And `deployments/97.json` is overwritten with the Anvil addresses,
 * so `--restore` puts the tracked BSC testnet file back.
 *
 * Usage:
 *   pnpm local:chain up        start anvil, deploy, fund, rewrite deployments/97.json
 *   pnpm local:chain down      stop anvil and restore deployments/97.json
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, http, parseEther, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const ROOT = join(import.meta.dirname, '..', '..')
const RUNTIME = join(ROOT, '.local-chain')
const PID_FILE = join(RUNTIME, 'anvil.pid')
const BACKUP = join(RUNTIME, 'deployments-97.bsc-testnet.json')
const DEPLOYMENTS = join(ROOT, 'deployments', '97.json')
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e'
const RPC = 'http://127.0.0.1:8545'
const CHAIN_ID = 97

/** Anvil's first well-known account. Public, funded, and worthless. */
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex

const chain = {
  id: CHAIN_ID,
  name: 'anvil-bsc-testnet',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const

function env(): Record<string, string> {
  const file = join(ROOT, '.env')
  if (!existsSync(file)) throw new Error('.env is missing. See .env.example.')
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match?.[1] !== undefined) out[match[1]] = match[2] ?? ''
  }
  return out
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await response.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

async function waitForRpc(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await rpc('eth_chainId', [])
      return
    } catch {
      if (Date.now() > deadline) throw new Error('anvil did not come up within 20s')
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

async function up(): Promise<void> {
  mkdirSync(RUNTIME, { recursive: true })
  if (!existsSync(BACKUP)) writeFileSync(BACKUP, readFileSync(DEPLOYMENTS))

  const anvil = spawn(
    'anvil',
    ['--chain-id', String(CHAIN_ID), '--host', '127.0.0.1', '--port', '8545', '--silent'],
    { detached: true, stdio: 'ignore' },
  )
  anvil.unref()
  writeFileSync(PID_FILE, String(anvil.pid))
  await waitForRpc()
  console.log(`anvil up on ${RPC} as chain ${CHAIN_ID} (pid ${anvil.pid})`)

  const vars = env()
  const funded = [
    vars.PLATFORM_WALLET_ADDRESS,
    vars.FACILITATOR_RELAYER_ADDRESS,
    vars.DEMO_CREATOR_ADDRESS,
  ].filter((a): a is string => Boolean(a))
  for (const address of funded) {
    await rpc('anvil_setBalance', [address, `0x${parseEther('1000').toString(16)}`])
  }
  console.log(`funded ${funded.length} addresses with 1000 BNB each`)

  // Place the mock ERC-8004 registry at the address the real one occupies on BSC testnet,
  // so no application code needs a local-only branch.
  const account = privateKeyToAccount(ANVIL_KEY)
  const wallet = createWalletClient({ account, chain, transport: http(RPC) })
  const publicClient = createPublicClient({ chain, transport: http(RPC) })
  const artifact = JSON.parse(
    readFileSync(join(ROOT, 'contracts/out/MockIdentityRegistry.sol/MockIdentityRegistry.json'), 'utf8'),
  ) as { bytecode: { object: Hex } }
  const hash = await wallet.deployContract({ abi: [], bytecode: artifact.bytecode.object })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  const code = await publicClient.getCode({ address: receipt.contractAddress! })
  await rpc('anvil_setCode', [IDENTITY_REGISTRY, code])
  console.log(`mock ERC-8004 IdentityRegistry placed at ${IDENTITY_REGISTRY}`)

  execFileSync(
    'forge',
    ['script', 'script/Deploy.s.sol:Deploy', '--rpc-url', RPC, '--broadcast', '--silent'],
    { cwd: join(ROOT, 'contracts'), env: { ...process.env, ...vars }, stdio: 'inherit' },
  )
  const deployed = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')) as {
    tusd: { address: string }
    registry: { address: string }
  }
  console.log(`tUSD ${deployed.tusd.address}`)
  console.log(`AgentDeskRegistry ${deployed.registry.address}`)
  console.log('\ndeployments/97.json now points at the local chain. `pnpm local:chain down` restores it.')
}

function down(): void {
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, 'utf8'))
    try {
      process.kill(pid)
      console.log(`stopped anvil (pid ${pid})`)
    } catch {
      console.log('anvil was not running')
    }
    rmSync(PID_FILE)
  }
  if (existsSync(BACKUP)) {
    writeFileSync(DEPLOYMENTS, readFileSync(BACKUP))
    rmSync(BACKUP)
    console.log('restored the BSC testnet deployments/97.json')
  }
}

const command = process.argv[2] ?? 'up'
if (command === 'up') await up()
else if (command === 'down') down()
else {
  console.error(`unknown command ${command}. Use "up" or "down".`)
  process.exit(1)
}
