import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import {
  AGENT_TYPES,
  CALL_KINDS,
  CALL_STATUSES,
  CHAIN_TX_STATUSES,
  LISTING_STATUSES,
  NOT_SCORED_REASONS,
  PLATFORM_MODES,
  PRICE_SOURCE,
  RUN_STATUSES,
  SETTLEMENT_RESULTS,
  SKIP_REASONS,
  type AgentType,
  type CallKind,
  type CallStatus,
  type ChainTxStatus,
  type ListingStatus,
  type NotScoredReason,
  type PlatformMode,
  type PriceLock,
  type RunStatus,
  type SettlementResult,
  type SkipReason,
} from '@agent-desk/schemas'
import {
  ADDRESS_PATTERN,
  BASE_UNITS_PATTERN,
  DECIMAL_PATTERN,
  TX_HASH_PATTERN,
  matches,
  oneOf,
} from './sql-constraints.ts'

/**
 * AD-3: Postgres is the system of record for everything off-chain. This file is
 * the whole ER schema, landed once (spine, Migrations & tests convention); later
 * stories add columns by PR and never redesign a table.
 *
 * Conventions, all from AD-13:
 *   - ids are ULIDs with a type prefix, minted by `newId()` in @agent-desk/schemas;
 *   - table and column names are snake_case, table names plural;
 *   - token amounts are base-unit integer strings (tUSD has 6 decimals);
 *   - order sizes and exchange prices are decimal USDT strings;
 *   - addresses and transaction hashes are stored lower-case;
 *   - timestamps are `timestamptz`, surfaced as ISO 8601 UTC at the API boundary.
 *
 * Status columns are typed with the union types of `@agent-desk/schemas/status`,
 * which are the PRD enums verbatim. Nothing here redefines one.
 */

/** Base-unit money column, AD-13. */
const amount = (name: string) => text(name)
/** Lower-case 0x address column, AD-13. */
const address = (name: string) => text(name)
/** `timestamptz`, read and written as a JS Date; rendered ISO 8601 UTC on the wire. */
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

// ------------------------------------------------------------------ accounts

