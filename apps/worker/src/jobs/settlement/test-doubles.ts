import type {
  Kline,
  KlineRequest,
  MarketData,
  Ticker24h,
} from '@agent-desk/core/ports'
import type { SettlementCandidate, SettlementRowPlan } from '@agent-desk/core/settlement'
import type { PlatformMode, SettlementResult } from '@agent-desk/schemas'
import type {
  ChainOutcome,
  RecordedSlash,
  ReputationRequest,
  SettlementChain,
  SettlementFollowUp,
  SettlementRecord,
  SettlementStore,
  SettlementWork,
  SlashRequest,
} from './ports.ts'

/**
 * In-memory doubles for the two settlement ports. The tick's interesting
 * behaviour is a sequence — score, insert, slash, recompute, write reputation —
 * with a retry path through every step, so these record what was asked of them
 * rather than just answering.
 */

export interface StoredSettlement extends SettlementRecord {
  row: SettlementRowPlan
}

export class FakeSettlementStore implements SettlementStore {
  mode_: PlatformMode = 'demo'
  work: SettlementWork[] = []
  rows: StoredSettlement[] = []
  reputationBps = new Map<string, number | null>()
  listingErrors: { listingId: string; message: string }[] = []
  inserts = 0
  private nextId = 1

  mode(): Promise<PlatformMode> {
    return Promise.resolve(this.mode_)
  }

  due(limit: number): Promise<SettlementWork[]> {
    const settled = new Set(this.rows.map((row) => row.callId))
    return Promise.resolve(this.work.filter((item) => !settled.has(item.candidate.callId)).slice(0, limit))
  }

  workFor(callId: string): Promise<SettlementWork | null> {
    return Promise.resolve(this.work.find((item) => item.candidate.callId === callId) ?? null)
  }

  unfinished(limit: number): Promise<SettlementFollowUp[]> {
    const out: SettlementFollowUp[] = []
    for (const row of this.rows) {
      const needsSlash = row.result === 'failed' && row.slashTxHash === null
      const needsReputation =
        (row.result === 'failed' || row.result === 'passed') && row.reputationTxHash === null
      if (!needsSlash && !needsReputation) continue
      const work = this.work.find((item) => item.candidate.callId === row.callId)
      if (work) out.push({ record: row, work })
    }
    return Promise.resolve(out.slice(0, limit))
  }

  find(callId: string): Promise<SettlementRecord | null> {
    return Promise.resolve(this.rows.find((row) => row.callId === callId) ?? null)
  }

  insert(row: SettlementRowPlan): Promise<{ record: SettlementRecord; inserted: boolean }> {
    this.inserts += 1
    const existing = this.rows.find((stored) => stored.callId === row.callId)
    if (existing) return Promise.resolve({ record: existing, inserted: false })
    const record: StoredSettlement = {
      id: `stl_${this.nextId++}`,
      callId: row.callId,
      listingId: row.listingId,
      result: row.result,
      slashAmount: null,
      slashTxHash: null,
      refundTo: null,
      reputationTxHash: null,
      row,
    }
    this.rows.push(record)
    return Promise.resolve({ record, inserted: true })
  }

  recordSlash(settlementId: string, slash: RecordedSlash): Promise<void> {
    const row = this.mustFind(settlementId)
    row.slashAmount = slash.slashAmount
    row.slashTxHash = slash.slashTxHash
    row.refundTo = slash.refundTo
    return Promise.resolve()
  }

  recordReputation(settlementId: string, txHash: string): Promise<void> {
    this.mustFind(settlementId).reputationTxHash = txHash
    return Promise.resolve()
  }

  recentResults(listingId: string, limit: number): Promise<SettlementResult[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => row.listingId === listingId && row.result !== 'not_scored')
        .map((row) => row.result)
        .reverse()
        .slice(0, limit),
    )
  }

  reputationOf(listingId: string): Promise<number | null> {
    return Promise.resolve(this.reputationBps.get(listingId) ?? null)
  }

  noteListingError(listingId: string, message: string): Promise<void> {
    this.listingErrors.push({ listingId, message })
    return Promise.resolve()
  }

  rowFor(callId: string): StoredSettlement {
    const row = this.rows.find((stored) => stored.callId === callId)
    if (!row) throw new Error(`no settlement for ${callId}`)
    return row
  }

  private mustFind(settlementId: string): StoredSettlement {
    const row = this.rows.find((stored) => stored.id === settlementId)
    if (!row) throw new Error(`no settlement ${settlementId}`)
    return row
  }
}

export class FakeSettlementChain implements SettlementChain {
  slashes: SlashRequest[] = []
  reputationWrites: ReputationRequest[] = []
  slashOutcome: ChainOutcome = { status: 'confirmed', txHash: `0x${'a'.repeat(64)}`, amount: '30000' }
  reputationOutcome: ChainOutcome = { status: 'confirmed', txHash: `0x${'b'.repeat(64)}` }

  slash(request: SlashRequest): Promise<ChainOutcome> {
    this.slashes.push(request)
    return Promise.resolve(this.slashOutcome)
  }

  setReputation(request: ReputationRequest): Promise<ChainOutcome> {
    this.reputationWrites.push(request)
    return Promise.resolve(this.reputationOutcome)
  }
}

export class FakeMarketData implements MarketData {
  price = '600'
  change24hPct = 1.2
  klineRows: Kline[] = []
  requests: KlineRequest[] = []
  failWith: Error | null = null

  lastPrice(): Promise<string> {
    if (this.failWith) return Promise.reject(this.failWith)
    return Promise.resolve(this.price)
  }

  ticker24h(symbol: string): Promise<Ticker24h> {
    if (this.failWith) return Promise.reject(this.failWith)
    return Promise.resolve({
      symbol,
      lastPrice: this.price,
      change24hPct: this.change24hPct,
      highPrice: this.price,
      lowPrice: this.price,
      volume: '1',
      closeTime: 0,
    })
  }

  klines(request: KlineRequest): Promise<Kline[]> {
    this.requests.push(request)
    if (this.failWith) return Promise.reject(this.failWith)
    return Promise.resolve(this.klineRows)
  }
}

export function kline(low: string, high: string): Kline {
  return { openTime: 0, open: low, high, low, close: high, volume: '1', closeTime: 0 }
}

export function work(overrides: Partial<SettlementWork> = {}, candidate: Partial<SettlementCandidate> = {}): SettlementWork {
  return {
    candidate: {
      callId: 'call_1',
      listingId: 'lst_1',
      runId: 'run_1',
      kind: 'run',
      nodeType: 'research',
      status: 'succeeded',
      endedAt: new Date('2026-09-06T12:00:00.000Z'),
      referencePrice: '600',
      symbol: 'BNBUSDT',
      response: { signal: 'SHORT', confidence: 0.9, reason: 'fade it' },
      runEndedAt: new Date('2026-09-06T12:00:01.000Z'),
      fill: null,
      ...candidate,
    },
    lockedPrice: '30000',
    registryListingId: '78',
    refundTo: '0xd0ca46c403e54a76d95abcfb90f8e625176cecc0',
    ...overrides,
  }
}
