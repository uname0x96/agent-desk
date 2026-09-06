import { describe, expect, it } from 'vitest'
import {
  SEED_DEMO_BUILDER,
  SEED_DEMO_CREATOR,
  SEED_DEMO_WORKFLOW_IDS,
  SEED_GOOD_CHAIN,
  SEED_SLOPPY_CHAIN,
  SEED_SPARE_BUILDER,
  SEED_SPARE_CREATOR,
  SEED_WORKFLOW,
} from './fixtures.ts'
import { demoPair, formatSpareSwapPlan, planSpareSwap, type WorkflowOwner } from './spare.ts'

const PRIMARY = SEED_DEMO_BUILDER.accountId
const SPARE = SEED_SPARE_BUILDER.accountId

function ownedBy(accountId: string, over: Partial<WorkflowOwner> = {}): WorkflowOwner[] {
  return SEED_DEMO_WORKFLOW_IDS.map((workflowId) => ({ workflowId, accountId, ...over }))
}

describe('demoPair', () => {
  it('is the primary Builder and Creator without the flag', () => {
    expect(demoPair(false)).toEqual({
      builder: SEED_DEMO_BUILDER,
      creator: SEED_DEMO_CREATOR,
      spare: false,
    })
  })

  it('is the failover pair of addendum §5 with it', () => {
    const pair = demoPair(true)
    expect(pair).toEqual({ builder: SEED_SPARE_BUILDER, creator: SEED_SPARE_CREATOR, spare: true })
    // The point of a spare is that it is a different wallet and a different budget.
    expect(pair.builder.accountId).not.toBe(SEED_DEMO_BUILDER.accountId)
    expect(pair.creator.accountId).not.toBe(SEED_DEMO_CREATOR.accountId)
  })
})

describe('planSpareSwap', () => {
  it('moves every demo Workflow to the spare Builder', () => {
    const plan = planSpareSwap(true, ownedBy(PRIMARY))

    expect(plan.pair.spare).toBe(true)
    expect(plan.moves.map((move) => move.workflowId)).toEqual([
      SEED_WORKFLOW.workflowId,
      SEED_GOOD_CHAIN.workflowId,
      SEED_SLOPPY_CHAIN.workflowId,
    ])
    for (const move of plan.moves) {
      expect(move.from).toBe(PRIMARY)
      expect(move.to).toBe(SPARE)
    }
    expect(plan.settled).toBe(false)
  })

  it('moves nothing when the chosen Builder already owns them, so a second run is a no-op', () => {
    const plan = planSpareSwap(true, ownedBy(SPARE))
    expect(plan.moves).toEqual([])
    expect(plan.settled).toBe(true)
  })

  it('moves the Workflows back when the flag is dropped', () => {
    const plan = planSpareSwap(false, ownedBy(SPARE))
    expect(plan.moves).toHaveLength(SEED_DEMO_WORKFLOW_IDS.length)
    expect(plan.moves[0]!.to).toBe(PRIMARY)
  })

  it('reports a Workflow that does not exist yet instead of inventing a move', () => {
    const owners = ownedBy(PRIMARY).filter(
      (owner) => owner.workflowId !== SEED_SLOPPY_CHAIN.workflowId,
    )
    const plan = planSpareSwap(true, owners)

    expect(plan.missing).toEqual([SEED_SLOPPY_CHAIN.workflowId])
    expect(plan.moves.map((move) => move.workflowId)).not.toContain(SEED_SLOPPY_CHAIN.workflowId)
    expect(plan.settled).toBe(false)
  })

  it('still moves a Workflow with a live Run, and says the Run keeps the old account', () => {
    // AD-3: `runs.account_id` is its own column, so an in-flight Run keeps paying
    // and spending budget from the Builder that started it.
    const owners = ownedBy(PRIMARY).map((owner) => ({
      ...owner,
      hasRunningRun: owner.workflowId === SEED_GOOD_CHAIN.workflowId,
    }))
    const plan = planSpareSwap(true, owners)

    expect(plan.moves).toHaveLength(SEED_DEMO_WORKFLOW_IDS.length)
    expect(plan.warnings).toHaveLength(1)
    expect(plan.warnings[0]).toContain(SEED_GOOD_CHAIN.workflowId)
    expect(plan.warnings[0]).toContain(PRIMARY)
  })

  it('is idempotent: planning the applied plan again moves nothing', () => {
    const first = planSpareSwap(true, ownedBy(PRIMARY))
    const applied = ownedBy(PRIMARY).map((owner) => ({
      ...owner,
      accountId: first.moves.find((move) => move.workflowId === owner.workflowId)?.to ?? owner.accountId,
    }))

    expect(planSpareSwap(true, applied).moves).toEqual([])
  })
})

describe('formatSpareSwapPlan', () => {
  it('names the pair, and says plainly when there is nothing to move', () => {
    const text = formatSpareSwapPlan(planSpareSwap(false, ownedBy(PRIMARY)))
    expect(text).toContain('primary')
    expect(text).toContain(SEED_DEMO_BUILDER.email)
    expect(text).toContain(SEED_DEMO_CREATOR.email)
    expect(text).toContain('nothing to move')
  })

  it('prints one line per move and one per warning', () => {
    const owners = ownedBy(PRIMARY, { hasRunningRun: true })
    const lines = formatSpareSwapPlan(planSpareSwap(true, owners)).split('\n')

    expect(lines[0]).toContain('spare')
    expect(lines.filter((line) => line.includes('->'))).toHaveLength(SEED_DEMO_WORKFLOW_IDS.length)
    expect(lines.filter((line) => line.includes('NOTE'))).toHaveLength(SEED_DEMO_WORKFLOW_IDS.length)
  })
})
