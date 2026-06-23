import { describe, expect, it } from 'vitest'
import type { RunHistoryItem } from '@shared/types'
import {
  cockpitSummary,
  isActiveRun,
  isReadyToPost,
  needsHumanAttention,
  newestRuns,
  runAttentionLabel
} from './cockpit'

function run(partial: Partial<RunHistoryItem>): RunHistoryItem {
  return {
    id: partial.id ?? 1,
    accountId: partial.accountId ?? 1,
    repoId: partial.repoId ?? 1,
    repoFullName: partial.repoFullName ?? 'owner/repo',
    refType: partial.refType ?? 'commit',
    refId: partial.refId ?? 'abc123',
    headSha: partial.headSha ?? 'abcdef123456',
    agentId: partial.agentId ?? 'codex',
    status: partial.status ?? 'done',
    exitCode: partial.exitCode ?? 0,
    startedAt: partial.startedAt ?? '2026-06-23T10:00:00.000Z',
    finishedAt: partial.finishedAt ?? null,
    outputPath: partial.outputPath ?? null,
    postedUrl: partial.postedUrl ?? null,
    localStatus: partial.localStatus ?? 'open',
    localStatusAt: partial.localStatusAt ?? null,
    authorLogin: partial.authorLogin ?? null
  }
}

describe('cockpit helpers', () => {
  it('classifies active and attention-worthy runs', () => {
    const active = run({ status: 'running' })
    const ready = run({ status: 'done', postedUrl: null })
    const posted = run({ status: 'done', postedUrl: 'https://github.com/x/y/pull/1#comment' })
    const failed = run({ status: 'error', exitCode: 1 })

    expect(isActiveRun(active)).toBe(true)
    expect(isReadyToPost(ready)).toBe(true)
    expect(needsHumanAttention(ready)).toBe(true)
    expect(needsHumanAttention(posted)).toBe(false)
    expect(needsHumanAttention(failed)).toBe(true)
    expect(needsHumanAttention(run({ status: 'done', localStatus: 'handled' }))).toBe(false)
    expect(isReadyToPost(run({ status: 'done', localStatus: 'verified' }))).toBe(false)
  })

  it('builds the cockpit summary without treating posted or handled runs as attention items', () => {
    const summary = cockpitSummary([
      run({ status: 'queued' }),
      run({ status: 'running' }),
      run({ status: 'done', postedUrl: null }),
      run({ status: 'done', postedUrl: 'https://github.com/x/y/pull/1#comment' }),
      run({ status: 'done', localStatus: 'handled' }),
      run({ status: 'error', exitCode: 1, localStatus: 'verified' }),
      run({ status: 'killed' })
    ])

    expect(summary).toEqual({
      active: 2,
      attention: 2,
      readyToPost: 1,
      handled: 2,
      posted: 1,
      completed: 3
    })
  })

  it('sorts newest first and returns human labels', () => {
    const older = run({ id: 1, startedAt: '2026-06-23T09:00:00.000Z', status: 'error' })
    const newer = run({ id: 2, startedAt: '2026-06-23T11:00:00.000Z', status: 'running' })

    expect(newestRuns([older, newer]).map((r) => r.id)).toEqual([2, 1])
    expect(runAttentionLabel(older)).toBe('Failed')
    expect(runAttentionLabel(newer)).toBe('Running')
    expect(runAttentionLabel(run({ localStatus: 'handled' }))).toBe('Handled locally')
    expect(runAttentionLabel(run({ localStatus: 'verified' }))).toBe('Verified locally')
  })
})
