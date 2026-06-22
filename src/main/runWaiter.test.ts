import { afterEach, describe, expect, it } from 'vitest'
import { noteStatus, registerRun, resetRunEvents } from './runEvents'
import { createRunWaiter } from './runWaiter'

function register(runId: number): void {
  registerRun({
    runId,
    repoFullName: 'o/r',
    shortSha: 'abc1234',
    agentId: 'codex',
    refType: 'commit',
    refId: 'sha',
    status: 'queued',
    startedAt: '2026-06-22T00:00:00Z'
  })
}

afterEach(() => resetRunEvents())

describe('createRunWaiter', () => {
  it('resolves a waiter when its run finishes', async () => {
    const w = createRunWaiter()
    register(1)
    const p = w.wait(1)
    noteStatus(1, 'done')
    await expect(p).resolves.toBe('done')
    w.dispose()
  })

  it('resolves with the terminal status (error/killed) per run', async () => {
    const w = createRunWaiter()
    register(2)
    register(3)
    const p2 = w.wait(2)
    const p3 = w.wait(3)
    noteStatus(2, 'error')
    noteStatus(3, 'killed')
    await expect(p2).resolves.toBe('error')
    await expect(p3).resolves.toBe('killed')
    w.dispose()
  })

  it('only resolves the matching runId', async () => {
    const w = createRunWaiter()
    register(4)
    register(5)
    const p4 = w.wait(4)
    let p5Resolved = false
    void w.wait(5).then(() => {
      p5Resolved = true
    })
    noteStatus(4, 'done')
    await expect(p4).resolves.toBe('done')
    expect(p5Resolved).toBe(false)
    w.dispose()
  })

  it('stops delivering after dispose', async () => {
    const w = createRunWaiter()
    register(6)
    let resolved = false
    void w.wait(6).then(() => {
      resolved = true
    })
    w.dispose()
    register(6)
    noteStatus(6, 'done')
    await Promise.resolve()
    expect(resolved).toBe(false)
  })
})
