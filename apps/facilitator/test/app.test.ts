import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLogger } from '@agent-desk/schemas/logger'
import type { Server } from 'node:http'
import { createApp } from '../src/app.ts'
import { createFacilitator } from '../src/facilitator.ts'
import type { Relayer } from '../src/relayer.ts'
import { REJECTION } from '../src/scheme.ts'
import { ASSET, OTHER_ASSET, PAYER, RELAYER, fakeSigner, payload, requirements, testConfig } from './fixtures.ts'

process.env.LOG_LEVEL = 'silent'

const config = testConfig()
const { signer, calls } = fakeSigner({ authorizationState: true })
const relayer = { address: RELAYER, signer } as unknown as Relayer

let server: Server
let origin: string

beforeAll(async () => {
  const app = createApp({
    config,
    facilitator: createFacilitator(config, relayer),
    probe: {
      address: RELAYER,
      getBalance: async () => 50_000_000_000_000_000n,
      getPendingNonce: async () => 4,
      getLatestNonce: async () => 4,
    },
    logger: createLogger('facilitator-test'),
  })
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening))
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

function post(path: string, body: unknown) {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /supported', () => {
  it('lists exactly one network, scheme and asset', async () => {
    const response = await fetch(`${origin}/supported`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.kinds).toEqual([
      {
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:97',
        extra: { asset: ASSET, decimals: 6, name: 'tUSD', version: '1' },
      },
    ])
    expect(body.extensions).toEqual([])
    expect(body.signers).toEqual({ 'eip155:*': [RELAYER] })
  })
})

describe('GET /health', () => {
  it('answers 200 with the relayer address, balance and pending nonce count', async () => {
    const response = await fetch(`${origin}/health`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.relayer).toEqual({
      address: RELAYER,
      bnbBalanceWei: '50000000000000000',
      bnbBalance: '0.05',
      pendingNonceCount: 0,
    })
  })
})

describe('POST /verify', () => {
  it('rejects an authorisation whose extra is missing', async () => {
    const accepted = requirements({ extra: undefined as unknown as Record<string, unknown> })
    const response = await post('/verify', {
      x402Version: 2,
      paymentPayload: payload(accepted),
      paymentRequirements: accepted,
    })
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body).toMatchObject({ isValid: false, invalidReason: REJECTION.missingExtra, payer: PAYER })
  })

  it('rejects an asset that differs from the configured one', async () => {
    const accepted = requirements({ asset: OTHER_ASSET })
    const response = await post('/verify', {
      x402Version: 2,
      paymentPayload: payload(accepted),
      paymentRequirements: accepted,
    })
    const body = await json(response)
    expect(body).toMatchObject({ isValid: false, invalidReason: REJECTION.unsupportedAsset })
  })

  it('answers 400 for a malformed body', async () => {
    const response = await post('/verify', { x402Version: 2 })
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.invalidReason).toBe('invalid_request_body')
  })

  it('answers 200 with unsupported_scheme_or_network for a network it never registered', async () => {
    const accepted = requirements({ network: 'solana:devnet' })
    const response = await post('/verify', {
      x402Version: 2,
      paymentPayload: payload(accepted),
      paymentRequirements: accepted,
    })
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body).toMatchObject({ isValid: false, invalidReason: 'unsupported_scheme_or_network' })
  })

  it('answers 200 with unsupported_scheme_or_network for a scheme it never registered', async () => {
    const accepted = requirements({ scheme: 'upto' })
    const response = await post('/verify', {
      x402Version: 2,
      paymentPayload: payload(accepted),
      paymentRequirements: accepted,
    })
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body).toMatchObject({ isValid: false, invalidReason: 'unsupported_scheme_or_network' })
  })
})

describe('POST /settle', () => {
  it('answers an error for a replayed authorisation and sends no transaction', async () => {
    const before = calls.writeContract.length + calls.sendTransaction.length
    const response = await post('/settle', {
      x402Version: 2,
      paymentPayload: payload(),
      paymentRequirements: requirements(),
    })
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body).toMatchObject({
      success: false,
      errorReason: REJECTION.nonceAlreadyUsed,
      transaction: '',
      network: 'eip155:97',
    })
    expect(calls.writeContract.length + calls.sendTransaction.length).toBe(before)
  })

  it('answers 400 for a malformed body', async () => {
    const response = await post('/settle', { x402Version: 2, paymentPayload: {}, paymentRequirements: {} })
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.errorReason).toBe('invalid_request_body')
  })
})
