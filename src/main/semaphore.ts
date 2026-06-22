// A minimal counting semaphore — the electron-free concurrency primitive the
// runner uses to cap how many agent processes run at once (ROADMAP M0). Kept
// here so it is unit-testable and reusable by the automation engine (M9), which
// must never launch unbounded runs.

export interface Semaphore {
  /** Resolves immediately if a slot is free, otherwise when one is released. */
  acquire(): Promise<void>
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
  const waiters: Array<() => void> = []

  return {
    acquire(): Promise<void> {
      if (held < max) {
        held++
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => waiters.push(resolve))
    },
    release(): void {
      const next = waiters.shift()
      // Transfer the slot directly to a waiter (held stays the same); only when
      // nobody is waiting does the slot actually free up.
      if (next) next()
      else if (held > 0) held--
    },
    active: () => held,
    waiting: () => waiters.length
  }
}
