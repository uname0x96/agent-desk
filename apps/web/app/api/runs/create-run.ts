import {
  calls,
  dailyFeeSpendForAccount,
  runs,
  type Database,
  type Listing,
  type WorkflowNode,
} from '@agent-desk/db'
import { newId, type PriceLock } from '@agent-desk/schemas'
import { buildPriceLock, checkAdmission, type Refusal, type WorkflowNodeRow } from './admission.ts'

/**
 * AD-4: `POST /api/runs` inserts a Run whole. It never transitions one.
 *
 * Everything below happens in one transaction that opens with
 * `SELECT ... FOR UPDATE` on the account row, so two requests for the same
 * account queue behind each other and the second sees the first Run's `pending`
 * Calls in the AD-3 spend query. A refused request inserts nothing at all.
 *
 * The order of the checks is the order of the acceptance criteria: the Workflow
 * has to exist, the Workflow has to be free (`run_in_progress`), the Listings
 * have to be `active` and unpaused, the wallet has to be ready, and only then
 * are the budget and the tUSD balance compared against the Price Lock total.
 *
 * `run.execute` is published *after* the transaction commits, with
 * `workflow_id` as the singleton key: the queue is `exclusive`, so one Workflow
 * never has two jobs queued or active (AD-4, `packages/db/queues`).
 *
 * `apps/web` depends on `@agent-desk/db` but not on `drizzle-orm` (Story 1.7
 * notes the same), so the reads below go through the relational query API,
 * whose comparison operators arrive as callback arguments.
 */

export interface CreateRunDeps {
  db: Database
  /** AD-10: from `deployments/<chain id>.json`, never from an env var. */
  chainId: number
  asset: string
  /** The wallet's tUSD balance in base units, read through the `ChainReader` port. */
  tokenBalance(address: string): Promise<bigint>
  /** `boss.send('run.execute', { run_id }, { singletonKey: workflow_id })`. */
  publish(runId: string, workflowId: string): Promise<void>
  now?: () => Date
  newRunId?: () => string
  newCallId?: () => string
}

export type CreateRunResult = { ok: true; runId: string } | { ok: false; refusal: Refusal }

/**
 * postgres-js surfaces a unique violation as SQLSTATE 23505, and Drizzle wraps
 * that in a `DrizzleQueryError` carrying it as `cause`, so the chain is walked
 * rather than the top-level error read.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === '23505') return true
  }
  return false
}

class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message)
    this.name = 'Refused'
  }
}

/** AD-13: `acc_` and 26 Crockford base-32 characters, and nothing else, ever. */
const ACCOUNT_ID = /^acc_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

/**
 * The row lock AD-4 requires. Drizzle's `.for('update')` needs a `where`, which
 * needs the comparison operators, which live in `drizzle-orm` — a package this
 * app does not depend on. So the statement is issued directly.
 *
 * The only value in it is an account id this transaction has just read out of
 * `workflows.account_id`; it is never anything a request supplied, and it is
 * asserted to be a type-prefixed ULID before it is interpolated, so the string
 * can hold nothing but `[0-9A-Z_]`.
 */
async function lockAccountRow(tx: Pick<Database, 'execute'>, accountId: string): Promise<void> {
  if (!ACCOUNT_ID.test(accountId)) {
    throw new Error(`refusing to lock a malformed account id: ${accountId}`)
  }
  await tx.execute(`select id from accounts where id = '${accountId}' for update`)
}

