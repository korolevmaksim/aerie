import { describe, expect, it } from 'vitest'
import type { PipelineAction, PipelineDraft, PipelineStep } from '../shared/types'
import {
  assertMayPost,
  dedupeKey,
  effectiveAction,
  isPipelineDraft,
  matchesScope,
  mayAutoPost,
  pipelineConfigHash,
  type DedupeParts
} from './pipelineModel'

const action = (over: Partial<PipelineAction> = {}): PipelineAction => ({
  kind: 'notify',
  autoPost: false,
  ...over
})

const draft = (over: Partial<PipelineDraft> = {}): PipelineDraft => ({
  name: 'CI review',
  repoId: 1,
  trigger: 'pr',
  enabled: true,
  scope: {},
  steps: [{ id: 's1', kind: 'agent', ref: 'codex' }],
  action: action(),
  guardrails: {},
  ...over
})

describe('isPipelineDraft', () => {
  it('accepts a well-formed draft', () => {
    expect(isPipelineDraft(draft())).toBe(true)
  })

  it('accepts an empty-steps no-op pipeline and all triggers/actions', () => {
    expect(isPipelineDraft(draft({ steps: [] }))).toBe(true)
    for (const trigger of ['commit', 'pr', 'schedule', 'manual'] as const) {
      expect(isPipelineDraft(draft({ trigger }))).toBe(true)
    }
    for (const kind of ['notify', 'stage', 'post'] as const) {
      expect(isPipelineDraft(draft({ action: action({ kind }) }))).toBe(true)
    }
    for (const reviewTarget of ['commit', 'project'] as const) {
      expect(isPipelineDraft(draft({ reviewTarget }))).toBe(true)
    }
  })

  it('rejects non-objects and missing/empty required fields', () => {
    expect(isPipelineDraft(null)).toBe(false)
    expect(isPipelineDraft([])).toBe(false)
    expect(isPipelineDraft(draft({ name: '' }))).toBe(false)
    expect(isPipelineDraft({ ...draft(), repoId: 1.5 })).toBe(false)
    expect(isPipelineDraft({ ...draft(), trigger: 'webhook' })).toBe(false)
    expect(isPipelineDraft({ ...draft(), reviewTarget: 'workspace' })).toBe(false)
    expect(isPipelineDraft({ ...draft(), enabled: 'yes' })).toBe(false)
  })

  it('rejects a malformed step, scope, action, or guardrails', () => {
    expect(
      isPipelineDraft(draft({ steps: [{ id: '', kind: 'agent', ref: 'x' } as PipelineStep] }))
    ).toBe(false)
    expect(isPipelineDraft(draft({ steps: [{ id: 's', kind: 'bad', ref: 'x' } as never] }))).toBe(
      false
    )
    expect(
      isPipelineDraft(draft({ steps: [{ id: 's', kind: 'agent', ref: '' } as PipelineStep] }))
    ).toBe(false)
    expect(isPipelineDraft({ ...draft(), scope: { branches: [1] } })).toBe(false)
    expect(isPipelineDraft({ ...draft(), action: { kind: 'post' } })).toBe(false) // missing autoPost
    expect(isPipelineDraft({ ...draft(), action: action({ target: 'wiki' as never }) })).toBe(false)
    expect(isPipelineDraft({ ...draft(), guardrails: { maxRunsPerHour: 'lots' } })).toBe(false)
  })
})

describe('auto-post safety gate', () => {
  it('mayAutoPost is true ONLY for an enabled post action', () => {
    expect(mayAutoPost(action({ kind: 'post', autoPost: true }))).toBe(true)
    expect(mayAutoPost(action({ kind: 'post', autoPost: false }))).toBe(false)
    expect(mayAutoPost(action({ kind: 'notify', autoPost: true }))).toBe(false)
    expect(mayAutoPost(action({ kind: 'stage', autoPost: true }))).toBe(false)
  })

  it('assertMayPost throws for every non-enabled-post action and passes only the enabled post', () => {
    expect(() => assertMayPost(action({ kind: 'post', autoPost: true }))).not.toThrow()
    expect(() => assertMayPost(action({ kind: 'post', autoPost: false }))).toThrow(
      /refusing to auto-post/
    )
    expect(() => assertMayPost(action({ kind: 'notify', autoPost: true }))).toThrow(
      /refusing to auto-post/
    )
    expect(() => assertMayPost(action({ kind: 'stage', autoPost: false }))).toThrow()
  })

  it('effectiveAction degrades a disabled post to stage and passes others through', () => {
    expect(effectiveAction(action({ kind: 'post', autoPost: true }))).toBe('post')
    expect(effectiveAction(action({ kind: 'post', autoPost: false }))).toBe('stage')
    expect(effectiveAction(action({ kind: 'notify', autoPost: false }))).toBe('notify')
    expect(effectiveAction(action({ kind: 'stage', autoPost: true }))).toBe('stage')
  })
})

