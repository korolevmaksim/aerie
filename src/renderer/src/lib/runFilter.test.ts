import { describe, expect, it } from 'vitest'
import type { RunHistoryItem } from '@shared/types'
import { filterRuns, matchesRunQuery } from './runFilter'

const run = (over: Partial<RunHistoryItem> = {}): RunHistoryItem => ({
  id: 1,
  repoId: 7,
  accountId: 3,
  repoFullName: 'octocat/hello-world',
  refType: 'commit',
  refId: 'main',
  headSha: 'abcdef1234567890',
  agentId: 'codex',
  status: 'done',
  exitCode: 0,
  startedAt: '2026-06-23T00:00:00Z',
  finishedAt: '2026-06-23T00:05:00Z',
  outputPath: null,
  postedUrl: null,
  authorLogin: 'monalisa',
  ...over
})

describe('matchesRunQuery', () => {
  it('matches all on a blank/whitespace query', () => {
    expect(matchesRunQuery(run(), '')).toBe(true)
    expect(matchesRunQuery(run(), '   ')).toBe(true)
  })

  it('matches each searchable field (case-insensitive substring)', () => {
    expect(matchesRunQuery(run(), 'hello-world')).toBe(true) // repoFullName
    expect(matchesRunQuery(run(), 'CODEX')).toBe(true) // agentId, case-insensitive
    expect(matchesRunQuery(run(), 'abcdef')).toBe(true) // headSha prefix
    expect(matchesRunQuery(run(), 'done')).toBe(true) // status
    expect(matchesRunQuery(run(), 'monalisa')).toBe(true) // authorLogin
  })

  it('matches a PR by number with or without the # prefix', () => {
    const pr = run({ refType: 'pr', refId: '42' })
    expect(matchesRunQuery(pr, '42')).toBe(true)
    expect(matchesRunQuery(pr, 'pr #42')).toBe(true)
  })

  it('matches a project review by project label and branch', () => {
    const project = run({ refType: 'project', refId: 'main' })
    expect(matchesRunQuery(project, 'project')).toBe(true)
    expect(matchesRunQuery(project, 'main')).toBe(true)
  })

  it('requires ALL tokens to match (AND)', () => {
    expect(matchesRunQuery(run({ agentId: 'codex', status: 'error' }), 'codex error')).toBe(true)
    expect(matchesRunQuery(run({ agentId: 'codex', status: 'done' }), 'codex error')).toBe(false)
  })

  it('ANDs tokens that live in DIFFERENT fields', () => {
    // 'octocat' (repoFullName) + 'done' (status) — both must be present in the one run.
    expect(matchesRunQuery(run(), 'octocat done')).toBe(true)
    expect(matchesRunQuery(run({ status: 'error' }), 'octocat done')).toBe(false)
  })

  it('only synthesizes "pr #" text for PR runs (a commit run does not match "pr")', () => {
    expect(matchesRunQuery(run({ refType: 'commit', refId: 'main' }), 'pr')).toBe(false)
    expect(matchesRunQuery(run({ refType: 'pr', refId: '42' }), 'pr')).toBe(true)
  })

  it('returns false when nothing matches', () => {
    expect(matchesRunQuery(run(), 'nonexistent')).toBe(false)
  })

  it('tolerates a null authorLogin', () => {
    expect(matchesRunQuery(run({ authorLogin: null }), 'codex')).toBe(true)
    expect(matchesRunQuery(run({ authorLogin: null }), 'monalisa')).toBe(false)
  })
})

describe('filterRuns', () => {
  it('passes everything through on a blank query (same reference semantics)', () => {
    const runs = [run({ id: 1 }), run({ id: 2 })]
    expect(filterRuns(runs, '')).toBe(runs)
    expect(filterRuns(runs, '  ')).toBe(runs)
  })

  it('keeps only matching runs', () => {
    const runs = [
      run({ id: 1, agentId: 'codex', status: 'done' }),
      run({ id: 2, agentId: 'gemini', status: 'error' }),
      run({ id: 3, agentId: 'codex', status: 'error' })
    ]
    expect(filterRuns(runs, 'codex error').map((r) => r.id)).toEqual([3])
    expect(filterRuns(runs, 'error').map((r) => r.id)).toEqual([2, 3])
    expect(filterRuns(runs, 'codex').map((r) => r.id)).toEqual([1, 3])
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterRuns([run(), run()], 'zzz')).toEqual([])
  })
})
