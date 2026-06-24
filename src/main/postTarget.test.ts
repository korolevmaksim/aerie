import { describe, expect, it } from 'vitest'
import { resolveRunPostTarget } from './postTarget'
import type { RunRow } from './store'

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 1,
  repo_id: 7,
  ref_type: 'commit',
  ref_id: 'abc1234',
  head_sha: 'a'.repeat(40),
  agent_id: 'codex',
  status: 'done',
  exit_code: 0,
  started_at: '2026-06-24T00:00:00Z',
  finished_at: '2026-06-24T00:01:00Z',
  output_path: '/tmp/run.out',
  posted_url: null,
  local_status: 'open',
  local_status_at: null,
  author_login: null,
  ...over
})

describe('resolveRunPostTarget', () => {
  it('derives a commit-comment SHA from the stored run, not renderer input', () => {
    const result = resolveRunPostTarget(run({ head_sha: 'deadbeef' }), {
      kind: 'commitComment'
    })
    expect(result).toEqual({ ok: true, target: { kind: 'commitComment', sha: 'deadbeef' } })
  })

  it('refuses to post a commit comment for a PR run', () => {
    const result = resolveRunPostTarget(run({ ref_type: 'pr', ref_id: '42' }), {
      kind: 'commitComment'
    })
    expect(result).toEqual({
      ok: false,
      error: 'Commit comments can only be posted for commit runs.'
    })
  })

  it('derives a PR number from the stored run ref_id', () => {
    const result = resolveRunPostTarget(run({ ref_type: 'pr', ref_id: '42' }), {
      kind: 'prComment'
    })
    expect(result).toEqual({ ok: true, target: { kind: 'prComment', prNumber: 42 } })
  })

  it('refuses non-successful runs for any GitHub post kind', () => {
    const result = resolveRunPostTarget(run({ status: 'error' }), {
      kind: 'issue',
      title: 'Aerie review'
    })
    expect(result).toEqual({ ok: false, error: 'Only successful finished runs can be posted.' })
  })

  it('allows successful runs to create issues with an explicit title', () => {
    const result = resolveRunPostTarget(run({ ref_type: 'project', ref_id: 'main' }), {
      kind: 'issue',
      title: '  Aerie project audit  '
    })
    expect(result).toEqual({
      ok: true,
      target: { kind: 'issue', title: 'Aerie project audit' }
    })
  })
})
