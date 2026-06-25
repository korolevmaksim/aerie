// A minimal counting semaphore — the electron-free concurrency primitive the
// runner uses to cap how many agent processes run at once (ROADMAP M0). Kept
// here so it is unit-testable and reusable by the automation engine (M9), which
// must never launch unbounded runs.

export interface Semaphore {
  /**
   * Resolves true when a slot is acquired. If a queued waiter is aborted before it receives a slot,
   * resolves false and is removed from the FIFO queue.
   */
  acquire(signal?: AbortSignal): Promise<boolean>
  /** Returns a slot. Hands it directly to the next waiter if any are queued. */
  release(): void
  /** Slots currently held. */
  active(): number
  /** Callers waiting for a slot. */
  waiting(): number
}

export function createSemaphore(max: number): Semaphore {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error('Semaphore capacity must be a positive integer.')
  }
  let held = 0
  const waiters: Array<{
    resolve: (acquired: boolean) => void
    signal?: AbortSignal
    onAbort?: () => void
  }> = []

  return {
    acquire(signal?: AbortSignal): Promise<boolean> {
      if (signal?.aborted) return Promise.resolve(false)
      if (held < max) {
        held++
        return Promise.resolve(true)
      }
      return new Promise<boolean>((resolve) => {
        const waiter: {
          resolve: (acquired: boolean) => void
          signal?: AbortSignal
          onAbort?: () => void
        } = { resolve, signal }
        const onAbort = (): void => {
          const i = waiters.indexOf(waiter)
          if (i >= 0) waiters.splice(i, 1)
          resolve(false)
        }
        waiter.onAbort = onAbort
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
        waiters.push(waiter)
      })
    },
    release(): void {
      // Transfer the slot directly to a waiter (held stays the same); only when
      // nobody is waiting does the slot actually free up.
      while (waiters.length > 0) {
        const next = waiters.shift()!
        if (next.signal?.aborted) {
          next.resolve(false)
          continue
        }
        if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort)
        next.resolve(true)
        return
      }
      if (held > 0) held--
    },
    active: () => held,
    waiting: () => waiters.length
  }
}
