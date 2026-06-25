import { describe, expect, it } from 'vitest'
import { createSemaphore } from './semaphore'

describe('createSemaphore', () => {
  it('rejects a non-positive or non-integer capacity', () => {
    expect(() => createSemaphore(0)).toThrow()
    expect(() => createSemaphore(-1)).toThrow()
    expect(() => createSemaphore(1.5)).toThrow()
  })

  it('grants up to `max` slots immediately, then queues the rest', async () => {
    const sem = createSemaphore(2)
    await sem.acquire()
    await sem.acquire()
    expect(sem.active()).toBe(2)
    expect(sem.waiting()).toBe(0)

    let third = false
    const pending = sem.acquire().then(() => {
      third = true
    })
    // The third acquire must wait — no slot is free.
    await Promise.resolve()
    expect(third).toBe(false)
    expect(sem.waiting()).toBe(1)

    sem.release()
    await pending
    expect(third).toBe(true)
    expect(sem.waiting()).toBe(0)
    expect(sem.active()).toBe(2) // the slot transferred to the waiter
  })

  it('resumes queued waiters in FIFO order', async () => {
    const sem = createSemaphore(1)
    await sem.acquire() // hold the only slot
    const order: number[] = []
    const a = sem.acquire().then(() => order.push(1))
    const b = sem.acquire().then(() => order.push(2))
    expect(sem.waiting()).toBe(2)
    sem.release() // hands the slot to waiter a (enqueued first)
    await a
    sem.release() // then to waiter b
    await b
    expect(order).toEqual([1, 2])
  })

  it('lets a queued waiter be cancelled before a slot is released', async () => {
    const sem = createSemaphore(1)
    await sem.acquire()
    const controller = new AbortController()
    const acquired = sem.acquire(controller.signal)
    expect(sem.waiting()).toBe(1)

    controller.abort()
    await expect(acquired).resolves.toBe(false)
    expect(sem.waiting()).toBe(0)

    sem.release()
    expect(sem.active()).toBe(0)
  })

  it('frees a slot when nobody is waiting, and never goes negative', () => {
    const sem = createSemaphore(1)
    sem.release() // over-release with no holders
    expect(sem.active()).toBe(0)
  })

  it('serializes work so no more than `max` run concurrently', async () => {
    const sem = createSemaphore(2)
    let running = 0
    let peak = 0
    const task = async (): Promise<void> => {
      await sem.acquire()
      running++
      peak = Math.max(peak, running)
      await Promise.resolve()
      running--
      sem.release()
    }
    await Promise.all([task(), task(), task(), task(), task()])
    expect(peak).toBeLessThanOrEqual(2)
    expect(sem.active()).toBe(0)
  })
})
