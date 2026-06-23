import { describe, expect, it } from 'vitest'
import { createKeyedMutex } from './keyedMutex'

const defer = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('createKeyedMutex', () => {
  it('runs same-key functions strictly one at a time (no overlap)', async () => {
    const m = createKeyedMutex()
    const order: string[] = []
    const a = defer()
    const b = defer()

    const p1 = m.run('k', async () => {
      order.push('a:start')
      await a.promise
      order.push('a:end')
    })
    const p2 = m.run('k', async () => {
      order.push('b:start')
      await b.promise
      order.push('b:end')
    })

    // While a is in flight, b must NOT have started (serialization).
    await Promise.resolve()
    expect(order).toEqual(['a:start'])
    a.resolve()
    await p1
    b.resolve()
    await p2
    // Final order proves b ran strictly after a, with no interleaving.
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('runs different keys concurrently', async () => {
    const m = createKeyedMutex()
    const order: string[] = []
    const a = defer()
    const p1 = m.run('x', async () => {
      order.push('x:start')
      await a.promise
    })
    const p2 = m.run('y', async () => {
      order.push('y:start')
    })
    await p2
    // y started + finished while x is still blocked → keys are independent.
    expect(order).toEqual(['x:start', 'y:start'])
    a.resolve()
    await p1
  })

  it('a rejecting op does not block the next op for the same key', async () => {
    const m = createKeyedMutex()
    const p1 = m.run('k', async () => {
      throw new Error('boom')
    })
    await expect(p1).rejects.toThrow('boom')
    const p2 = m.run('k', async () => 'ok')
    await expect(p2).resolves.toBe('ok')
  })

  it('returns the function result and propagates its error', async () => {
    const m = createKeyedMutex()
    await expect(m.run('k', async () => 42)).resolves.toBe(42)
    await expect(m.run('k', async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
  })
})
