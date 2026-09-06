/**
 * Story 1.3 end-to-end check, run against BSC testnet:
 *
 *   corepack pnpm --filter @agent-desk/facilitator test:integration
 *
 * It boots this facilitator in process, signs a real EIP-3009 authorisation with
 * a funded test account, drives `/verify` and `/settle` over HTTP, confirms the
 * transfer on chain, and then replays the same authorisation to prove the second
 * settle answers an error and broadcasts nothing.
 *
 * It cannot run until Story 1.2 has deployed tUSD and the relayer key exists, so
 * it skips (exit 0) with a message naming exactly what is missing.
 *
 * Required env, beyond the facilitator's own FACILITATOR_RELAYER_KEY / RPC_URLS:
 *   X402_TEST_PAYER_KEY   private key of an account holding minted tUSD and no BNB requirement
 *   X402_TEST_PAYTO       optional recipient, defaults to the relayer address
 *   X402_TEST_AMOUNT      optional decimal tUSD amount, defaults to 0.01
 */
import type { AddressInfo } from 'node:net'
import { createLogger } from '@agent-desk/schemas/logger'
import { getDeployment } from '@agent-desk/schemas'
import { authorizationTypes, eip3009ABI } from '@x402/evm'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import { formatUnits, isAddressEqual, parseUnits, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createApp } from '../../src/app.ts'
import { buildFacilitatorConfig, isTusdDeployed } from '../../src/config.ts'
import { parseFacilitatorEnv, SUPPORTED_CHAIN_ID } from '../../src/env.ts'
import { createFacilitator } from '../../src/facilitator.ts'
import { createRelayer } from '../../src/relayer.ts'

function skip(reason: string): never {
  process.stdout.write(`SKIP: ${reason}\n`)
  process.exit(0)
}

function fail(reason: string): never {
  process.stderr.write(`FAIL: ${reason}\n`)
  process.exit(1)
}

function check(condition: boolean, message: string): void {
  if (!condition) fail(message)
  process.stdout.write(`  ok  ${message}\n`)
}

