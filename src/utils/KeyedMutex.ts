/**
 * KeyedMutex — a tiny, dependency-free per-key async mutex.
 *
 * Semantics:
 *   - Same key  => callers run serialized, FIFO (in the order they enqueued).
 *   - Different keys => run concurrently (independent chains).
 *   - A predecessor's rejection is swallowed for the purpose of scheduling, so
 *     one failed/throwing operation can never poison or wedge the queue for
 *     that key — the next waiter always runs.
 *   - Keys auto-evict once no waiter remains, so the internal Map does not grow
 *     unbounded across the lifetime of thousands of VMs.
 *
 * This is sufficient for a single-process application (the whole Infinibay
 * backend, including in-process crons, shares one Infinization singleton), and
 * avoids pulling in an external async-mutex dependency.
 */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>()

  /**
   * Runs `fn` exclusively for `key`. Concurrent calls with the same key are
   * serialized; calls with different keys proceed in parallel.
   *
   * @returns whatever `fn` resolves to (or rejects with — the caller still sees
   *          the real error; only the *scheduling* chain ignores it).
   */
  async runExclusive<T> (key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    // Chain after the predecessor regardless of whether it resolved or rejected.
    const run = prev.then(() => fn(), () => fn())
    // Track a never-rejecting tail so a thrown op cannot break the chain.
    const settle = run.then(() => undefined, () => undefined)
    this.chains.set(key, settle)
    try {
      return await run
    } finally {
      // Evict only if we are still the tail (no waiter queued behind us).
      if (this.chains.get(key) === settle) {
        this.chains.delete(key)
      }
    }
  }

  /** Number of keys with an in-flight or queued operation (for tests/diagnostics). */
  get activeKeyCount (): number {
    return this.chains.size
  }
}
