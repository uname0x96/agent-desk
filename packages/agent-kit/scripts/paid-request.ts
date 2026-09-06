/**
 * One real paid x402 request against a running agent, end to end: 402, sign,
 * pay, settle, receipt. This is the half of Story 1.5 that no unit test can
 * reach, because it needs a deployed tUSD (Story 1.2), a running facilitator
 * (Story 1.3), and an account holding minted tUSD.
 *
 * Run it once those exist:
 *
 *   AGENT_URL=http://127.0.0.1:4101 \
 *   PAID_REQUEST_KEY=0x<private key of a funded test account> \
 *   corepack pnpm --filter @agent-desk/agent-kit exec tsx scripts/paid-request.ts
 *
 * It exits 0 with a skip message while `deployments/97.json` still holds the
 * zero address for tUSD, so it is safe to run today and in CI.
 *
 * `@x402/fetch` is the packaged form of this flow, but it is a dependency of
 * `packages/adapters`, not of this package, and AD-1 forbids reaching across.
 * `x402HTTPClient` from `@x402/core` is what `wrapFetchWithPayment` wraps, so
 * this is the same client code path with the retry written out.
 */

import { x402Client, x402HTTPClient } from '@x402/core/client'
import type { PaymentRequirements } from '@x402/core/types'
import { ExactEvmScheme } from '@x402/evm'
import { privateKeyToAccount } from 'viem/accounts'
import type { Network } from '@x402/core/types'
import {
  AGENT_TYPES,
  getDeployment,
  isDeployed,
  networkForChain,
  samples,
  toBaseUnits,
  validateOutput,
  X402_HEADERS,
  X402_MAX_TIMEOUT_SECONDS,
  X402_PAID_TIMEOUT_MS,
  X402_SCHEME,
  X402_UNPAID_TIMEOUT_MS,
  type AgentType,
} from '@agent-desk/schemas'

function skip(reason: string): never {
  process.stdout.write(`SKIP paid-request: ${reason}\n`)
  process.exit(0)
}

function fail(reason: string): never {
  process.stderr.write(`FAIL paid-request: ${reason}\n`)
  process.exit(1)
}

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(20)} ${String(value)}\n`)
}

const agentUrl = (process.env.AGENT_URL ?? 'http://127.0.0.1:4101').replace(/\/+$/, '')
const chainId = Number(process.env.CHAIN_ID ?? 97)
const explorerUrl = (process.env.EXPLORER_URL ?? 'https://testnet.bscscan.com').replace(/\/+$/, '')
const rawType = process.env.AGENT_TYPE ?? 'data'
if (!(AGENT_TYPES as readonly string[]).includes(rawType)) {
  fail(`AGENT_TYPE must be one of ${AGENT_TYPES.join(', ')}, got ${rawType}`)
}
const type = rawType as AgentType

const deployment = getDeployment(chainId)
if (!isDeployed(deployment)) {
  skip(
    `deployments/${chainId}.json still holds the zero address for tUSD. ` +
      'Story 1.2 has not deployed the contracts yet, so no account can hold or sign a tUSD payment.',
  )
}

const privateKey = process.env.PAID_REQUEST_KEY?.trim()
if (!privateKey) {
  skip('PAID_REQUEST_KEY is unset; set it to a test account holding minted tUSD.')
}
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  fail('PAID_REQUEST_KEY must be a 32-byte hex private key')
}

const network = networkForChain(chainId) as Network
const account = privateKeyToAccount(privateKey as `0x${string}`)
const client = new x402HTTPClient(new x402Client().register(network, new ExactEvmScheme(account)))

const input = samples[type]

process.stdout.write(`paid-request against ${agentUrl} as ${account.address}\n`)

// 1. The unpaid request, which must answer 402 with the AD-6 binding.
const unpaid = await fetch(`${agentUrl}/`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(input),
  signal: AbortSignal.timeout(X402_UNPAID_TIMEOUT_MS),
})
if (unpaid.status !== 402) {
  fail(`expected 402 from the unpaid request, got ${unpaid.status}`)
}

const paymentRequired = client.getPaymentRequiredResponse(
  (name) => unpaid.headers.get(name),
  await unpaid.json(),
)
const accepts = paymentRequired.accepts[0] as PaymentRequirements | undefined
if (!accepts || paymentRequired.accepts.length !== 1) {
  fail(`expected exactly one accepts entry, got ${paymentRequired.accepts.length}`)
}

process.stdout.write('402 PAYMENT-REQUIRED\n')
line('scheme', accepts.scheme)
line('network', accepts.network)
line('asset', accepts.asset)
line('amount', accepts.amount)
line('payTo', accepts.payTo)
line('maxTimeoutSeconds', accepts.maxTimeoutSeconds)
line('extra', JSON.stringify(accepts.extra))

const problems: string[] = []
if (accepts.scheme !== X402_SCHEME) problems.push(`scheme ${accepts.scheme}`)
if (accepts.network !== network) problems.push(`network ${accepts.network}`)
if (accepts.asset.toLowerCase() !== deployment.tusd.address.toLowerCase()) {
  problems.push(`asset ${accepts.asset}`)
}
if (accepts.maxTimeoutSeconds > X402_MAX_TIMEOUT_SECONDS) {
  problems.push(`maxTimeoutSeconds ${accepts.maxTimeoutSeconds}`)
}
const extra = accepts.extra as { name?: string; version?: string }
if (extra?.name !== deployment.tusd.name || extra?.version !== deployment.tusd.version) {
  problems.push(`extra ${JSON.stringify(accepts.extra)}`)
}
const expectedPrice = process.env.AGENT_PRICE
if (expectedPrice && accepts.amount !== toBaseUnits(expectedPrice).toString()) {
  problems.push(`amount ${accepts.amount} for AGENT_PRICE=${expectedPrice}`)
}
if (problems.length > 0) fail(`402 does not match the AD-6 binding: ${problems.join(', ')}`)

// 2. Sign the payment and retry once, inside the 15 s paid window.
const payload = await client.createPaymentPayload(paymentRequired)
const paid = await fetch(`${agentUrl}/`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...client.encodePaymentSignatureHeader(payload),
  },
  body: JSON.stringify(input),
  signal: AbortSignal.timeout(X402_PAID_TIMEOUT_MS),
})

const result = await client.processResponse(paid)
process.stdout.write(`paid request answered ${result.status} (${result.paymentStatus})\n`)
process.stdout.write(`  body ${JSON.stringify(result.body)}\n`)

if (result.status !== 200) fail(`expected 200 from the paid request, got ${result.status}`)

const checked = validateOutput(type, input, result.body)
if (!checked.ok) fail(`the agent output failed validateOutput: ${checked.error}`)

const receipt = paid.headers.get(X402_HEADERS.response)
if (!receipt) fail(`no ${X402_HEADERS.response} header on the 200`)
const settlement = result.header as { success?: boolean; transaction?: string } | undefined
if (!settlement?.success || !settlement.transaction) {
  fail(`settlement did not succeed: ${JSON.stringify(result.header)}`)
}

process.stdout.write('OK paid-request\n')
line('tx', settlement.transaction)
line('explorer', `${explorerUrl}/tx/${settlement.transaction}`)
