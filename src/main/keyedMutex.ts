// A per-key async mutex: functions sharing a key run strictly one-at-a-time, while different
// keys run concurrently. Used to serialize `git fetch`/`clone` per app-owned clone so concurrent
// reviews on the SAME repo don't race on the clone's ref updates — that race, when the remote has
// force-updated refs (force-push / dependabot rebase), makes git reject the ref transaction with
// "incorrect old value provided". Pure (no electron) + unit-testable.

export interface KeyedMutex {
  /** Run `fn` exclusively for `key` — after any in-flight run for the same key settles. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>
}

export function createKeyedMutex(): KeyedMutex {
  // Per key: the tail of the chain — a promise that settles (never rejects) when the last queued
  // op for that key finishes, so the next waiter starts whether the previous one resolved or threw.
  const tails = new Map<string, Promise<void>>()

  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve()
      const result = prev.then(() => fn())
      const tail = result.then(
        () => {},
        () => {}
      )
      tails.set(key, tail)
      // Drop the entry once the chain drains, so the map doesn't grow unboundedly.
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return result
    }
  }
}
