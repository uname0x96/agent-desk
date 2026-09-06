import { z } from 'zod'
import {
  intentPrefixOf,
  type AgentHistoryIntent,
  type AgentHistoryResponse,
  type AgentHistoryRow,
  type AgentHistoryTerms,
  type AgentSlashView,
  type AgentVerificationCall,
  type ChainTxStatus,
  type ListingStatus,
} from '@agent-desk/schemas'
import type { ChainTxView } from './listing-progress.ts'
import { MARKETPLACE_STATUSES } from './listings-view.ts'

/**
 * `GET /api/listings/<id>/history` — an Agent's on-chain record, and the four
 * series `/agents/<listing_id>` draws from it (Story 4.4 extended by 5.4).
 *
 * ┌─ AD-2 ─────────────────────────────────────────────────────────────────┐
 * │ "Price history is the `list:` row plus `price:` rows of `chain_tx`;    │
 * │ reputation history is the `reputation:` rows." There is no history     │
 * │ table and nothing here reads the chain: AD-8 wrote each row, with its  │
 * │ `before` and `after` captured at enqueue, before the transaction was   │
 * │ sent. This module only re-reads them.                                  │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Everything in this file is pure, so the route, the page and the tests apply
 * one definition of what a `price:` row means. The database read that feeds it
 * lives in `[id]/history/read.ts`, next to the route, which is also why this
 * module is safe for the client component to import.
 */

// ------------------------------------------------------------- the payloads

/**
 * AD-8: `{ listing_id, before: { price, stake, paused }, after: { ... } }`, for
 * `list:`, `price:`, `stake:` and `pause:`.
 */
const listingTerms = z.object({
  price: z.string().optional(),
  stake: z.string().optional(),
  paused: z.boolean().optional(),
})
const listingIntentPayload = z.object({
  before: listingTerms.optional(),
  after: listingTerms.optional(),
})

/** Story 4.4: a `reputation:` payload states bps directly, not a terms object. */
const reputationIntentPayload = z.object({
  before: z.number().int().nullable().optional(),
  after: z.number().int(),
})

/** Story 4.3: a `slash:` payload names the Call it is slashing for. */
const slashIntentPayload = z.object({
  call_id: z.string().optional(),
  settlement_id: z.string().optional(),
  amount: z.string(),
  to: z.string().optional(),
})

/** The six intents that make up the record. `identity:` is the Creator's pipeline. */
const HISTORY_INTENTS: readonly AgentHistoryIntent[] = [
  'list',
  'price',
  'stake',
  'pause',
  'slash',
  'reputation',
]

/**
 * One `chain_tx` row as the API states it. A payload that does not parse still
 * yields a row with empty terms rather than disappearing: a transaction the
 * Registry accepted must never vanish from the record because its payload was
 * written by an older shape of the code.
 */
export function toHistoryRow(row: ChainTxView): AgentHistoryRow | null {
  const intent = intentPrefixOf(row.intent_key)
  if (intent === null || !HISTORY_INTENTS.includes(intent as AgentHistoryIntent)) return null

  const common = {
    intent_key: row.intent_key,
    intent: intent as AgentHistoryIntent,
    status: row.status as ChainTxStatus,
    tx_hash: row.tx_hash,
    created_at: row.created_at,
    confirmed_at: row.confirmed_at,
  }

  if (intent === 'slash') {
    return { ...common, before: {}, after: {}, slash: toSlashView(row) }
  }
  if (intent === 'reputation') {
    const parsed = reputationIntentPayload.safeParse(row.payload)
    if (!parsed.success) return { ...common, before: {}, after: {}, slash: null }
    const before = parsed.data.before
    return {
      ...common,
      before: before === null || before === undefined ? {} : { reputation_bps: before },
      after: { reputation_bps: parsed.data.after },
      slash: null,
    }
  }

  const parsed = listingIntentPayload.safeParse(row.payload)
  return {
    ...common,
    before: parsed.success ? terms(parsed.data.before) : {},
    after: parsed.success ? terms(parsed.data.after) : {},
    slash: null,
  }
}

function terms(side: z.infer<typeof listingTerms> | undefined): AgentHistoryTerms {
  if (side === undefined) return {}
  return {
    ...(side.price === undefined ? {} : { price: side.price }),
    ...(side.stake === undefined ? {} : { stake: side.stake }),
    ...(side.paused === undefined ? {} : { paused: side.paused }),
  }
}