describe('matchesScope', () => {
  it('an empty scope matches anything', () => {
    expect(matchesScope({}, {})).toBe(true)
    expect(matchesScope({}, { branch: 'main', isDraft: true, commitCount: 999 })).toBe(true)
  })

  it('filters by branch (exact, any-of)', () => {
    expect(matchesScope({ branches: ['main', 'release'] }, { branch: 'main' })).toBe(true)
    expect(matchesScope({ branches: ['main'] }, { branch: 'feature/x' })).toBe(false)
    expect(matchesScope({ branches: ['main'] }, {})).toBe(false) // no branch in ctx
  })

  it('filters by labels (any-of) and authors (any-of)', () => {
    expect(matchesScope({ labels: ['review'] }, { labels: ['review', 'wip'] })).toBe(true)
    expect(matchesScope({ labels: ['review'] }, { labels: ['wip'] })).toBe(false)
    expect(matchesScope({ labels: ['review'] }, {})).toBe(false)
    expect(matchesScope({ authors: ['octocat'] }, { author: 'octocat' })).toBe(true)
    expect(matchesScope({ authors: ['octocat'] }, { author: 'hubot' })).toBe(false)
    expect(matchesScope({ authors: ['octocat'] }, { author: null })).toBe(false)
  })

  it('filters by path prefix (dir and exact-file)', () => {
    expect(matchesScope({ paths: ['src/'] }, { paths: ['src/main/x.ts'] })).toBe(true)
    expect(matchesScope({ paths: ['src'] }, { paths: ['src/main/x.ts'] })).toBe(true)
    expect(matchesScope({ paths: ['src'] }, { paths: ['srcabc/x.ts'] })).toBe(false) // no false prefix
    expect(matchesScope({ paths: ['README.md'] }, { paths: ['README.md'] })).toBe(true)
    expect(matchesScope({ paths: ['docs/'] }, { paths: ['src/x.ts'] })).toBe(false)
  })

  it('excludes drafts only when includeDrafts is explicitly false, and caps push size', () => {
    expect(matchesScope({}, { isDraft: true })).toBe(true) // absent = wildcard
    expect(matchesScope({ includeDrafts: true }, { isDraft: true })).toBe(true)
    expect(matchesScope({ includeDrafts: false }, { isDraft: true })).toBe(false)
    expect(matchesScope({ includeDrafts: false }, { isDraft: false })).toBe(true)
    expect(matchesScope({ maxCommits: 5 }, { commitCount: 5 })).toBe(true)
    expect(matchesScope({ maxCommits: 5 }, { commitCount: 6 })).toBe(false)
    expect(matchesScope({ maxCommits: 0 }, { commitCount: 999 })).toBe(true) // 0 = no cap
  })

  it('requires ALL present predicates to pass', () => {
    const scope = { branches: ['main'], paths: ['src/'] }
    expect(matchesScope(scope, { branch: 'main', paths: ['src/a.ts'] })).toBe(true)
    expect(matchesScope(scope, { branch: 'main', paths: ['docs/a.md'] })).toBe(false)
    expect(matchesScope(scope, { branch: 'dev', paths: ['src/a.ts'] })).toBe(false)
  })
})

describe('dedupe key + config hash', () => {
  const base: DedupeParts = {
    repoId: 1,
    refType: 'commit',
    ref: 'main',
    baseSha: null,
    headSha: 'abc',
    catalogVersion: 'v1',
    promptHash: 'p1',
    configHash: 'c1'
  }

  it('is stable for identical inputs and differs when any part changes', () => {
    expect(dedupeKey(base)).toBe(dedupeKey({ ...base }))
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, headSha: 'def' }))
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, catalogVersion: 'v2' }))
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, promptHash: 'p2' }))
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, configHash: 'c2' }))
    expect(dedupeKey(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not collide when a field boundary could shift (delimiter-safe)', () => {
    // ref="a"/baseSha="b c" vs ref="a b"/baseSha="c" must stay distinct keys.
    const a = dedupeKey({ ...base, ref: 'a', baseSha: 'b c' })
    const b = dedupeKey({ ...base, ref: 'a b', baseSha: 'c' })
    expect(a).not.toBe(b)
  })

  it('config hash ignores order of dependsOn and is invariant to scope/name', () => {
    const a: PipelineStep[] = [
      { id: 's2', kind: 'agent', ref: 'codex', dependsOn: ['a', 'b'] },
      { id: 's1', kind: 'tool', ref: 'eslint' }
    ]
    const b: PipelineStep[] = [
      { id: 's2', kind: 'agent', ref: 'codex', dependsOn: ['b', 'a'] },
      { id: 's1', kind: 'tool', ref: 'eslint' }
    ]
    expect(pipelineConfigHash(a, 'notify')).toBe(pipelineConfigHash(b, 'notify'))
    expect(pipelineConfigHash(a, 'notify')).not.toBe(pipelineConfigHash(a, 'post'))
    expect(pipelineConfigHash(a, 'notify', 'commit')).not.toBe(
      pipelineConfigHash(a, 'notify', 'project')
    )
    expect(pipelineConfigHash(a, 'notify')).not.toBe(
      pipelineConfigHash([{ id: 's1', kind: 'agent', ref: 'codex', model: 'o3' }], 'notify')
    )
  })
})
