import {
  SEED_DEMO_BUILDER,
  SEED_DEMO_CREATOR,
  SEED_DEMO_WORKFLOW_IDS,
  SEED_SPARE_BUILDER,
  SEED_SPARE_CREATOR,
  type SeedDemoAccount,
} from './fixtures.ts'

/**
 * `pnpm seed --activate-spare` — Story 2.10, and the failover set of PRD
 * addendum §5.
 *
 * A demo pair is two Accounts that hold the demo together: the Builder that owns
 * the two Workflows and pays every Call from its System Wallet, and the Creator
 * whose wallet is the `AGENT_PAYTO` of the :4107 instance and therefore the
 * payout wallet of the Listing Story 3.4 creates live. When either wallet is
 * unusable minutes before the demo — out of BNB, a stuck nonce, a budget nobody
 * can explain — swapping in the spare pair is one flag rather than a rewrite.
 *
 * "Swapping the spare pair into the demo Workflows" is therefore exactly two
 * moves:
 *
 *   1. every demo Workflow's `account_id` becomes the spare Builder's, which
 *      also moves the wallet that pays and the Daily Fee Budget that admits;
 *   2. `.env.seed`'s `AGENT_PAYTO` becomes the spare Creator's wallet address.
 *
 * The decision is pure so it can be tested without a database, and so the seed
 * can print what it is about to do before it does it.
 */

export interface DemoPair {
  builder: SeedDemoAccount
  creator: SeedDemoAccount
  /** True when this is the failover pair. */
  spare: boolean
}

export function demoPair(activateSpare: boolean): DemoPair {
  return activateSpare
    ? { builder: SEED_SPARE_BUILDER, creator: SEED_SPARE_CREATOR, spare: true }
    : { builder: SEED_DEMO_BUILDER, creator: SEED_DEMO_CREATOR, spare: false }
}

/** As much of a `workflows` row as the plan reads. */
export interface WorkflowOwner {
  workflowId: string
  accountId: string
  /** AD-4's partial unique index: at most one Run per Workflow is `running`. */
  hasRunningRun?: boolean
}

export interface WorkflowMove {
  workflowId: string
  from: string
  to: string
}

export interface SpareSwapPlan {
  pair: DemoPair
  /** The demo Workflows whose owner has to change. Empty when nothing moves. */
  moves: readonly WorkflowMove[]
  /** Demo Workflows that do not exist yet; the seed creates them under `pair.builder`. */
  missing: readonly string[]
  /** True when every demo Workflow already belongs to the chosen Builder. */
  settled: boolean
  /** Workflows with a Run still `running`, which the swap leaves with the old owner. */
  warnings: readonly string[]
}

/**
 * Which demo Workflows move, given who owns them now.
 *
 * A Workflow with a Run still `running` is moved like any other — the failover
 * exists precisely for the minutes when something is stuck — but it is reported,
 * because that Run keeps its own `account_id` and so keeps paying and spending
 * budget from the old Builder until it ends (AD-3: a Run's account is its own
 * column, not a join through the Workflow).
 */
export function planSpareSwap(
  activateSpare: boolean,
  owners: readonly WorkflowOwner[],
  workflowIds: readonly string[] = SEED_DEMO_WORKFLOW_IDS,
): SpareSwapPlan {
  const pair = demoPair(activateSpare)
  const byId = new Map(owners.map((owner) => [owner.workflowId, owner]))

  const moves: WorkflowMove[] = []
  const missing: string[] = []
  const warnings: string[] = []

  for (const workflowId of workflowIds) {
    const owner = byId.get(workflowId)
    if (!owner) {
      missing.push(workflowId)
      continue
    }
    if (owner.accountId === pair.builder.accountId) continue
    moves.push({ workflowId, from: owner.accountId, to: pair.builder.accountId })
    if (owner.hasRunningRun === true) {
      warnings.push(
        `${workflowId} has a Run still running; that Run keeps paying from ${owner.accountId}`,
      )
    }
  }

  return {
    pair,
    moves,
    missing,
    settled: moves.length === 0 && missing.length === 0,
    warnings,
  }
}

/** One line per decision, for the seed's output. */
export function formatSpareSwapPlan(plan: SpareSwapPlan): string {
  const lines: string[] = []
  lines.push(
    `demo pair          ${plan.pair.spare ? 'spare' : 'primary'}: ` +
      `${plan.pair.builder.email} builds, ${plan.pair.creator.email} creates`,
  )
  if (plan.settled) {
    lines.push('spare swap         nothing to move; the Workflows already belong to this Builder')
  }
  for (const move of plan.moves) {
    lines.push(`spare swap         ${move.workflowId}  ${move.from} -> ${move.to}`)
  }
  for (const workflowId of plan.missing) {
    lines.push(`spare swap         ${workflowId} does not exist yet; it is created under this Builder`)
  }
  for (const warning of plan.warnings) {
    lines.push(`spare swap         NOTE ${warning}`)
  }
  return lines.join('\n')
}
