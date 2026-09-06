import { eq, inArray, and } from 'drizzle-orm'
import {
  accounts,
  platformSettings,
  runs,
  workflowNodes,
  workflows,
  type Database,
} from '@agent-desk/db'
import { toDecimalUsdt } from '@agent-desk/schemas'
import type { createContractCalls } from '@agent-desk/adapters/chain'
import type { ScriptsEnv } from '../env.ts'
import type { Engine } from '../wiring/index.ts'
import { seedAgent, type SeedAgentKey } from './agents.ts'
import {
  SEED_CHAINS,
  SEED_DEMO_ACCOUNTS,
  SEED_DEMO_DAILY_FEE_BUDGET,
  SEED_DEMO_WORKFLOW_IDS,
  type SeedChain,
  type SeedDemoAccount,
} from './fixtures.ts'
import { SeedRefused } from './refusal.ts'
import type { SpareSwapPlan } from './spare.ts'
import { ensureTusd, ensureWalletReady, type ReadyWallet } from './wallets.ts'

/**
 * Story 2.10's half of `pnpm seed`: the demo account roster, the demo mode
 * switch, the Telegram chat id, and the two five-Node Workflows.
 *
 * Every function here is idempotent by construction — an upsert keyed on a fixed
 * id, or a write that is skipped when the column already holds the value — so
 * "running `pnpm seed` twice leaves the same state and exits 0" is a property of
 * the code rather than a thing to remember.
 */

// ------------------------------------------------------------------ the mode

/**
 * AD-10: `platform_settings` is one row with `id = 1`, and `mode` is a runtime
 * switch, so this is an update, never an insert — the migration owns the row and
 * the Operator page owns the value the rest of the time.
 *
 * Demo mode is what makes the rest of the demo fit in a keynote: a 20 second
 * Settlement Window instead of 60 minutes, a 2 second poll instead of 60, and
 * the 24 h trend rule that Sloppy Research is built to fail (addendum §6).
 */
export async function ensureDemoMode(db: Database, log: (line: string) => void): Promise<void> {
  const [current] = await db
    .select({ mode: platformSettings.mode })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)
  if (!current) throw new SeedRefused('platform_settings row 1 is missing; run the migrations')

  if (current.mode === 'demo') {
    log('mode               demo (already set)')
    return
  }
  await db
    .update(platformSettings)
    .set({ mode: 'demo', updatedAt: new Date() })
    .where(eq(platformSettings.id, 1))
  log(`mode               demo (was ${current.mode})`)
}

// -------------------------------------------------------------- the accounts

export interface SeededAccount {
  account: SeedDemoAccount
  wallet: ReadyWallet
}

export interface DemoAccountsDeps {
  db: Database
  engine: Engine
  calls: ReturnType<typeof createContractCalls>
  env: ScriptsEnv
  platformWalletId: string
  log: (line: string) => void
}

/**
 * NFR-2 / addendum §5: two Builder and two Creator Accounts plus a spare pair,
 * each with a funded System Wallet and the demo Daily Fee Budget.
 *
 * The wallet comes from `runWalletCreate`, which is the `wallet.create` job body
 * itself, so these six wallets are made the way `POST /api/auth/sign-up` makes
 * one: gas top-up, mint, approve, `ready_at` from the approve receipt. Nothing
 * about a seeded Account is special except that it existed before anyone typed a
 * password.
 */
export async function ensureDemoAccounts(deps: DemoAccountsDeps): Promise<SeededAccount[]> {
  const { db, engine, calls, env, platformWalletId, log } = deps
  const seeded: SeededAccount[] = []

  for (const account of SEED_DEMO_ACCOUNTS) {
    await db
      .insert(accounts)
      .values({
        id: account.accountId,
        email: account.email,
        passwordHash: account.passwordHash,
        isOperator: false,
        dailyFeeBudget: SEED_DEMO_DAILY_FEE_BUDGET,
      })
      .onConflictDoNothing({ target: accounts.id })

    // The email is unique too, so an account seeded under another id would make
    // the insert above a silent no-op and leave the Workflow ownerless.
    const [row] = await db
      .select({
        id: accounts.id,
        passwordHash: accounts.passwordHash,
        dailyFeeBudget: accounts.dailyFeeBudget,
      })
      .from(accounts)
      .where(eq(accounts.email, account.email))
      .limit(1)
    if (!row) throw new SeedRefused(`the demo account ${account.email} was not inserted`)
    if (row.id !== account.accountId) {
      throw new SeedRefused(
        `${account.email} already belongs to account ${row.id}, not the seed's ` +
          `${account.accountId}. Run \`pnpm seed --reset\` or remove that account.`,
      )
    }

    // Addendum §6: 100 tUSD on demo Accounts, whatever the platform default is.
    const budgetSettled = row.dailyFeeBudget === SEED_DEMO_DAILY_FEE_BUDGET
    if (!budgetSettled || row.passwordHash !== account.passwordHash) {
      await db
        .update(accounts)
        .set({ dailyFeeBudget: SEED_DEMO_DAILY_FEE_BUDGET, passwordHash: account.passwordHash })
        .where(eq(accounts.id, account.accountId))
    }

    const wallet = await ensureWalletReady(engine, account.accountId, account.label, log)
    await ensureTusd(engine, calls, env, wallet.walletId, wallet.address, platformWalletId, log)
    log(
      `${account.label.padEnd(18)} ${account.email} / ${account.password}  ` +
        `budget ${toDecimalUsdt(SEED_DEMO_DAILY_FEE_BUDGET)} tUSD ` +
        `(${budgetSettled ? 'already set' : 'set'})`,
    )
    seeded.push({ account, wallet })
  }

  return seeded
}

