// Bridges the run lifecycle hub (`runEvents`) to the engine's `waitForRun` port
// (ROADMAP M9a). One `onFinished` subscription resolves per-runId promises, so the
// engine can `await` a step's run terminating. Electron-free (so it's unit-testable):
// `runEvents` is a plain Node EventEmitter.

import { onFinished } from './runEvents'

export type TerminalStatus = 'done' | 'error' | 'killed'

export interface RunWaiter {
  /**
   * Resolves when the run reaches a terminal state. Register the wait BEFORE the run can
   * finish (the engine calls this synchronously right after `startStep`, and the runner
   * defers execution a tick, so the resolver is always in place first). One wait per runId:
   * calling `wait` twice for the same id replaces the first resolver (last wins) — the engine
   * never does this (one wait per started run).
   */
  wait(runId: number): Promise<TerminalStatus>
  /** Drops the subscription + any unresolved waiters (call on engine teardown). */
  dispose(): void
}

export function createRunWaiter(): RunWaiter {
  const pending = new Map<number, (status: TerminalStatus) => void>()
  const unsubscribe = onFinished((run) => {
    const resolve = pending.get(run.runId)
    if (resolve) {
      pending.delete(run.runId)
      // onFinished only ever fires for terminal statuses (done/error/killed).
      resolve(run.status as TerminalStatus)
    }
  })
  return {
    wait: (runId) => new Promise<TerminalStatus>((resolve) => pending.set(runId, resolve)),
    dispose: () => {
      unsubscribe()
      pending.clear()
    }
  }
}