/**
 * AD-8 makes the key `slash:<call_id>`, so the Call is recoverable from the key
 * even when the payload is not the shape Story 4.3 writes. AD-13 stores
 * addresses lower-case, and the schema refuses any other spelling.
 */
function toSlashView(row: ChainTxView): AgentSlashView | null {
  const fromKey = row.intent_key.slice('slash:'.length)
  const parsed = slashIntentPayload.safeParse(row.payload)
  if (!parsed.success) return null
  return {
    call_id: parsed.data.call_id ?? fromKey,
    settlement_id: parsed.data.settlement_id ?? null,
    amount: parsed.data.amount,
    to: parsed.data.to === undefined ? null : parsed.data.to.toLowerCase(),
  }
}

// --------------------------------------------------------------- the order

/**
 * Oldest first, because this is a record being read forwards: the `list:` row is
 * the price the Agent started at and every later row is what moved it.
 *
 * The `list:` row is pinned to the front rather than sorted there. It is the
 * first Registry write of a Listing's life by construction (AD-2 runs
 * verification, then `register`, then `list`), so pinning it makes "the price
 * history starts at the listed price" true even if two rows share a timestamp.
 * Rows that tie on time are separated by their intent key, which is unique.
 */
export function orderHistory(rows: readonly AgentHistoryRow[]): AgentHistoryRow[] {
  const listed = rows.filter((row) => row.intent === 'list')
  const rest = rows.filter((row) => row.intent !== 'list')
  return [...listed, ...rest].sort(compareRows)
}

function compareRows(a: AgentHistoryRow, b: AgentHistoryRow): number {
  if (a.intent === 'list' && b.intent !== 'list') return -1
  if (b.intent === 'list' && a.intent !== 'list') return 1
  const at = Date.parse(a.created_at)
  const bt = Date.parse(b.created_at)
  if (at !== bt) return at - bt
  return a.intent_key < b.intent_key ? -1 : a.intent_key > b.intent_key ? 1 : 0
}

/**
 * The whole body, from the rows the read handed back. A `chain_tx` row whose
 * intent is not one of the six is dropped here rather than in SQL, so the read
 * stays one query per table and the rule that says which intents make up an
 * Agent's record lives in one place.
 *
 * The parameter is structural on purpose: `ListingHistorySource` in
 * `[id]/history/read.ts` satisfies it, and this module stays free of the import
 * that would drag `@agent-desk/db` into the client bundle.
 */
export function toAgentHistory(source: {
  listingId: string
  type: AgentHistoryResponse['type']
  chainTx: readonly ChainTxView[]
  verification: AgentVerificationCall | null
}): AgentHistoryResponse {
  const rows = source.chainTx.flatMap((row) => {
    const mapped = toHistoryRow(row)
    return mapped === null ? [] : [mapped]
  })
  return {
    listing_id: source.listingId,
    type: source.type,
    rows: orderHistory(rows),
    verification: source.verification,
  }
}

/** AD-12: the page polls while a transaction of this Agent can still move. */
export function hasPendingHistory(history: AgentHistoryResponse): boolean {
  return history.rows.some((row) => row.status === 'pending')
}

/**
 * Who may read an Agent's record, decided in one place so the route is only
 * wiring.
 *
 * An id nobody listed and an id this session may not see get the same answer,
 * 404 `not_found`: a Listing the marketplace does not show — `verifying` or
 * `failed` — is answered only to its Creator, and to everyone else with 404
 * rather than 403, so the route never confirms that an id it refuses to serve
 * exists. That is the rule `GET /api/listings/<id>` next door applies, and both
 * halves of the page have to agree on it.
 */
export function agentRecordAccess(
  source: { status: ListingStatus; creatorAccountId: string } | null,
  sessionAccountId: string,
): 'ok' | 'not_found' {
  if (source === null) return 'not_found'
  const visible =
    source.creatorAccountId === sessionAccountId || MARKETPLACE_STATUSES.includes(source.status)
  return visible ? 'ok' : 'not_found'
}

// -------------------------------------------------------------- price history

export interface PricePoint {
  intent_key: string
  /** When it landed on chain, or when it was enqueued while it is still pending. */
  at: string
  status: ChainTxStatus
  /** Base units. Null on the `list:` row: there was no price before it. */
  old_price: string | null
  new_price: string
  tx_hash: string | null
}

