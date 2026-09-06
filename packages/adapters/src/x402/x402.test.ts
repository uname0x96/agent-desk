import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getAddress, verifyTypedData } from 'viem'
import { decodePaymentSignatureHeader } from '@x402/core/http'
import { X402_VERSION, toBaseUnits } from '@agent-desk/schemas'
import type { PaymentRequirementsSnapshot, SignTypedDataRequest, Signer } from '@agent-desk/core/ports'
import { createSigner } from '../signer/index.ts'
import { createX402PaymentSigner, toPaymentRequirements } from './index.ts'

/**
 * AD-6, end to end inside this process: the signature is produced by the real
 * `Signer` over a real key, and it is checked by recovering the signer from the
 * exact EIP-712 struct that was signed. What stays unproven here is the other
 * half — that the facilitator and the deployed tUSD accept it — because neither
 * is deployed. This test can only show the authorization is well formed and
 * recovers to the paying wallet.
 */

const MASTER = randomBytes(32).toString('hex')
const ASSET = '0x00000000000000000000000000000000000000cc'
const PAY_TO = '0x00000000000000000000000000000000000000bb'

const REQUIREMENTS: PaymentRequirementsSnapshot = {
  scheme: 'exact',
  network: 'eip155:97',
  asset: ASSET,
  amount: toBaseUnits('0.01').toString(),
  payTo: PAY_TO,
  maxTimeoutSeconds: 15,
  extra: { name: 'tUSD', version: '1' },
}

/** The real signer, with every typed-data request it was asked to sign kept. */
function recordingSigner() {
  const inner = createSigner({ masterKey: MASTER, chainId: 97, rpcUrls: ['http://127.0.0.1:8545'] })
  const requests: SignTypedDataRequest[] = []
  const signer: Pick<Signer, 'signTypedData'> = {
    async signTypedData(request) {
      requests.push(request)
      return inner.signTypedData(request)
    },
  }
  return { inner, signer, requests }
}

async function signOne(overrides: Partial<PaymentRequirementsSnapshot> = {}) {
  const { inner, signer, requests } = recordingSigner()
  const wallet = await inner.generateKey()
  const signed = await createX402PaymentSigner({ signer }).signPaymentAuthorization({
    wallet,
    requirements: { ...REQUIREMENTS, ...overrides },
  })
  return { wallet, signed, requests }
}

describe('signPaymentAuthorization', () => {
  it('produces a signature that recovers to the paying wallet', async () => {
    const { wallet, signed, requests } = await signOne()

    expect(requests).toHaveLength(1)
    const signedStruct = requests[0]!
    const recovered = await verifyTypedData({
      address: getAddress(wallet.address),
      domain: signedStruct.domain,
      types: signedStruct.types,
      primaryType: signedStruct.primaryType,
      message: signedStruct.message,
      signature: signed.signature,
    } as Parameters<typeof verifyTypedData>[0])

    expect(recovered).toBe(true)
    expect(signed.authorization.from).toBe(wallet.address)
  })

  it('signs a TransferWithAuthorization against the tUSD EIP-712 domain', async () => {
    const { signed, requests } = await signOne()
    const { domain, types, primaryType, message } = requests[0]!

    expect(primaryType).toBe('TransferWithAuthorization')
    expect(domain).toEqual({
      name: 'tUSD',
      version: '1',
      chainId: 97,
      verifyingContract: ASSET,
    })
    // The five EIP-3009 fields plus the nonce, in the order the token hashes.
    expect((types.TransferWithAuthorization ?? []).map((field) => field.name)).toEqual([
      'from',
      'to',
      'value',
      'validAfter',
      'validBefore',
      'nonce',
    ])
    // What is hashed is what is stored: the struct carries the amount as a
    // bigint, `calls.payment_payload` as the same integer in base units (AD-13).
    expect(message).toMatchObject({
      to: PAY_TO,
      value: BigInt(signed.authorization.value),
    })
  })

  it('records exactly the AD-3 authorization fields, lower-cased', async () => {
    const { wallet, signed } = await signOne()

    expect(signed.authorization).toEqual({
      from: wallet.address,
      to: PAY_TO,
      value: toBaseUnits('0.01').toString(),
      validAfter: expect.stringMatching(/^\d+$/),
      validBefore: expect.stringMatching(/^\d+$/),
      nonce: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    })
    expect(signed.authorization.from).toBe(signed.authorization.from.toLowerCase())
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/)
  })

  it('gives the authorization a window no shorter than maxTimeoutSeconds', async () => {
    const { signed } = await signOne({ maxTimeoutSeconds: 60 })
    const nowSeconds = Math.floor(Date.now() / 1000)

    expect(Number(signed.authorization.validAfter)).toBeLessThanOrEqual(nowSeconds)
    expect(Number(signed.authorization.validBefore) - nowSeconds).toBeGreaterThanOrEqual(60)
  })

  it('uses a fresh nonce for every authorization, so no two Calls collide', async () => {
    const first = await signOne()
    const second = await signOne()
    expect(first.signed.authorization.nonce).not.toBe(second.signed.authorization.nonce)
  })
})

describe('the PAYMENT-SIGNATURE header', () => {
  it('decodes back to the payload the agent middleware will verify', async () => {
    const { wallet, signed } = await signOne()

    const decoded = decodePaymentSignatureHeader(signed.header)

    expect(decoded.x402Version).toBe(X402_VERSION)
    // AD-6: `accepted` echoes the entry the engine matched, verbatim.
    expect(decoded.accepted).toEqual(toPaymentRequirements(REQUIREMENTS))
    const payload = decoded.payload as {
      signature: string
      authorization: { from: string; to: string; value: string; nonce: string }
    }
    expect(payload.signature).toBe(signed.signature)
    expect(payload.authorization.from.toLowerCase()).toBe(wallet.address)
    expect(payload.authorization.nonce).toBe(signed.authorization.nonce)
  })

  it('is stable, so a stored header can be resent unchanged on a retry', async () => {
    const { signed } = await signOne()
    expect(decodePaymentSignatureHeader(signed.header)).toEqual(
      decodePaymentSignatureHeader(signed.header),
    )
  })
})

describe('toPaymentRequirements', () => {
  it('carries the six AD-6 fields and the extra, and adds nothing', () => {
    expect(toPaymentRequirements(REQUIREMENTS)).toEqual({
      scheme: 'exact',
      network: 'eip155:97',
      asset: ASSET,
      amount: '10000',
      payTo: PAY_TO,
      maxTimeoutSeconds: 15,
      extra: { name: 'tUSD', version: '1' },
    })
  })
})
