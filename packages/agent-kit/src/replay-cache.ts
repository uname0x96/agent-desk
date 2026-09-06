/**
 * AD-7's single-flight replay cache, keyed by `PAYMENT-SIGNATURE`.
 *
 * One payment runs the handler once. A concurrent duplicate awaits the
 * in-flight attempt instead of starting a second one, and the output stays
 * cached for five minutes whether or not settlement succeeded, so the engine's
 * one permitted retry (AD-6) re-attempts `settle` with the same output rather
 * than paying for a second run. A failed attempt is never cached: the retry
 * has to run the handler again.
 *
 * The cache is per process; AD-7's "agent replicas" note keeps it that way.
 */

export const REPLAY_TTL_MS = 5 * 60_000

export interface ReplayCacheOptions {
  ttlMs?: number
  /** Injectable clock, so the TTL is testable without waiting five minutes. */
  now?: () => number
  /** Hard ceiling on retained entries; the oldest expiry goes first. */
  maxEntries?: number
}

export interface ReplayResult<V> {
  value: V
  /** False only for the attempt that actually ran the factory. */
  cached: boolean
}

interface Entry<V> {
  value: V
  expiresAt: number
}

export class ReplayCache<V> {
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly maxEntries: number
  private readonly entries = new Map<string, Entry<V>>()
  private readonly inflight = new Map<string, Promise<V>>()

  constructor(options: ReplayCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? REPLAY_TTL_MS
    this.now = options.now ?? Date.now
    this.maxEntries = options.maxEntries ?? 1000
  }

  /** Settled entries currently held, expired ones excluded. */
  get size(): number {
    this.prune()
    return this.entries.size
  }

  peek(key: string): V | undefined {
    return this.lookup(key)?.value
  }

  async run(key: string, factory: () => Promise<V>): Promise<ReplayResult<V>> {
    const cached = this.lookup(key)
    if (cached) return { value: cached.value, cached: true }

    const inflight = this.inflight.get(key)
    if (inflight) return { value: await inflight, cached: true }

    const attempt = (async () => factory())()
    this.inflight.set(key, attempt)
    try {
      const value = await attempt
      this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
      this.prune()
      return { value, cached: false }
    } finally {
      this.inflight.delete(key)
    }
  }

  clear(): void {
    this.entries.clear()
    this.inflight.clear()
  }

  private lookup(key: string): Entry<V> | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }
}
