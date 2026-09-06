import { X402_SCHEME } from '@agent-desk/schemas'
import { InMemoryPendingSettlementStore, type PendingSettlementStore } from '@x402/core/facilitator'
import type {
  FacilitatorContext,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types'
import { eip3009ABI, isEIP3009Payload, type ExactEIP3009Payload, type ExactEvmPayloadV2 } from '@x402/evm'
import { ExactEvmScheme } from '@x402/evm/exact/facilitator'
import { isAddress, isAddressEqual } from 'viem'
import { supportedExtra, type FacilitatorConfig } from './config.ts'

/**
 * AD-6: there is no default asset for eip155:97, so every 402 must carry an
 * explicit asset and `extra { name, version }`, and both must be the ones this
 * facilitator was configured with. `@x402/evm` only rejects a missing EIP-712
 * domain; it will happily settle any asset on any eip155 network it is routed.
 * This wrapper closes both gaps and adds the replay guard, then delegates the
 * signature, balance and broadcast work to `ExactEvmScheme`.
 */
export const REJECTION = {
  networkMismatch: 'invalid_agent_desk_network',
  unsupportedAsset: 'invalid_agent_desk_asset',
  missingExtra: 'invalid_agent_desk_missing_eip712_domain',
  domainMismatch: 'invalid_agent_desk_eip712_domain_mismatch',
  acceptedMismatch: 'invalid_agent_desk_accepted_mismatch',
  nonceAlreadyUsed: 'invalid_agent_desk_nonce_already_used',
  assetNotDeployed: 'invalid_agent_desk_asset_not_deployed',
} as const

export type RejectionReason = (typeof REJECTION)[keyof typeof REJECTION]

function sameAddress(left: string | undefined, right: string): boolean {
  if (!left || !isAddress(left) || !isAddress(right)) return false
  return isAddressEqual(left, right)
}

function domainOf(extra: Record<string, unknown> | undefined): { name?: unknown; version?: unknown } {
  return extra ?? {}
}

/**
 * The AD-6 admission check, kept pure so it is testable without a chain.
 * Returns the rejection reason, or undefined when the request is admissible.
 */
export function checkAdmissible(
  config: FacilitatorConfig,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): RejectionReason | undefined {
  if (!config.assetDeployed) return REJECTION.assetNotDeployed

  // Network is compared as an exact CAIP-2 string, per AD-6.
  if (requirements.network !== config.x402.network) return REJECTION.networkMismatch
  if (payload.accepted?.network !== config.x402.network) return REJECTION.networkMismatch

  if (!sameAddress(requirements.asset, config.x402.asset)) return REJECTION.unsupportedAsset
  if (!sameAddress(payload.accepted?.asset, requirements.asset)) return REJECTION.acceptedMismatch

  const requirementsDomain = domainOf(requirements.extra)
  const acceptedDomain = domainOf(payload.accepted?.extra)
  const hasDomain = (value: { name?: unknown; version?: unknown }) =>
    typeof value.name === 'string' && value.name.length > 0 && typeof value.version === 'string' && value.version.length > 0
  if (!hasDomain(requirementsDomain) || !hasDomain(acceptedDomain)) return REJECTION.missingExtra

  const { name, version } = config.x402.extra
  if (requirementsDomain.name !== name || requirementsDomain.version !== version) return REJECTION.domainMismatch
  if (acceptedDomain.name !== name || acceptedDomain.version !== version) return REJECTION.domainMismatch

  return undefined
}

function eip3009PayloadOf(payload: PaymentPayload): ExactEIP3009Payload | undefined {
  const raw = payload.payload as unknown as ExactEvmPayloadV2
  if (!raw || typeof raw !== 'object') return undefined
  return isEIP3009Payload(raw) ? raw : undefined
}

export function payerOf(payload: PaymentPayload): string | undefined {
  return eip3009PayloadOf(payload)?.authorization.from
}

export class AgentDeskExactScheme implements SchemeNetworkFacilitator {
  readonly scheme: string = X402_SCHEME
  readonly caipFamily = 'eip155:*'

  private readonly inner: ExactEvmScheme
  private readonly pendingStore: PendingSettlementStore
  private readonly config: FacilitatorConfig
  private readonly signer: ConstructorParameters<typeof ExactEvmScheme>[0]

  constructor(config: FacilitatorConfig, signer: ConstructorParameters<typeof ExactEvmScheme>[0]) {
    this.config = config
    this.signer = signer
    // The store is shared with the inner scheme so a settle retry for a
    // broadcast-but-unconfirmed transaction still reconciles instead of
    // tripping the replay guard below.
    this.pendingStore = new InMemoryPendingSettlementStore()
    this.inner = new ExactEvmScheme(signer, {
      // Re-verify on settle so a used authorisation is caught by simulation
      // before anything is broadcast; the explicit guard below is the primary
      // check and this is the backstop.
      simulateInSettle: true,
      pendingSettlementStore: this.pendingStore,
    })
  }

  /** AD-6: `/supported` publishes the one asset and its EIP-712 domain. */
  getExtra(_network: Network): Record<string, unknown> | undefined {
    return supportedExtra(this.config)
  }

  getSigners(network: string): string[] {
    return this.inner.getSigners(network)
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    const reason = checkAdmissible(this.config, payload, requirements)
    if (reason) {
      const payer = payerOf(payload)
      return { isValid: false, invalidReason: reason, ...(payer ? { payer } : {}) }
    }
    return this.inner.verify(payload, requirements, context)
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const payer = payerOf(payload)
    const reject = (errorReason: string): SettleResponse => ({
      success: false,
      errorReason,
      transaction: '',
      network: requirements.network,
      ...(payer ? { payer } : {}),
    })

    const reason = checkAdmissible(this.config, payload, requirements)
    if (reason) return reject(reason)

    if (await this.isReplay(payload, requirements)) return reject(REJECTION.nonceAlreadyUsed)

    return this.inner.settle(payload, requirements, context)
  }

  /**
   * True when the authorisation has already been consumed on chain and no
   * settlement for it is still pending. Reading `authorizationState` costs one
   * `eth_call` and guarantees a replayed authorisation sends no transaction.
   */
  private async isReplay(payload: PaymentPayload, requirements: PaymentRequirements): Promise<boolean> {
    const eip3009 = eip3009PayloadOf(payload)
    if (!eip3009) return false
    if (eip3009.signature && (await this.pendingStore.get(eip3009.signature))) return false
    const used = await this.signer.readContract({
      address: requirements.asset as `0x${string}`,
      abi: eip3009ABI,
      functionName: 'authorizationState',
      args: [eip3009.authorization.from, eip3009.authorization.nonce],
    })
    return used === true
  }
}