export const accounts = pgTable(
  'accounts',
  {
    /** `acc_<ULID>` */
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    /** bcrypt hash; the plaintext never reaches this package. */
    passwordHash: text('password_hash').notNull(),
    isOperator: boolean('is_operator').notNull().default(false),
    /** Digits as a string; null until the Builder pastes the chat id (addendum §5). */
    telegramChatId: text('telegram_chat_id'),
    /** Base units. Null means the platform default from `platform_settings`. */
    dailyFeeBudget: amount('daily_fee_budget'),
    /**
     * AD-3: the Daily Fee Budget window starts at the later of UTC midnight and
     * this column. An Operator budget reset sets it to now.
     */
    budgetWindowStart: instant('budget_window_start').notNull().defaultNow(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_email_key').on(t.email),
    check('accounts_daily_fee_budget_base_units', matches(t.dailyFeeBudget, BASE_UNITS_PATTERN)),
  ],
)

// ------------------------------------------------------------------- wallets

export const wallets = pgTable(
  'wallets',
  {
    /** `wal_<ULID>` */
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    /** Lower-case, AD-13. One wallet per address. */
    address: address('address').notNull(),
    /** AES-256-GCM under MASTER_KEY; decrypted only inside the worker's signer (AD-5). */
    encryptedKey: text('encrypted_key').notNull(),
    /**
     * AD-5: set from the `approve:<wallet_id>` receipt. Listings, Runs, and
     * `listing.write` answer 409 `wallet_not_ready` while this is null.
     */
    readyAt: instant('ready_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wallets_address_key').on(t.address),
    index('wallets_account_id_idx').on(t.accountId),
    check('wallets_address_lower_case', matches(t.address, ADDRESS_PATTERN)),
  ],
)

// ------------------------------------------------------------------ listings

/**
 * AD-2: the chain is the system of record for a Listing; this table is a cache.
 *
 * ┌─ CHAIN-OWNED COLUMNS ──────────────────────────────────────────────────┐
 * │ `price`, `stake`, `reputation_bps`, `paused_by_creator`,               │
 * │ `paused_by_stake`, `payout_wallet`, `endpoint`, `agent_id`,            │
 * │ `registry_listing_id`.                                                 │
 * │                                                                        │
 * │ These are written by exactly one function, `refreshListingFromChain`   │
 * │ (Story 1.6, in this package), called by `chainWrite` after every       │
 * │ receipt whose intent names the listing and by                          │
 * │ `POST /api/listings/<id>/refresh`. NOTHING ELSE WRITES THEM — not a    │
 * │ route handler, not a job, not a repository function added later.       │
 * │                                                                        │
 * │ `endpoint` and `payout_wallet` are seeded once by the listing form at  │
 * │ insert (they are needed to build the `list(...)` transaction) and are  │
 * │ chain-owned from the first confirmed receipt onward.                   │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * The form-owned columns are `name`, `description`, `type`, `endpoint`,
 * `declared_price`, `declared_stake`, `payout_wallet`, `creator_account_id`.
 * `status`, `last_error`, and `skip_verification` belong to the listing
 * pipeline (`POST /api/listings`, `listing.verify`, `chainWrite`).
 */
export const listings = pgTable(
  'listings',
  {
    /** `lst_<ULID>` */
    id: text('id').primaryKey(),

    // -- form-owned --------------------------------------------------------
    creatorAccountId: text('creator_account_id')
      .notNull()
      .references(() => accounts.id),
    name: text('name').notNull(),
    description: text('description'),
    type: text('type').$type<AgentType>().notNull(),
    /** `https://`, or `http://` for the allow-listed local hosts (conventions). */
    endpoint: text('endpoint').notNull(),
    /** Base units, as declared on the form. */
    declaredPrice: amount('declared_price').notNull(),
    /** Base units, at least ten times `declared_price`. */
    declaredStake: amount('declared_stake').notNull(),
    payoutWallet: address('payout_wallet').notNull(),

    // -- listing pipeline --------------------------------------------------
    /** AD-2: exactly four statuses. */
    status: text('status').$type<ListingStatus>().notNull(),
    /** Why verification or the last chain write refused (AD-2, AD-8). */
    lastError: text('last_error'),
    /** Accepted only from the seed script (Story 1.10). */
    skipVerification: boolean('skip_verification').notNull().default(false),

    // -- chain-owned: see the block comment above --------------------------
    /** Base units, from the Registry. */
    price: amount('price'),
    /** Base units, from the Registry. */
    stake: amount('stake'),
    /** Basis points, from the Registry. Null means "no score yet". */
    reputationBps: integer('reputation_bps'),
    pausedByCreator: boolean('paused_by_creator').notNull().default(false),
    pausedByStake: boolean('paused_by_stake').notNull().default(false),
    /** The ERC-8004 agent id decoded from the `Registered` event. */
    agentId: text('agent_id'),
    /** The `AgentDeskRegistry` listing id from the `Listed` event. */
    registryListingId: text('registry_listing_id'),

    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('listings_status_type_idx').on(t.status, t.type),
    index('listings_creator_account_id_idx').on(t.creatorAccountId),
    check('listings_type_enum', oneOf(t.type, AGENT_TYPES)),
    check('listings_status_enum', oneOf(t.status, LISTING_STATUSES)),
    check('listings_declared_price_base_units', matches(t.declaredPrice, BASE_UNITS_PATTERN)),
    check('listings_declared_stake_base_units', matches(t.declaredStake, BASE_UNITS_PATTERN)),
    check('listings_price_base_units', matches(t.price, BASE_UNITS_PATTERN)),
    check('listings_stake_base_units', matches(t.stake, BASE_UNITS_PATTERN)),
    check('listings_payout_wallet_lower_case', matches(t.payoutWallet, ADDRESS_PATTERN)),
  ],
)

// ----------------------------------------------------------------- workflows

export const workflows = pgTable(
  'workflows',
  {
    /** `wf_<ULID>` */
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    name: text('name').notNull(),
    /** Fixed to BNBUSDT in the MVP builder (Story 2.7). */
    symbol: text('symbol').notNull(),
    /** FR-4, decimal USDT string; required once the chain has an `execution` Node. */
    orderCapUsdt: text('order_cap_usdt'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('workflows_account_id_idx').on(t.accountId),
    check('workflows_order_cap_usdt_decimal', matches(t.orderCapUsdt, DECIMAL_PATTERN)),
  ],
)

/**
 * A Node has no identity of its own: it is the `node_index`-th step of one
 * Workflow, which is also why there is no `wfn_` prefix in `ID_PREFIXES`.
 * The composite primary key is what keeps the chain ordered and gap-free.
 */
export const workflowNodes = pgTable(
  'workflow_nodes',
  {
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    nodeIndex: integer('node_index').notNull(),
    nodeType: text('node_type').$type<AgentType>().notNull(),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id),
  },
  (t) => [
    primaryKey({ name: 'workflow_nodes_pkey', columns: [t.workflowId, t.nodeIndex] }),
    index('workflow_nodes_listing_id_idx').on(t.listingId),
    check('workflow_nodes_node_type_enum', oneOf(t.nodeType, AGENT_TYPES)),
    check('workflow_nodes_node_index_non_negative', sql`${t.nodeIndex} >= 0`),
  ],
)

// ---------------------------------------------------------------------- runs

export const runs = pgTable(
  'runs',
  {
    /** `run_<ULID>` */
    id: text('id').primaryKey(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id),
    /** The Workflow's owner, carried here so budget queries need one join fewer. */
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    /** The Builder System Wallet that pays every Call and receives every refund (AD-9). */
    walletId: text('wallet_id')
      .notNull()
      .references(() => wallets.id),
    /**
     * AD-4: `running`, `completed`, `completed, no order`, `failed at <Node>`,
     * `timed out`. Every write is a compare-and-set from `running`.
     */
    status: text('status').$type<RunStatus>().notNull(),
    /** FR-23: snapshotted at insert and never changed. */
    priceLock: jsonb('price_lock').$type<PriceLock>().notNull(),
    failureReason: text('failure_reason'),
    createdAt: instant('created_at').notNull().defaultNow(),
    /** Set by the worker at pickup; the 120 s timeout is measured from here. */
    startedAt: instant('started_at'),
    endedAt: instant('ended_at'),
  },
  (t) => [
    /** AD-4: one Run per Workflow. `POST /api/runs` answers 409 `run_in_progress`. */
    uniqueIndex('runs_one_running_per_workflow')
      .on(t.workflowId)
      .where(sql`${t.status} = 'running'`),
    index('runs_account_id_created_at_idx').on(t.accountId, t.createdAt),
    index('runs_status_started_at_idx').on(t.status, t.startedAt),
    check(
      'runs_status_enum',
      sql`${oneOf(t.status, RUN_STATUSES)} or ${t.status} like 'failed at %'`,
    ),
  ],
)

// --------------------------------------------------------------------- calls

/**
 * AD-3 fixes this column set at cold-start. There is no `payments` table: a
 * payment *is* the Call row (`from` the Run's wallet, `to` `locked_pay_to`,
 * `amount` `locked_price`, hash `payment_tx_hash`), and FR-40 is a query over
 * `calls` joined to `runs` and `listings`. Do not add a timestamp here to make
 * a query easier: a Call's clock is `started_at`, `ended_at`, and its Run's
 * `created_at`.
 */
export const calls = pgTable(
  'calls',
  {
    /** `call_<ULID>` */
    id: text('id').primaryKey(),
    /** Null for a `verification` Call, which belongs to a Listing, not a Run. */
    runId: text('run_id').references(() => runs.id),
    kind: text('kind').$type<CallKind>().notNull(),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id),
    nodeIndex: integer('node_index').notNull(),
    nodeType: text('node_type').$type<AgentType>().notNull(),
    /** FR-28, verbatim. */
    status: text('status').$type<CallStatus>().notNull(),
    /** Base units, from the Price Lock. Never re-read from the Listing. */
    lockedPrice: amount('locked_price').notNull(),
    lockedPayTo: address('locked_pay_to').notNull(),
    lockedAsset: address('locked_asset').notNull(),
    lockedNetwork: text('locked_network').notNull(),
    request: jsonb('request'),
    response: jsonb('response'),
    /** Every 402 payload received for this Call. */
    paymentRequired: jsonb('payment_required'),
    /** AD-5: the decoded signed authorization `{ nonce, validBefore, from, to, value }`. */
    paymentPayload: jsonb('payment_payload'),
    paymentTxHash: text('payment_tx_hash'),
    /** AD-6: at most two paid attempts, the second with the same header. */
    attempt: integer('attempt').notNull().default(0),
    /** AD-9: production `lastPrice` within 5 s of success, decimal USDT. */
    referencePrice: text('reference_price'),
    referenceAt: instant('reference_at'),
    failureReason: text('failure_reason'),
    /** AD-4: why a still-`pending` Call was skipped at Run end. */
    skipReason: text('skip_reason').$type<SkipReason>(),
    startedAt: instant('started_at'),
    endedAt: instant('ended_at'),
  },
  (t) => [
    index('calls_run_id_node_index_idx').on(t.runId, t.nodeIndex),
    index('calls_listing_id_idx').on(t.listingId),
    index('calls_kind_status_idx').on(t.kind, t.status),
    check('calls_kind_enum', oneOf(t.kind, CALL_KINDS)),
    check('calls_status_enum', oneOf(t.status, CALL_STATUSES)),
    check('calls_node_type_enum', oneOf(t.nodeType, AGENT_TYPES)),
    check('calls_skip_reason_enum', oneOf(t.skipReason, SKIP_REASONS)),
    check('calls_locked_price_base_units', matches(t.lockedPrice, BASE_UNITS_PATTERN)),
    check('calls_locked_pay_to_lower_case', matches(t.lockedPayTo, ADDRESS_PATTERN)),
    check('calls_locked_asset_lower_case', matches(t.lockedAsset, ADDRESS_PATTERN)),
    check('calls_payment_tx_hash_lower_case', matches(t.paymentTxHash, TX_HASH_PATTERN)),
    check('calls_reference_price_decimal', matches(t.referencePrice, DECIMAL_PATTERN)),
    /** A verification Call has no Run; a Run Call always has one (AD-3). */
    check(
      'calls_run_id_matches_kind',
      sql`(${t.kind} = 'run') = (${t.runId} is not null)`,
    ),
  ],
)