// ------------------------------------------------------- the Telegram chat id

export type TelegramOutcome = 'set' | 'already set' | 'absent'

/**
 * Addendum §5: the Builder starts the shared bot, the bot replies with the chat
 * id, and the Builder pastes it into settings. `SEED_TELEGRAM_CHAT_ID` is that
 * paste, done once, for the demo Builder.
 *
 * Absent is a normal state, not a failure — the rest of the seed is useful
 * without it — but it is never silent: the `notify` Node is refused before
 * payment when the Account has no chat id (AD-4), so a Run would end
 * `failed at notify` with no message anywhere, and the reason has to be on
 * screen at seed time, not discovered mid-demo.
 */
export async function ensureTelegramChatId(
  db: Database,
  accountId: string,
  chatId: string | null,
  log: (line: string) => void,
): Promise<TelegramOutcome> {
  if (chatId === null) {
    log(
      'telegram chat id   SEED_TELEGRAM_CHAT_ID is not set, so no Builder has one. ' +
        'Message /start to the bot, then set it in .env and seed again, or paste it in /settings; ' +
        'until then every Run ends `failed at notify`.',
    )
    return 'absent'
  }

  const [current] = await db
    .select({ telegramChatId: accounts.telegramChatId })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)
  if (!current) throw new SeedRefused(`account ${accountId} is missing; cannot set its chat id`)

  if (current.telegramChatId === chatId) {
    log(`telegram chat id   ${chatId} on ${accountId} (already set)`)
    return 'already set'
  }
  await db.update(accounts).set({ telegramChatId: chatId }).where(eq(accounts.id, accountId))
  log(`telegram chat id   ${chatId} on ${accountId} (set)`)
  return 'set'
}

// -------------------------------------------------------- the demo Workflows

/** FR-17: the Node order of both demo chains; only `research` differs. */
export function chainNodes(chain: SeedChain): readonly SeedAgentKey[] {
  return ['binance-ticker', chain.research, 'guardrail-risk', 'spot-executor', 'telegram-notifier']
}

/**
 * Story 2.10's two Workflows: the good chain (Ticker, Alpha Research, Guardrail
 * Risk, Spot Executor, Telegram Notifier, Order Cap 10 USDT) and the sloppy
 * chain, which is the same with Sloppy Research in the `research` Node.
 *
 * The Nodes are upserted rather than inserted-and-left, so a chain whose
 * Provider changed in a later seed — or a row a half-finished earlier run left
 * behind — is repaired instead of quietly kept.
 */
export async function ensureDemoWorkflows(
  db: Database,
  builderAccountId: string,
  log: (line: string) => void,
): Promise<void> {
  for (const chain of SEED_CHAINS) {
    await db
      .insert(workflows)
      .values({
        id: chain.workflowId,
        accountId: builderAccountId,
        name: chain.name,
        symbol: chain.symbol,
        orderCapUsdt: chain.orderCapUsdt,
      })
      .onConflictDoUpdate({
        target: workflows.id,
        // Not `account_id`: who owns a demo Workflow is the spare swap's
        // decision, and re-running the seed must not undo an activated spare.
        set: {
          name: chain.name,
          symbol: chain.symbol,
          orderCapUsdt: chain.orderCapUsdt,
          updatedAt: new Date(),
        },
      })

    const nodes = chainNodes(chain)
    for (const [nodeIndex, key] of nodes.entries()) {
      const agent = seedAgent(key)
      await db
        .insert(workflowNodes)
        .values({
          workflowId: chain.workflowId,
          nodeIndex,
          nodeType: agent.type,
          listingId: agent.listingId,
        })
        .onConflictDoUpdate({
          target: [workflowNodes.workflowId, workflowNodes.nodeIndex],
          set: { nodeType: agent.type, listingId: agent.listingId },
        })
    }

    log(
      `workflow           ${chain.workflowId}  ${chain.name} ` +
        `(${nodes.map((key) => seedAgent(key).name).join(' -> ')}, cap ${chain.orderCapUsdt} USDT)`,
    )
  }
}

// ---------------------------------------------------------- the spare swap

/** Who owns each demo Workflow now, and whether one of them has a live Run. */
export async function readWorkflowOwners(db: Database) {
  const ids = [...SEED_DEMO_WORKFLOW_IDS]
  const rows = await db
    .select({ workflowId: workflows.id, accountId: workflows.accountId })
    .from(workflows)
    .where(inArray(workflows.id, ids))

  const running = await db
    .select({ workflowId: runs.workflowId })
    .from(runs)
    .where(and(inArray(runs.workflowId, ids), eq(runs.status, 'running')))
  const busy = new Set(running.map((row) => row.workflowId))

  return rows.map((row) => ({ ...row, hasRunningRun: busy.has(row.workflowId) }))
}

/** Applies the moves `planSpareSwap` decided. Nothing else writes `account_id`. */
export async function applySpareSwap(db: Database, plan: SpareSwapPlan): Promise<void> {
  for (const move of plan.moves) {
    await db
      .update(workflows)
      .set({ accountId: move.to, updatedAt: new Date() })
      .where(eq(workflows.id, move.workflowId))
  }
}
