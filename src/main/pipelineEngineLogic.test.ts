import { describe, expect, it } from 'vitest'
import type { PipelineAction, PipelineDraft } from '../shared/types'
import {
  assembleGuardrailState,
  dispatchGithubWrite,
  parsePipelineRow,
  prNumberFromRef,
  splitIssueBody,
  type GithubWriters,
  type WriteContext
} from './pipelineEngineLogic'

const draft: PipelineDraft = {
  name: 'CI',
  repoId: 7,
  trigger: 'commit',
  enabled: true,
  scope: {},
  steps: [{ id: 's1', kind: 'agent', ref: 'codex' }],
  action: { kind: 'notify', autoPost: false },
  guardrails: {}
}

describe('parsePipelineRow', () => {
  it('parses a valid config blob and overlays the row id', () => {
    const p = parsePipelineRow({ id: 42, config: JSON.stringify(draft) })
    expect(p).not.toBeNull()
    expect(p!.id).toBe(42)
    expect(p!.name).toBe('CI')
    expect(p!.steps[0].ref).toBe('codex')
  })

  it('returns null on malformed JSON', () => {
    expect(parsePipelineRow({ id: 1, config: '{not json' })).toBeNull()
  })

  it('returns null on JSON that fails isPipelineDraft', () => {
    expect(parsePipelineRow({ id: 1, config: JSON.stringify({ name: 'x' }) })).toBeNull()
    expect(
      parsePipelineRow({ id: 1, config: JSON.stringify({ ...draft, trigger: 'webhook' }) })
    ).toBeNull()
  })

  it('the row id overrides any id the config carries', () => {
    const p = parsePipelineRow({ id: 99, config: JSON.stringify({ ...draft, id: 7 }) })
    expect(p!.id).toBe(99)
  })

  it('strips a forged __proto__ own-key (no prototype pollution)', () => {
    // Hand-craft a config whose top-level object has an own __proto__ key.
    const malicious = `{"__proto__":{"polluted":true},${JSON.stringify(draft).slice(1)}`
    const p = parsePipelineRow({ id: 1, config: malicious })
    expect(p).not.toBeNull()
    expect(Object.prototype.hasOwnProperty.call(p, '__proto__')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(p!.name).toBe('CI')
  })
})

describe('prNumberFromRef', () => {
  it('extracts a positive PR number', () => {
    expect(prNumberFromRef('pr:42')).toBe(42)
    expect(prNumberFromRef('pr:1')).toBe(1)
  })

  it('rejects non-pr or malformed refs', () => {
    expect(prNumberFromRef('main')).toBeNull()
    expect(prNumberFromRef('pr:')).toBeNull()
    expect(prNumberFromRef('pr:0')).toBeNull()
    expect(prNumberFromRef('pr:-3')).toBeNull()
    expect(prNumberFromRef('pr:abc')).toBeNull()
    expect(prNumberFromRef('pr:1.5')).toBeNull()
  })
})

describe('splitIssueBody', () => {
  it('uses the first line as the title, full text as the body', () => {
    const r = splitIssueBody('Findings summary\n- a\n- b')
    expect(r.title).toBe('Findings summary')
    expect(r.body).toBe('Findings summary\n- a\n- b')
  })

  it('truncates a long title to 120 chars', () => {
    const long = 'x'.repeat(200)
    const r = splitIssueBody(long)
    expect(r.title).toHaveLength(120)
    expect(r.title.endsWith('...')).toBe(true)
    expect(r.body).toBe(long)
  })

  it('falls back to a generic title when the first line is blank', () => {
    expect(splitIssueBody('\nbody').title).toBe('Aerie pipeline review')
  })
})

describe('assembleGuardrailState', () => {
  it('converts ISO timestamps to ms and drops unparseable ones', () => {
    const s = assembleGuardrailState(
      1000,
      2,
      ['2026-06-22T00:00:00Z', 'not-a-date', '2026-06-22T01:00:00Z'],
      '2026-06-22T00:30:00Z'
    )
    expect(s.nowMs).toBe(1000)
    expect(s.activeRunCount).toBe(2)
    expect(s.pipelineRunStartsLastHourMs).toEqual([
      Date.parse('2026-06-22T00:00:00Z'),
      Date.parse('2026-06-22T01:00:00Z')
    ])
    expect(s.lastRepoRunStartedAtMs).toBe(Date.parse('2026-06-22T00:30:00Z'))
  })

  it('handles a null/unparseable last-repo-start', () => {
    expect(assembleGuardrailState(0, 0, [], null).lastRepoRunStartedAtMs).toBeNull()
    expect(assembleGuardrailState(0, 0, [], 'nope').lastRepoRunStartedAtMs).toBeNull()
  })
})

describe('dispatchGithubWrite — the single gated write dispatch', () => {
  interface Calls {
    commit: unknown[][]
    pr: unknown[][]
    issue: unknown[][]
  }
  const fakeWriters = (calls: Calls): GithubWriters => ({
    createCommitComment: async (...args) => {
      calls.commit.push(args)
      return 'url:commit'
    },
    createPrComment: async (...args) => {
      calls.pr.push(args)
      return 'url:pr'
    },
    createIssue: async (...args) => {
      calls.issue.push(args)
      return 'url:issue'
    }
  })
  const action = (over: Partial<PipelineAction> = {}): PipelineAction => ({
    kind: 'post',
    autoPost: true,
    ...over
  })
  const ctx: WriteContext = { accountId: 3, ref: 'pr:42', headSha: 'abc123' }

  it('refuses (throws) and writes NOTHING for a non-enabled-post action', async () => {
    for (const a of [
      action({ kind: 'notify' }),
      action({ kind: 'stage' }),
      action({ kind: 'post', autoPost: false })
    ]) {
      const calls: Calls = { commit: [], pr: [], issue: [] }
      await expect(
        dispatchGithubWrite(fakeWriters(calls), 'o/r', a, 'commit', ctx, 'b')
      ).rejects.toThrow(/refusing to auto-post/)
      expect(calls.commit.length + calls.pr.length + calls.issue.length).toBe(0)
    }
  })

  it('routes an enabled commit post to createCommitComment exactly once', async () => {
    const calls: Calls = { commit: [], pr: [], issue: [] }
    const url = await dispatchGithubWrite(
      fakeWriters(calls),
      'o/r',
      action(),
      'commit',
      ctx,
      'body'
    )
    expect(url).toBe('url:commit')
    expect(calls.commit).toEqual([[3, 'o/r', 'abc123', 'body']])
    expect(calls.pr).toHaveLength(0)
    expect(calls.issue).toHaveLength(0)
  })

  it('routes an enabled pr post to createPrComment with the parsed PR number', async () => {
    const calls: Calls = { commit: [], pr: [], issue: [] }
    await dispatchGithubWrite(fakeWriters(calls), 'o/r', action(), 'pr', ctx, 'body')
    expect(calls.pr).toEqual([[3, 'o/r', 42, 'body']])
  })

  it('routes an enabled issue post to createIssue with a split title/body', async () => {
    const calls: Calls = { commit: [], pr: [], issue: [] }
    await dispatchGithubWrite(fakeWriters(calls), 'o/r', action(), 'issue', ctx, 'Title line\nrest')
    expect(calls.issue).toEqual([[3, 'o/r', 'Title line', 'Title line\nrest']])
  })

  it('throws when the repo is unknown (null full name) and writes nothing', async () => {
    const calls: Calls = { commit: [], pr: [], issue: [] }
    await expect(
      dispatchGithubWrite(fakeWriters(calls), null, action(), 'commit', ctx, 'b')
    ).rejects.toThrow(/repository not found/)
    expect(calls.commit).toHaveLength(0)
  })

  it('throws on a pr target whose ref has no PR number', async () => {
    const calls: Calls = { commit: [], pr: [], issue: [] }
    await expect(
      dispatchGithubWrite(fakeWriters(calls), 'o/r', action(), 'pr', { ...ctx, ref: 'main' }, 'b')
    ).rejects.toThrow(/cannot resolve a PR number/)
    expect(calls.pr).toHaveLength(0)
  })
})
