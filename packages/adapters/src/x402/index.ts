import { encodePaymentSignatureHeader } from '@x402/core/http'
import type { Network, PaymentPayload, PaymentRequirements } from '@x402/core/types'
import { ExactEvmScheme, isEIP3009Payload, type ExactEvmPayloadV2 } from '@x402/evm'
import { X402_VERSION } from '@agent-desk/schemas'
import type {
  Hex,
  PaymentRequirementsSnapshot,
  SignPaymentAuthorizationRequest,
  Signer,
  SignedPaymentAuthorization,
  X402PaymentSigner,
} from '@agent-desk/core/ports'

/**
 * AD-6: one x402 binding. This module is the engine's half of it — the
 * `X402PaymentSigner` port that `core/signing` calls once the policy has passed.
 *
 * The EIP-712 domain, the `TransferWithAuthorization` type list, the random
 * nonce, and the `validBefore` window all come from `@x402/evm`'s
 * `ExactEvmScheme`, the same code the facilitator verifies against, so there is
 * no second implementation of the authorization to drift. The header encoding
 * comes from `@x402/core/http`, which the agents' middleware decodes with.
 *
 * The key never reaches `@x402/evm`: the scheme is handed a signer shim whose
 * only capability is `signTypedData`, and that delegates to the AD-5 `Signer`
 * port, which decrypts under `MASTER_KEY` for the length of one signature.
 *
 * Story 1.8 adds the request flow (402, compare, pay, retry once) on top of
 * this; signing and the wire format are settled here because Story 1.6 must
 * return a header that a stored retry can resend unchanged.
 */

export interface X402PaymentSignerDeps {
  signer: Pick<Signer, 'signTypedData'>
}

export function createX402PaymentSigner(deps: X402PaymentSignerDeps): X402PaymentSigner {
  return {
    async signPaymentAuthorization(
      request: SignPaymentAuthorizationRequest,
    ): Promise<SignedPaymentAuthorization> {
      const requirements = toPaymentRequirements(request.requirements)
      const scheme = new ExactEvmScheme({
        address: request.wallet.address as Hex,
        signTypedData: (message) =>
          deps.signer.signTypedData({
            encryptedKey: request.wallet.encryptedKey,
            domain: message.domain as SignedDomain,
            types: message.types as Record<string, readonly { name: string; type: string }[]>,
            primaryType: message.primaryType,
            message: message.message,
          }),
      })

      const result = await scheme.createPaymentPayload(X402_VERSION, requirements)
      const payload: PaymentPayload = {
        x402Version: result.x402Version,
        // AD-6: the facilitator checks `accepted` against the requirements it
        // was handed, so the entry the engine matched is echoed verbatim.
        accepted: requirements,
        payload: result.payload,
        ...(result.extensions ? { extensions: result.extensions } : {}),
      }

      const authorization = eip3009AuthorizationOf(payload)
      return {
        header: encodePaymentSignatureHeader(payload),
        authorization: {
          from: authorization.from.toLowerCase(),
          to: authorization.to.toLowerCase(),
          value: authorization.value,
          validAfter: authorization.validAfter,
          validBefore: authorization.validBefore,
          nonce: authorization.nonce,
        },
        signature: authorization.signature,
      }
    },
  }
}

type SignedDomain = { name: string; version: string; chainId: number; verifyingContract: string }

/** The port's snapshot is exactly an x402 v2 `accepts` entry; this is the cast. */
export function toPaymentRequirements(snapshot: PaymentRequirementsSnapshot): PaymentRequirements {
  return {
    scheme: snapshot.scheme,
    network: snapshot.network as Network,
    asset: snapshot.asset,
    amount: snapshot.amount,
    payTo: snapshot.payTo,
    maxTimeoutSeconds: snapshot.maxTimeoutSeconds,
    extra: { name: snapshot.extra.name, version: snapshot.extra.version },
  }
}

/**
 * AD-6 fixes the rail to plain EIP-3009 `transferWithAuthorization`. A Permit2
 * payload would mean the 402 asked for a scheme this platform does not run, and
 * storing it as `calls.payment_payload` would leave AD-6's
 * `authorizationState(from, nonce)` recovery with nothing to read.
 */
function eip3009AuthorizationOf(payload: PaymentPayload): Eip3009Authorization {
  const raw = payload.payload as unknown as ExactEvmPayloadV2
  if (!raw || typeof raw !== 'object' || !isEIP3009Payload(raw)) {
    throw new Error('x402 payment payload is not an EIP-3009 authorization')
  }
  if (!raw.signature) throw new Error('x402 payment payload carries no signature')
  return { ...raw.authorization, signature: raw.signature }
}

interface Eip3009Authorization {
  from: Hex
  to: Hex
  value: string
  validAfter: string
  validBefore: string
  nonce: Hex
  signature: Hex
}
