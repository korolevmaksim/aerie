import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FinishedRun } from './runEvents'
import {
  activeCount,
  getActiveRuns,
  noteOutput,
  noteStatus,
  onChange,
  onFinished,
  onOutput,
  onStatus,
  registerRun,
  resetRunEvents
} from './runEvents'

function makeRun(runId: number, over: Partial<Parameters<typeof registerRun>[0]> = {}): void {
  registerRun({
    runId,
    repoFullName: 'owner/repo',
    shortSha: 'a1b2c3d',
    agentId: 'dummy',
    refType: 'commit',
    refId: 'a1b2c3d',
    status: 'queued',
    startedAt: `2026-06-22T00:00:0${runId}.000Z`,
    ...over
  })
}

afterEach(() => resetRunEvents())

describe('runEvents registry', () => {
  it('tracks queued+running runs and drops them on a terminal status', () => {
    makeRun(1)
    expect(activeCount()).toBe(1)
    noteStatus(1, 'running')
    expect(activeCount()).toBe(1)
    expect(getActiveRuns()[0].status).toBe('running')

    noteStatus(1, 'done', { exitCode: 0 })
    expect(activeCount()).toBe(0)
    expect(getActiveRuns()).toHaveLength(0)
  })

  it('orders the active snapshot by start time then id', () => {
    makeRun(2, { startedAt: '2026-06-22T00:00:05.000Z' })
    makeRun(1, { startedAt: '2026-06-22T00:00:01.000Z' })
    expect(getActiveRuns().map((r) => r.runId)).toEqual([1, 2])
  })

  it('emits change on register, status transition, and finish', () => {
    const onChangeSpy = vi.fn()
    onChange(onChangeSpy)
    makeRun(1)
    noteStatus(1, 'running')
    noteStatus(1, 'error', { exitCode: 1 })
    expect(onChangeSpy).toHaveBeenCalledTimes(3)
  })

  it('emits a status update for every transition with normalized extras', () => {
    const updates: unknown[] = []
    onStatus((u) => updates.push(u))
    makeRun(1)
    noteStatus(1, 'running')
    noteStatus(1, 'done', { exitCode: 0, outputPath: '/runs/1.out' })
    expect(updates).toEqual([
      { runId: 1, status: 'running', exitCode: null, outputPath: null },
      { runId: 1, status: 'done', exitCode: 0, outputPath: '/runs/1.out' }
    ])
  })

  it('emits finished with the full active-run metadata + exit code on terminal status', () => {
    const finished: FinishedRun[] = []
    onFinished((r) => finished.push(r))
    makeRun(7, { repoFullName: 'me/aerie', shortSha: 'deadbee', agentId: 'codex' })
    noteStatus(7, 'running')
    noteStatus(7, 'done', { exitCode: 0 })
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({
      runId: 7,
      repoFullName: 'me/aerie',
      shortSha: 'deadbee',
      agentId: 'codex',
      status: 'done',
      exitCode: 0
    })
  })

  it('does not emit finished for a run that was never registered (no metadata)', () => {
    const finished: FinishedRun[] = []
    const statuses: unknown[] = []
    onFinished((r) => finished.push(r))
    onStatus((u) => statuses.push(u))
    // A terminal status with no prior register still fans out status, but cannot
    // emit a finished payload (no repo/sha metadata to show in a notification).
    noteStatus(99, 'error', { exitCode: 1 })
    expect(statuses).toHaveLength(1)
    expect(finished).toHaveLength(0)
  })

  it('re-emits output chunks to subscribers', () => {
    const chunks: unknown[] = []
    onOutput((c) => chunks.push(c))
    noteOutput({ runId: 1, stream: 'stdout', chunk: 'hello' })
    expect(chunks).toEqual([{ runId: 1, stream: 'stdout', chunk: 'hello' }])
  })

  it('unsubscribes cleanly', () => {
    const spy = vi.fn()
    const off = onChange(spy)
    makeRun(1)
    off()
    noteStatus(1, 'running')
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
