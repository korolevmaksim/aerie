import { describe, expect, it } from 'vitest'
import type { RunHistoryItem } from '@shared/types'
import { runsToJson, runsToMarkdown, toExportRun } from './runExport'

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
  outputPath: '/Users/secret/Library/Application Support/aerie/runs/1.log',
  postedUrl: 'https://github.com/octocat/hello-world/commit/abc#comment',
  authorLogin: 'monalisa',
  ...over
})

describe('toExportRun', () => {
  it('projects the safe subset and EXCLUDES local path + internal ids', () => {
    const e = toExportRun(run())
    expect(e).toEqual({
      repo: 'octocat/hello-world',
      agent: 'codex',
      ref: 'main',
      sha: 'abcdef1234567890',
      status: 'done',
      exitCode: 0,
      startedAt: '2026-06-23T00:00:00Z',
      finishedAt: '2026-06-23T00:05:00Z',
      author: 'monalisa',
      postedUrl: 'https://github.com/octocat/hello-world/commit/abc#comment'
    })
    // The internal/local fields must never appear in the projection.
    expect(e).not.toHaveProperty('outputPath')
    expect(e).not.toHaveProperty('id')
    expect(e).not.toHaveProperty('repoId')
    expect(e).not.toHaveProperty('accountId')
  })

  it('formats a PR ref', () => {
    expect(toExportRun(run({ refType: 'pr', refId: '42' })).ref).toBe('PR #42')
  })
})

describe('runsToJson', () => {
  it('emits a parseable array of the safe subset; empty → []', () => {
    expect(runsToJson([])).toBe('[]')
    const parsed = JSON.parse(runsToJson([run(), run({ id: 2 })]))
    expect(parsed).toHaveLength(2)
    expect(parsed[0].repo).toBe('octocat/hello-world')
  })

  it('NEVER leaks the local outputPath into the JSON', () => {
    const json = runsToJson([run()])
    expect(json).not.toContain('outputPath')
    expect(json).not.toContain('/Users/secret')
    expect(json).not.toContain('Application Support')
  })
})

describe('runsToMarkdown', () => {
  it('renders a header + separator + one row per run', () => {
    const md = runsToMarkdown([run()])
    const lines = md.split('\n')
    expect(lines[0]).toContain('| Repo | Agent | Ref |')
    expect(lines[1]).toMatch(/^\| --- \| --- \|/)
    expect(lines[2]).toContain('octocat/hello-world')
    expect(lines[2]).toContain('codex')
    expect(lines[2]).toContain('abcdef12') // sha sliced to 8
  })

  it('empty list → a friendly placeholder', () => {
    expect(runsToMarkdown([])).toBe('_No runs._')
  })

  it('escapes a pipe and newline in a cell so the table is not broken', () => {
    const md = runsToMarkdown([run({ repoFullName: 'o/we|ird', agentId: 'a\nb' })])
    const dataRow = md.split('\n')[2]
    expect(dataRow).toContain('we\\|ird') // pipe escaped
    expect(dataRow).not.toContain('a\nb') // newline collapsed
    expect(dataRow).toContain('a b')
  })

  it('NEVER leaks the local outputPath into the Markdown', () => {
    const md = runsToMarkdown([run()])
    expect(md).not.toContain('/Users/secret')
    expect(md).not.toContain('Application Support')
  })
})
