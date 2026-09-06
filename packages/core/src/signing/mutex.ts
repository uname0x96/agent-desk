/**
 * AD-5: one async mutex per wallet. Every signature and every chain send for a
 * wallet passes through its lock, so the engine and the settlement loop can
 * never build two transactions from the same nonce, and the budget and stake
 * checks are read-and-decide inside the same critical section that signs.
 *
 * One worker instance runs in the MVP (AD-4), so an in-process lock is the
 * whole guarantee. If a second worker is ever added this must become an advisory
 * lock in Postgres keyed by wallet id; nothing else about the policy changes,
 * which is why the lock is a separate module with a one-method surface.
 */

type Release = () => void

/** A fair, FIFO async mutex. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve()
  private depth = 0

  /** True while a holder has the lock or is queued for it. Tests read this. */
  get locked(): boolean {
    return this.depth > 0
  }

  async acquire(): Promise<Release> {
    this.depth += 1
    let release: Release = () => {}
    const next = new Promise<void>((resolve) => {
      release = () => {
        this.depth -= 1
        resolve()
      }
    })
    const previous = this.tail
    this.tail = previous.then(() => next)
    await previous
    return release
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

/**
 * The per-wallet lock table. Locks are kept for the life of the process: there
 * are at most a few hundred wallets in the MVP, and dropping an idle lock would
 * open a window where two callers each create one.
 */
export class KeyedMutex {
  private readonly locks = new Map<string, Mutex>()

  for(key: string): Mutex {
    let lock = this.locks.get(key)
    if (!lock) {
      lock = new Mutex()
      this.locks.set(key, lock)
    }
    return lock
  }

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.for(key).run(operation)
  }

  /** Diagnostics only. */
  get size(): number {
    return this.locks.size
  }
}