export async function createRun(
  deps: CreateRunDeps,
  request: { workflowId: string },
): Promise<CreateRunResult> {
  const now = deps.now?.() ?? new Date()
  const runId = deps.newRunId?.() ?? newId('run')
  const nextCallId = deps.newCallId ?? (() => newId('call'))

  let workflowId: string
  try {
    workflowId = await deps.db.transaction(async (tx) => {
      // 1. The Workflow, by the only value the request supplied.
      const workflow = await tx.query.workflows.findFirst({
        where: (table, { eq }) => eq(table.id, request.workflowId),
        columns: { id: true, accountId: true },
      })
      if (!workflow) {
        throw new Refused({ code: 'not_found', message: 'no such Workflow' })
      }

      // 2. The account row lock. Everything that follows — the spend query, the
      //    insert — is serialised against another Run of this same account.
      await lockAccountRow(tx, workflow.accountId)

      const account = await tx.query.accounts.findFirst({
        where: (table, { eq }) => eq(table.id, workflow.accountId),
        columns: { dailyFeeBudget: true },
      })

      // 3. AD-4: one Run per Workflow. The partial unique index is the authority;
      //    this read is what turns it into a clean 409 instead of an insert error.
      const running = await tx.query.runs.findFirst({
        where: (table, { and, eq }) =>
          and(eq(table.workflowId, workflow.id), eq(table.status, 'running')),
        columns: { id: true },
      })
      if (running) {
        throw new Refused({
          code: 'run_in_progress',
          message: 'this Workflow already has a Run in progress',
          details: { run_id: running.id },
        })
      }

      // 4. The Price Lock, from the Listings as they stand right now.
      const nodes = await tx.query.workflowNodes.findMany({
        where: (table, { eq }) => eq(table.workflowId, workflow.id),
        orderBy: (table, { asc }) => [asc(table.nodeIndex)],
      })
      const built = buildPriceLock(
        await joinListings(tx, nodes),
        { chainId: deps.chainId, asset: deps.asset },
        now,
      )
      if (!built.ok) throw new Refused(built.refusal)
      const lock: PriceLock = built.lock
      const total = BigInt(lock.total)

      // 5. The paying wallet (AD-5: `ready_at` comes from the approve receipt).
      const wallet = await tx.query.wallets.findFirst({
        where: (table, { eq }) => eq(table.accountId, workflow.accountId),
        columns: { id: true, address: true, readyAt: true },
      })
      if (!wallet?.readyAt) {
        throw new Refused({
          code: 'wallet_not_ready',
          message: 'the System Wallet is not ready to pay yet',
        })
      }

      const settings = await tx.query.platformSettings.findFirst({
        columns: { defaultDailyFeeBudget: true },
      })
      if (!settings) throw new Error('platform_settings row 1 is missing; run the migrations')

      // AD-3: one spend query, defined in `packages/db`, run inside this
      // transaction so it sees exactly what the lock on the account row protects.
      const spend = await dailyFeeSpendForAccount(tx, workflow.accountId, now)
      const budget = BigInt(account?.dailyFeeBudget ?? settings.defaultDailyFeeBudget)

      // The chain read is last, so a slow RPC only ever holds the account lock
      // for a request that has already passed every cheap check.
      const balance = await deps.tokenBalance(wallet.address)

      const refusal = checkAdmission({
        walletReadyAt: wallet.readyAt,
        total,
        spend,
        budget,
        balance,
      })
      if (refusal) throw new Refused(refusal)

      // 6. The Run and one `pending` Call per Node, whole, in this transaction.
      await tx.insert(runs).values({
        id: runId,
        workflowId: workflow.id,
        accountId: workflow.accountId,
        walletId: wallet.id,
        status: 'running',
        priceLock: lock,
        createdAt: now,
      })
      await tx.insert(calls).values(
        lock.nodes.map((node) => ({
          id: nextCallId(),
          runId,
          kind: 'run' as const,
          listingId: node.listing_id,
          nodeIndex: node.node_index,
          nodeType: node.node_type,
          status: 'pending' as const,
          lockedPrice: node.price,
          lockedPayTo: node.pay_to,
          lockedAsset: node.asset,
          lockedNetwork: node.network,
        })),
      )

      return workflow.id
    })
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal }
    if (isUniqueViolation(error)) {
      // The partial unique index caught a Run this transaction's own read did
      // not see. Nothing was inserted; the caller is told the same thing.
      return {
        ok: false,
        refusal: {
          code: 'run_in_progress',
          message: 'this Workflow already has a Run in progress',
        },
      }
    }
    throw error
  }

  // AD-4: published after the commit, so the worker can never load a Run that
  // is not there yet. The singleton key is the Workflow.
  await deps.publish(runId, workflowId)
  return { ok: true, runId }
}

/** The Node rows with the Listing each is bound to, as the Price Lock needs them. */
async function joinListings(
  tx: Pick<Database, 'query'>,
  nodes: readonly WorkflowNode[],
): Promise<WorkflowNodeRow[]> {
  if (nodes.length === 0) return []
  const ids = [...new Set(nodes.map((node) => node.listingId))]
  const rows = await tx.query.listings.findMany({
    where: (table, { inArray }) => inArray(table.id, ids),
  })
  const byId = new Map<string, Listing>(rows.map((row) => [row.id, row]))

  return nodes.map((node) => {
    const listing = byId.get(node.listingId)
    if (!listing) throw new Error(`workflow node ${node.nodeIndex} names a Listing that is gone`)
    return {
      nodeIndex: node.nodeIndex,
      nodeType: node.nodeType,
      listingId: listing.id,
      provider: listing.name,
      status: listing.status,
      price: listing.price,
      payoutWallet: listing.payoutWallet,
      pausedByCreator: listing.pausedByCreator,
      pausedByStake: listing.pausedByStake,
    }
  })
}
