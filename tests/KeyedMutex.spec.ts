import { KeyedMutex, SKIPPED } from '../src/utils/KeyedMutex'

/** A deferred promise helper for deterministic ordering assertions. */
function deferred<T = void> (): { promise: Promise<T>, resolve: (v: T) => void, reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('KeyedMutex', () => {
  it('serializes calls with the same key (FIFO)', async () => {
    const m = new KeyedMutex()
    const order: string[] = []
    const gate1 = deferred()

    const p1 = m.runExclusive('vm1', async () => {
      order.push('a-start')
      await gate1.promise
      order.push('a-end')
    })
    const p2 = m.runExclusive('vm1', async () => {
      order.push('b-start')
    })

    // b must NOT start until a finishes.
    await Promise.resolve()
    expect(order).toEqual(['a-start'])
    gate1.resolve()
    await Promise.all([p1, p2])
    expect(order).toEqual(['a-start', 'a-end', 'b-start'])
  })

  it('runs different keys concurrently', async () => {
    const m = new KeyedMutex()
    const order: string[] = []
    const gateA = deferred()
    const gateB = deferred()

    const pa = m.runExclusive('a', async () => {
      order.push('a-start')
      await gateA.promise
    })
    const pb = m.runExclusive('b', async () => {
      order.push('b-start')
      await gateB.promise
    })

    // Both bodies should have entered before either resolves (independent keys).
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['a-start', 'b-start'])
    gateA.resolve(); gateB.resolve()
    await Promise.all([pa, pb])
  })

  it('a rejecting op does not poison the queue for that key', async () => {
    const m = new KeyedMutex()
    const p1 = m.runExclusive('vm1', async () => { throw new Error('boom') })
    await expect(p1).rejects.toThrow('boom')
    const result = await m.runExclusive('vm1', async () => 'ok')
    expect(result).toBe('ok')
  })

  it('returns the function result and propagates rejection to the caller', async () => {
    const m = new KeyedMutex()
    await expect(m.runExclusive('k', async () => 42)).resolves.toBe(42)
    await expect(m.runExclusive('k', async () => { throw new Error('x') })).rejects.toThrow('x')
  })

  it('evicts a key once no waiter remains', async () => {
    const m = new KeyedMutex()
    await m.runExclusive('vm1', async () => undefined)
    expect(m.activeKeyCount).toBe(0)
  })

  describe('tryRunExclusive (non-blocking)', () => {
    it('runs when the key is free and returns { ran: true, result }', async () => {
      const m = new KeyedMutex()
      const outcome = await m.tryRunExclusive('vm1', async () => 7)
      expect(outcome).toEqual({ ran: true, result: 7 })
      expect(m.activeKeyCount).toBe(0) // evicted afterwards
    })

    it('SKIPS (does not block, does not run fn) when the key is busy', async () => {
      const m = new KeyedMutex()
      const gate = deferred()
      let bodyRan = false

      // Hold the lock for vm1.
      const held = m.runExclusive('vm1', async () => { await gate.promise })
      await Promise.resolve() // let the held op enter and register the chain

      const outcome = await m.tryRunExclusive('vm1', async () => { bodyRan = true })
      expect(outcome.ran).toBe(false)
      expect(outcome.result).toBe(SKIPPED)
      expect(bodyRan).toBe(false)

      gate.resolve()
      await held
    })

    it('a different key is not considered busy', async () => {
      const m = new KeyedMutex()
      const gate = deferred()
      const held = m.runExclusive('a', async () => { await gate.promise })
      await Promise.resolve()

      const outcome = await m.tryRunExclusive('b', async () => 'ok')
      expect(outcome).toEqual({ ran: true, result: 'ok' })

      gate.resolve()
      await held
    })
  })
})
