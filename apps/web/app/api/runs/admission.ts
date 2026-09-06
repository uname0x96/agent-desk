import {
  ZERO_ADDRESS,
  baseUnitsToString,
  networkForChain,
  sumBaseUnits,
  type AgentType,
  type ListingStatus,
  type PriceLock,
  type PriceLockNode,
} from '@agent-desk/schemas'
import type { ErrorCode } from '@agent-desk/schemas'

/**
 * AD-4: everything `POST /api/runs` decides, as pure functions over values.
 *
 * The route itself is one transaction that takes `SELECT ... FOR UPDATE` on the
 * account row and then asks the three questions below in order. They live here
 * so the refusal rules — which listing state is admissible, what "over budget"
 * means and by how much — can be tested without a database, and so there is one
 * place to read when a Run is refused and nobody can say why.
 *
 * Every refusal answers 409 except `validation_failed`, which is 400; the map
 * from code to status is `ERROR_STATUS` in `packages/schemas`, not a number
 * chosen here.
 */

export interface Refusal {
  code: ErrorCode
  message: string
  details?: Record<string, unknown>
}

/** One Workflow Node joined to the Listing it is bound to. */
export interface WorkflowNodeRow {
  nodeIndex: number
  nodeType: AgentType
  listingId: string
  provider: string
  status: ListingStatus
  /** Base units, the chain-owned cache. Null before the first confirmed receipt. */
  price: string | null
  payoutWallet: string
  pausedByCreator: boolean
  pausedByStake: boolean
}

export type PriceLockResult = { ok: true; lock: PriceLock } | { ok: false; refusal: Refusal }

/**
 * FR-23: the Price Lock is built from `active` Listings and never changed. A
 * Listing that is not `active`, or that the chain says is paused, is refused
 * with `validation_failed` — the Run is not admitted at all, so nothing has to
 * be unwound later.
 */
export function buildPriceLock(
  nodes: readonly WorkflowNodeRow[],
  config: { chainId: number; asset: string },
  now: Date,
): PriceLockResult {
  if (nodes.length === 0) {
    return {
      ok: false,
      refusal: { code: 'validation_failed', message: 'the Workflow has no Nodes' },
    }
  }
  if (config.asset === ZERO_ADDRESS) {
    return {
      ok: false,
      refusal: {
        code: 'validation_failed',
        message: 'tUSD is not deployed on this chain, so no Price Lock can be built',
      },
    }
  }

  const network = networkForChain(config.chainId)
  const locked: PriceLockNode[] = []

  for (const node of [...nodes].sort((left, right) => left.nodeIndex - right.nodeIndex)) {
    const refusal = refuseNode(node)
    if (refusal) return { ok: false, refusal }
    locked.push({
      node_index: node.nodeIndex,
      node_type: node.nodeType,
      listing_id: node.listingId,
      provider: node.provider,
      // Not null: `refuseNode` has already rejected a Listing with no chain price.
      price: node.price as string,
      asset: config.asset,
      network,
      pay_to: node.payoutWallet.toLowerCase(),
    })
  }

  return {
    ok: true,
    lock: {
      nodes: locked,
      total: baseUnitsToString(sumBaseUnits(locked.map((node) => node.price))),
      locked_at: now.toISOString(),
    },
  }
}

function refuseNode(node: WorkflowNodeRow): Refusal | null {
  const where = `node ${node.nodeIndex} (${node.provider})`
  if (node.status !== 'active') {
    return {
      code: 'validation_failed',
      message: `${where} is ${node.status}, not active`,
      details: { node_index: node.nodeIndex, listing_id: node.listingId, status: node.status },
    }
  }
  if (node.pausedByCreator || node.pausedByStake) {
    return {
      code: 'validation_failed',
      message: `${where} is paused on chain`,
      details: {
        node_index: node.nodeIndex,
        listing_id: node.listingId,
        paused_by_creator: node.pausedByCreator,
        paused_by_stake: node.pausedByStake,
      },
    }
  }
  if (node.price === null) {
    return {
      code: 'validation_failed',
      message: `${where} has no confirmed on-chain price yet`,
      details: { node_index: node.nodeIndex, listing_id: node.listingId },
    }
  }
  return null
}

export interface AdmissionInput {
  /** Null when the account has no wallet row at all. */
  walletReadyAt: Date | null | undefined
  /** Base units, the Price Lock total. */
  total: bigint
  /** AD-3: the account's spend in the current budget window, base units. */
  spend: bigint
  /** `accounts.daily_fee_budget`, else the platform default. Base units. */
  budget: bigint
  /** The wallet's tUSD balance, base units. */
  balance: bigint
}

/**
 * AD-4 / AD-5, in order: a wallet that cannot pay yet, then the Daily Fee
 * Budget, then the tUSD balance. There is no BNB check, because the facilitator
 * relays the EIP-3009 transfer and the paying wallet spends no gas (AD-6).
 */
export function checkAdmission(input: AdmissionInput): Refusal | null {
  if (!input.walletReadyAt) {
    return {
      code: 'wallet_not_ready',
      message: 'the System Wallet is not ready to pay yet',
    }
  }

  const required = input.spend + input.total
  if (required > input.budget) {
    const shortfall = required - input.budget
    return {
      code: 'refused_budget',
      message: 'the Price Lock does not fit in the remaining Daily Fee Budget',
      details: {
        spend: baseUnitsToString(input.spend),
        budget: baseUnitsToString(input.budget),
        total: baseUnitsToString(input.total),
        shortfall: baseUnitsToString(shortfall),
      },
    }
  }

  if (input.total > input.balance) {
    return {
      code: 'refused_balance',
      message: 'the System Wallet does not hold enough tUSD for the Price Lock',
      details: {
        balance: baseUnitsToString(input.balance),
        total: baseUnitsToString(input.total),
        shortfall: baseUnitsToString(input.total - input.balance),
      },
    }
  }

  return null
}