/**
 * FR-9, AD-2: the `list:` row plus the `price:` rows, paired into the
 * (old price, new price) the table prints.
 *
 * Each row carries its own `before.price`, captured at enqueue from the cache,
 * which is what makes this a history rather than a guess. The previous point's
 * new price is only the fallback, for a row written before AD-8 fixed the
 * payload; the `list:` row's `before` is the zero the pipeline writes for a
 * first listing, which is not a price and is reported as none.
 *
 * `rows` are expected in `orderHistory` order.
 */
export function priceHistory(rows: readonly AgentHistoryRow[]): PricePoint[] {
  const points: PricePoint[] = []
  for (const row of rows) {
    if (row.intent !== 'list' && row.intent !== 'price') continue
    const next = row.after.price
    if (next === undefined) continue
    const previous = points.at(-1)?.new_price ?? null
    points.push({
      intent_key: row.intent_key,
      at: landedAt(row),
      status: row.status,
      old_price: row.intent === 'list' ? null : (row.before.price ?? previous),
      new_price: next,
      tx_hash: row.tx_hash,
    })
  }
  return points
}

// ---------------------------------------------------------- reputation series

export interface ReputationPoint {
  intent_key: string
  at: string
  /** Basis points, as the Registry holds them. */
  bps: number
  tx_hash: string | null
}

/**
 * FR-36, AD-9: one point per `reputation:` row, valued at the bps that write
 * moved the Registry to.
 *
 * A `reverted` or `failed` row is left out. AD-8 updates domain rows only from
 * `confirmed`, so a reverted write never became the Agent's Reputation, and
 * plotting it would draw a percentage the Registry never held. A `pending` row
 * is kept: it is the value in flight, and AD-12's poll replaces it in two
 * seconds.
 */
export function reputationSeries(rows: readonly AgentHistoryRow[]): ReputationPoint[] {
  const points: ReputationPoint[] = []
  for (const row of rows) {
    if (row.intent !== 'reputation') continue
    if (row.status === 'reverted' || row.status === 'failed') continue
    const bps = row.after.reputation_bps
    if (bps === undefined) continue
    points.push({ intent_key: row.intent_key, at: landedAt(row), bps, tx_hash: row.tx_hash })
  }
  return points
}

// ------------------------------------------------------------- stake history

export type StakeEventKind = 'stake' | 'slash'

export interface StakeEvent {
  intent_key: string
  kind: StakeEventKind
  at: string
  status: ChainTxStatus
  /** Base units moved: the top-up added, or the amount the Slash asked for. */
  amount: string
  /** Base units the Stake stood at afterwards; null for a Slash, which the contract clamps. */
  total: string | null
  tx_hash: string | null
  /** `slash:` only — the Call that was refused and the wallet that was refunded. */
  call_id: string | null
  to: string | null
}

/**
 * FR-7 and FR-35 in one column, because the Stake only ever moves two ways: the
 * Creator adds to it, and a failed Settlement takes from it.
 *
 * A `stake:` row states the total it moved the Stake to, so the amount added is
 * the difference AD-8 captured; a `slash:` row states the amount directly and no
 * total, because the contract clamps to the remaining Stake and only the
 * `Slashed` event knows the clamped figure (AD-9).
 */
export function stakeHistory(rows: readonly AgentHistoryRow[]): StakeEvent[] {
  const events: StakeEvent[] = []
  for (const row of rows) {
    if (row.intent === 'stake') {
      const total = row.after.stake
      if (total === undefined) continue
      const added = BigInt(total) - BigInt(row.before.stake ?? '0')
      events.push({
        intent_key: row.intent_key,
        kind: 'stake',
        at: landedAt(row),
        status: row.status,
        amount: (added < 0n ? 0n : added).toString(),
        total,
        tx_hash: row.tx_hash,
        call_id: null,
        to: null,
      })
      continue
    }
    if (row.intent === 'slash' && row.slash !== null) {
      events.push({
        intent_key: row.intent_key,
        kind: 'slash',
        at: landedAt(row),
        status: row.status,
        amount: row.slash.amount,
        total: null,
        tx_hash: row.tx_hash,
        call_id: row.slash.call_id,
        to: row.slash.to,
      })
    }
  }
  return events
}

// ------------------------------------------------------------- pause history

export interface PauseEvent {
  intent_key: string
  at: string
  status: ChainTxStatus
  paused: boolean
  tx_hash: string | null
}