async function main(): Promise<void> {
  const deployment = getDeployment(SUPPORTED_CHAIN_ID)
  if (!isTusdDeployed(SUPPORTED_CHAIN_ID)) {
    skip(
      `deployments/${SUPPORTED_CHAIN_ID}.json still carries the zero address for tUSD ` +
        `(currently ${deployment.tusd.address}); run the Story 1.2 deploy script first`,
    )
  }

  const envResult = parseFacilitatorEnv()
  if (!envResult.ok) skip(`facilitator env is incomplete: ${envResult.issues.join('; ')}`)
  const env = envResult.env

  const payerKey = process.env.X402_TEST_PAYER_KEY
  if (!payerKey || !/^0x[0-9a-fA-F]{64}$/.test(payerKey)) {
    skip('X402_TEST_PAYER_KEY is not set to a 0x-prefixed 32-byte private key')
  }

  const config = buildFacilitatorConfig(env)
  const relayer = createRelayer(env)
  const payer = privateKeyToAccount(payerKey as `0x${string}`)
  const payTo = (process.env.X402_TEST_PAYTO ?? relayer.address) as `0x${string}`
  const asset = config.x402.asset as `0x${string}`
  const amount = parseUnits(process.env.X402_TEST_AMOUNT ?? '0.01', config.x402.decimals)

  const balanceOf = (account: `0x${string}`) =>
    relayer.publicClient.readContract({
      address: asset,
      abi: eip3009ABI,
      functionName: 'balanceOf',
      args: [account],
    }) as Promise<bigint>

  const relayerBnb = await relayer.publicClient.getBalance({ address: relayer.address })
  if (relayerBnb === 0n) skip(`relayer ${relayer.address} holds no BNB and cannot pay gas`)

  const payerBefore = await balanceOf(payer.address)
  if (payerBefore < amount) {
    skip(
      `payer ${payer.address} holds ${formatUnits(payerBefore, config.x402.decimals)} tUSD, ` +
        `needs ${formatUnits(amount, config.x402.decimals)}; mint first`,
    )
  }
  const payToBefore = await balanceOf(payTo)

  process.env.LOG_LEVEL ??= 'silent'
  const app = createApp({
    config,
    facilitator: createFacilitator(config, relayer),
    probe: {
      address: relayer.address,
      getBalance: () => relayer.publicClient.getBalance({ address: relayer.address }),
      getPendingNonce: () =>
        relayer.publicClient.getTransactionCount({ address: relayer.address, blockTag: 'pending' }),
      getLatestNonce: () => relayer.publicClient.getTransactionCount({ address: relayer.address, blockTag: 'latest' }),
    },
    logger: createLogger('facilitator-integration'),
  })
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening))
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  try {
    const supported = (await (await fetch(`${origin}/supported`)).json()) as {
      kinds: { scheme: string; network: string; extra?: Record<string, unknown> }[]
    }
    check(supported.kinds.length === 1, 'GET /supported lists exactly one kind')
    check(supported.kinds[0]?.scheme === 'exact', 'the kind is the exact scheme')
    check(supported.kinds[0]?.network === config.x402.network, `the kind is on ${config.x402.network}`)
    check(supported.kinds[0]?.extra?.asset === asset, 'the kind carries the configured tUSD asset')

    const healthResponse = await fetch(`${origin}/health`)
    check(healthResponse.status === 200, 'GET /health answers 200 against a live RPC')

    const now = Math.floor(Date.now() / 1000)
    const authorization = {
      from: payer.address,
      to: payTo,
      value: amount.toString(),
      validAfter: '0',
      validBefore: String(now + 300),
      nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
    }
    const signature = await payer.signTypedData({
      domain: {
        name: config.x402.extra.name,
        version: config.x402.extra.version,
        chainId: config.chainId,
        verifyingContract: asset,
      },
      types: authorizationTypes,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    })

    const requirements: PaymentRequirements = {
      scheme: 'exact',
      network: config.x402.network as `${string}:${string}`,
      asset,
      amount: amount.toString(),
      payTo,
      maxTimeoutSeconds: config.x402.maxTimeoutSeconds,
      extra: { ...config.x402.extra },
    }
    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: { signature, authorization },
    }

    const post = (path: string, body: unknown) =>
      fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

    const verify = (await (
      await post('/verify', { x402Version: 2, paymentPayload, paymentRequirements: requirements })
    ).json()) as { isValid: boolean; invalidReason?: string }
    check(verify.isValid, `POST /verify answers valid (${verify.invalidReason ?? 'no reason'})`)

    const settle = (await (
      await post('/settle', { x402Version: 2, paymentPayload, paymentRequirements: requirements })
    ).json()) as { success: boolean; transaction: string; errorReason?: string }
    check(settle.success, `POST /settle answers success (${settle.errorReason ?? 'no reason'})`)
    check(/^0x[0-9a-fA-F]{64}$/.test(settle.transaction), `the response carries a tx hash: ${settle.transaction}`)

    const receipt = await relayer.publicClient.waitForTransactionReceipt({
      hash: settle.transaction as `0x${string}`,
    })
    check(receipt.status === 'success', 'the transaction is confirmed on BSC testnet')

    const payerAfter = await balanceOf(payer.address)
    const payToAfter = await balanceOf(payTo)
    if (isAddressEqual(payer.address, payTo)) {
      check(payerAfter === payerBefore, 'payer and payTo are the same account, balance is unchanged')
    } else {
      check(payerBefore - payerAfter === amount, `exactly ${amount} base units left the payer`)
      check(payToAfter - payToBefore === amount, `exactly ${amount} base units reached payTo`)
    }

    const pendingBefore = await relayer.publicClient.getTransactionCount({
      address: relayer.address,
      blockTag: 'pending',
    })
    const replay = (await (
      await post('/settle', { x402Version: 2, paymentPayload, paymentRequirements: requirements })
    ).json()) as { success: boolean; errorReason?: string; transaction: string }
    check(!replay.success, `the second settle answers an error (${replay.errorReason})`)
    check(replay.transaction === '', 'the second settle carries no tx hash')
    const pendingAfter = await relayer.publicClient.getTransactionCount({
      address: relayer.address,
      blockTag: 'pending',
    })
    check(pendingAfter === pendingBefore, 'the second settle sent no transaction')

    const noExtra = { ...requirements, extra: undefined as unknown as Record<string, unknown> }
    const missingExtra = (await (
      await post('/verify', {
        x402Version: 2,
        paymentPayload: { ...paymentPayload, accepted: noExtra },
        paymentRequirements: noExtra,
      })
    ).json()) as { isValid: boolean; invalidReason?: string }
    check(!missingExtra.isValid, `an authorisation without extra is rejected (${missingExtra.invalidReason})`)

    const wrongAsset = { ...requirements, asset: '0x000000000000000000000000000000000000dEaD' }
    const assetMismatch = (await (
      await post('/verify', {
        x402Version: 2,
        paymentPayload: { ...paymentPayload, accepted: wrongAsset },
        paymentRequirements: wrongAsset,
      })
    ).json()) as { isValid: boolean; invalidReason?: string }
    check(!assetMismatch.isValid, `a different asset is rejected (${assetMismatch.invalidReason})`)

    process.stdout.write('PASS: facilitator settled tUSD on eip155:97 and refused the replay\n')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

await main()