// --------------------------------------------------------------- settlements

/**
 * AD-9: every `research` or `risk` Call with `kind = 'run'` that reaches
 * `succeeded` or `failed_after_payment` gets exactly one row. The unique index
 * on `call_id` is what makes "settled at most once" true even if two ticks race.
 */
export const settlements = pgTable(
  'settlements',
  {
    /** `stl_<ULID>` */
    id: text('id').primaryKey(),
    callId: text('call_id')
      .notNull()
      .references(() => calls.id),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id),
    result: text('result').$type<SettlementResult>().notNull(),
    notScoredReason: text('not_scored_reason').$type<NotScoredReason>(),
    /** The mode read at tick time, which governs the whole row. */
    mode: text('mode').$type<PlatformMode>().notNull(),
    /** Verbatim, e.g. "demo settlement rule: 24h trend". Shown as-is in the UI. */
    ruleLabel: text('rule_label').notNull(),
    /** Decimal USDT; the Call's own `reference_price`. */
    startPrice: text('start_price'),
    endPrice: text('end_price'),
    change24hPct: doublePrecision('change_24h_pct'),
    /** Decimal USDT; the `FILLED` execution Call's `reference_price` for a risk row. */
    pFill: text('p_fill'),
    windowMin: text('window_min'),
    windowMax: text('window_max'),
    /** AD-9 allows exactly one source, so the column defaults to it. */
    priceSource: text('price_source').notNull().default(PRICE_SOURCE),
    scoredAt: instant('scored_at').notNull(),
    /** Base units, read from the `Slashed` event. */
    slashAmount: amount('slash_amount'),
    slashTxHash: text('slash_tx_hash'),
    /** The Run's Builder System Wallet address. */
    refundTo: address('refund_to'),
    reputationTxHash: text('reputation_tx_hash'),
  },
  (t) => [
    uniqueIndex('settlements_call_id_key').on(t.callId),
    /** The reputation query reads the listing's last 30 scored rows. */
    index('settlements_listing_id_scored_at_idx').on(t.listingId, t.scoredAt),
    check('settlements_result_enum', oneOf(t.result, SETTLEMENT_RESULTS)),
    check('settlements_not_scored_reason_enum', oneOf(t.notScoredReason, NOT_SCORED_REASONS)),
    check('settlements_mode_enum', oneOf(t.mode, PLATFORM_MODES)),
    check('settlements_slash_amount_base_units', matches(t.slashAmount, BASE_UNITS_PATTERN)),
    check('settlements_slash_tx_hash_lower_case', matches(t.slashTxHash, TX_HASH_PATTERN)),
    check('settlements_reputation_tx_hash_lower_case', matches(t.reputationTxHash, TX_HASH_PATTERN)),
    check('settlements_refund_to_lower_case', matches(t.refundTo, ADDRESS_PATTERN)),
    /** `not_scored` carries a reason; a scored row never does. */
    check(
      'settlements_not_scored_reason_present',
      sql`(${t.result} = 'not_scored') = (${t.notScoredReason} is not null)`,
    ),
  ],
)