/** AD-2: the pause history is the `pause:` rows, same as the price history is the `price:` rows. */
export function pauseHistory(rows: readonly AgentHistoryRow[]): PauseEvent[] {
  const events: PauseEvent[] = []
  for (const row of rows) {
    if (row.intent !== 'pause') continue
    const paused = row.after.paused
    if (paused === undefined) continue
    events.push({
      intent_key: row.intent_key,
      at: landedAt(row),
      status: row.status,
      paused,
      tx_hash: row.tx_hash,
    })
  }
  return events
}

// -------------------------------------------------------- the verification Call

/** FR-11, verbatim on the page for an `execution` Agent. */
export const PLATFORM_LISTED_NOTE = 'listed by the platform without a verification Call'

const NO_CALL_NOTE = 'no verification Call was recorded for this Agent'

export type VerificationRecord =
  | { kind: 'platform_listed'; note: string; call: null }
  | { kind: 'missing'; note: string; call: null }
  | { kind: 'call'; note: null; call: AgentVerificationCall }

/**
 * FR-11: an `execution` Agent is listed without a sample Call, because the
 * sample would place a real order, and AD-10 lets only the platform account list
 * one. So its record is that sentence, not an empty panel — and the two branches
 * are equivalent in practice, since no path ever writes a verification Call for
 * an `execution` Listing.
 *
 * AD-9 never scores a `kind = 'verification'` Call, which is why this is the
 * verification record and never appears as a settlement.
 */
export function describeVerification(history: AgentHistoryResponse): VerificationRecord {
  if (history.type === 'execution') {
    return { kind: 'platform_listed', note: PLATFORM_LISTED_NOTE, call: null }
  }
  if (history.verification === null) {
    return { kind: 'missing', note: NO_CALL_NOTE, call: null }
  }
  return { kind: 'call', note: null, call: history.verification }
}

// ------------------------------------------------------------ the reputation line

export interface ChartBox {
  width: number
  height: number
  padding: number
}

export interface ChartDot {
  x: number
  y: number
  point: ReputationPoint
}

export interface ChartGeometry {
  /** The `points` attribute of an SVG `<polyline>`. */
  polyline: string
  dots: ChartDot[]
  box: ChartBox
}

/** Wide and short: this is a trend line under a heading, not a dashboard tile. */
export const REPUTATION_CHART: ChartBox = { width: 640, height: 160, padding: 12 }

/** AD-9 writes Reputation in basis points, so the axis is the whole 0..100 %. */
export const REPUTATION_MAX_BPS = 10_000

/**
 * The geometry of the Reputation line, as plain numbers, so the page can draw it
 * with an inline `<polyline>` and the test can check the shape without a browser.
 *
 * The y axis is fixed at 0..100 % rather than scaled to the data: an axis that
 * adapts turns a run of 98, 99, 98 into a mountain range, and this number is
 * meant to be compared between Agents. The x axis is the row index, because the
 * AC asks for one point per `reputation:` row and settlements do not arrive on a
 * clock worth spacing by.
 */
export function reputationChart(
  series: readonly ReputationPoint[],
  box: ChartBox = REPUTATION_CHART,
): ChartGeometry | null {
  if (series.length === 0) return null

  const span = box.width - box.padding * 2

  const dots = series.map((point, index) => ({
    x: round(
      series.length === 1 ? box.width / 2 : box.padding + (index / (series.length - 1)) * span,
    ),
    y: reputationY(point.bps, box),
    point,
  }))

  return { polyline: dots.map((dot) => `${dot.x},${dot.y}`).join(' '), dots, box }
}

/** Where a basis-point value sits on the line. The dots and the guides share it. */
export function reputationY(bps: number, box: ChartBox = REPUTATION_CHART): number {
  const height = box.height - box.padding * 2
  return round(box.padding + (1 - clampBps(bps) / REPUTATION_MAX_BPS) * height)
}

function clampBps(bps: number): number {
  if (bps < 0) return 0
  return bps > REPUTATION_MAX_BPS ? REPUTATION_MAX_BPS : bps
}

/** Two decimals is well inside a pixel and keeps the rendered markup stable. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * When the transaction landed. A row that has not confirmed has no `confirmed_at`
 * yet, and its enqueue time is the only honest timestamp for it.
 */
function landedAt(row: AgentHistoryRow): string {
  return row.confirmed_at ?? row.created_at
}