// ------------------------------------------------------------------ chain_tx

/**
 * AD-8: `chainWrite(intentKey, buildTx)` inserts the row before sending; if the
 * row already exists it re-checks the receipt and sends nothing. The intent key
 * is therefore the identity of the transaction, which is why it is the primary
 * key rather than a surrogate id. Domain rows are updated only from `confirmed`.
 */
export const chainTx = pgTable(
  'chain_tx',
  {
    /** One of the AD-8 keys, built by `intentKeys` in @agent-desk/schemas. */
    intentKey: text('intent_key').primaryKey(),
    /** Captured at enqueue, e.g. `{ listing_id, before, after }` for a listing intent. */
    payload: jsonb('payload').notNull(),
    status: text('status').$type<ChainTxStatus>().notNull(),
    txHash: text('tx_hash'),
    confirmedAt: instant('confirmed_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('chain_tx_status_idx').on(t.status),
    index('chain_tx_created_at_idx').on(t.createdAt),
    /**
     * History readers select by intent prefix (`price:<listing_id>:%`), which a
     * default-collation btree cannot serve; `text_pattern_ops` can.
     */
    index('chain_tx_intent_key_pattern_idx').using(
      'btree',
      sql`${t.intentKey} text_pattern_ops`,
    ),
    check('chain_tx_status_enum', oneOf(t.status, CHAIN_TX_STATUSES)),
    check('chain_tx_tx_hash_lower_case', matches(t.txHash, TX_HASH_PATTERN)),
  ],
)

// --------------------------------------------------------- platform_settings

/**
 * AD-10: exactly one row, `id = 1`, inserted by the migration. The worker reads
 * it every loop iteration and the API on every request, so flipping Emergency
 * Stop or the mode never needs a restart.
 */
export const platformSettings = pgTable(
  'platform_settings',
  {
    id: integer('id').primaryKey(),
    mode: text('mode').$type<PlatformMode>().notNull().default('production'),
    emergencyStop: boolean('emergency_stop').notNull().default(false),
    /** Decimal USDT: the executor's global order ceiling (AD-11). */
    orderCeilingUsdt: text('order_ceiling_usdt').notNull().default('1000'),
    /** Base units; used when `accounts.daily_fee_budget` is null. */
    defaultDailyFeeBudget: amount('default_daily_fee_budget').notNull(),
    /** Base units; the Platform Wallet's 24 h verification cap (FR-11). */
    verificationCapDaily: amount('verification_cap_daily').notNull(),
    /** Set by `pnpm seed`; only this account may list an `execution` Listing. */
    platformAccountId: text('platform_account_id').references(() => accounts.id),
    /** Worker heartbeat, written every 10 s (Story 2.9). */
    workerSeenAt: instant('worker_seen_at'),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('platform_settings_single_row', sql`${t.id} = 1`),
    check('platform_settings_mode_enum', oneOf(t.mode, PLATFORM_MODES)),
    check('platform_settings_order_ceiling_decimal', matches(t.orderCeilingUsdt, DECIMAL_PATTERN)),
    check(
      'platform_settings_default_budget_base_units',
      matches(t.defaultDailyFeeBudget, BASE_UNITS_PATTERN),
    ),
    check(
      'platform_settings_verification_cap_base_units',
      matches(t.verificationCapDaily, BASE_UNITS_PATTERN),
    ),
  ],
)

/** The single `platform_settings` row, AD-10. */
export const PLATFORM_SETTINGS_ID = 1

export type Account = typeof accounts.$inferSelect
export type NewAccount = typeof accounts.$inferInsert
export type Wallet = typeof wallets.$inferSelect
export type NewWallet = typeof wallets.$inferInsert
export type Listing = typeof listings.$inferSelect
export type NewListing = typeof listings.$inferInsert
export type Workflow = typeof workflows.$inferSelect
export type NewWorkflow = typeof workflows.$inferInsert
export type WorkflowNode = typeof workflowNodes.$inferSelect
export type NewWorkflowNode = typeof workflowNodes.$inferInsert
export type Run = typeof runs.$inferSelect
export type NewRun = typeof runs.$inferInsert
export type Call = typeof calls.$inferSelect
export type NewCall = typeof calls.$inferInsert
export type Settlement = typeof settlements.$inferSelect
export type NewSettlement = typeof settlements.$inferInsert
export type ChainTx = typeof chainTx.$inferSelect
export type NewChainTx = typeof chainTx.$inferInsert
export type PlatformSettingsRow = typeof platformSettings.$inferSelect
