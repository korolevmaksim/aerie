import { describe, expect, it } from 'vitest'
import type { PipelineDraft } from '../shared/types'
import { rowToRunSummary, toPipelineWithRuns, validateSaveRequest } from './pipelineIpc'
import type { PipelineRow, PipelineRunRow } from './store'

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

const runRow = (over: Partial<PipelineRunRow> = {}): PipelineRunRow => ({
  id: 10,
  pipeline_id: 3,
  trigger: 'commit',
  ref_type: 'commit',
  ref: 'main',
  head_sha: 'a'.repeat(40),
  status: 'done',
  action: 'notify',
  posted: 0,
  dedupe_key: 'k1',
  started_at: '2026-06-22T00:00:00Z',
  finished_at: '2026-06-22T00:05:00Z',
  ...over
})

const pipelineRow = (over: Partial<PipelineRow> = {}): PipelineRow => ({
  id: 3,
  repo_id: 7,
  name: 'CI',
  trigger: 'commit',
  enabled: 1,
  action_kind: 'notify',
  auto_post: 0,
  config: JSON.stringify(draft),
  created_at: '2026-06-22T00:00:00Z',
  updated_at: '2026-06-22T00:00:00Z',
  ...over
})

describe('validateSaveRequest', () => {
  it('accepts an insert (no id) with a valid draft', () => {
    const r = validateSaveRequest({ draft })
    expect(r).toEqual({ ok: true, value: { id: null, draft } })
  })

  it('accepts an update with a positive integer id', () => {
    const r = validateSaveRequest({ id: 5, draft })
    expect(r.ok && r.value.id).toBe(5)
  })

  it('treats null/undefined id as an insert', () => {
    expect(
      (validateSaveRequest({ id: null, draft }) as { value: { id: number | null } }).value.id
    ).toBeNull()
    expect(
      (validateSaveRequest({ id: undefined, draft }) as { value: { id: number | null } }).value.id
    ).toBeNull()
  })

  it('rejects a non-object request', () => {
    expect(validateSaveRequest(null)).toMatchObject({ ok: false })
    expect(validateSaveRequest(42)).toMatchObject({ ok: false })
  })

  it('rejects a bad id (non-integer / zero / negative / NaN)', () => {
    expect(validateSaveRequest({ id: 1.5, draft })).toMatchObject({ ok: false })
    expect(validateSaveRequest({ id: 0, draft })).toMatchObject({ ok: false })
    expect(validateSaveRequest({ id: -3, draft })).toMatchObject({ ok: false })
    expect(validateSaveRequest({ id: NaN, draft })).toMatchObject({ ok: false })
  })

  it('strips a forged __proto__ key from the saved draft (defense-in-depth)', () => {
    const draftWithProto = JSON.parse(
      `{"__proto__":{"polluted":true},${JSON.stringify(draft).slice(1)}`
    )
    const r = validateSaveRequest({ draft: draftWithProto })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Object.prototype.hasOwnProperty.call(r.value.draft, '__proto__')).toBe(false)
      expect(r.value.draft.name).toBe('CI')
    }
  })

  it('rejects a draft that fails isPipelineDraft', () => {
    expect(validateSaveRequest({ draft: { name: 'x' } })).toMatchObject({ ok: false })
    expect(validateSaveRequest({ draft: { ...draft, trigger: 'webhook' } })).toMatchObject({
      ok: false
    })
    expect(validateSaveRequest({})).toMatchObject({ ok: false }) // missing draft
  })

  it('keeps an autoPost:true draft (config only — the engine still gates the write)', () => {
    const postDraft = { ...draft, action: { kind: 'post' as const, autoPost: true } }
    const r = validateSaveRequest({ draft: postDraft })
    expect(r.ok && r.value.draft.action).toEqual({ kind: 'post', autoPost: true })
  })
})

describe('rowToRunSummary', () => {
  it('maps snake_case columns to the camelCase DTO and posted to a boolean', () => {
    expect(rowToRunSummary(runRow({ posted: 1 }))).toEqual({
      id: 10,
      pipelineId: 3,
      trigger: 'commit',
      refType: 'commit',
      ref: 'main',
      headSha: 'a'.repeat(40),
      status: 'done',
      action: 'notify',
      posted: true,
      dedupeKey: 'k1',
      startedAt: '2026-06-22T00:00:00Z',
      finishedAt: '2026-06-22T00:05:00Z'
    })
    expect(rowToRunSummary(runRow({ posted: 0 })).posted).toBe(false)
  })
})

describe('toPipelineWithRuns', () => {
  it('parses the config and attaches the run summaries', () => {
    const item = toPipelineWithRuns(pipelineRow(), [runRow()])
    expect(item).not.toBeNull()
    expect(item!.pipeline.id).toBe(3)
    expect(item!.pipeline.name).toBe('CI')
    expect(item!.runs).toHaveLength(1)
    expect(item!.runs[0].id).toBe(10)
  })

  it('returns null when the config is corrupt (skipped, not surfaced)', () => {
    expect(toPipelineWithRuns(pipelineRow({ config: '{not json' }), [])).toBeNull()
    expect(
      toPipelineWithRuns(pipelineRow({ config: JSON.stringify({ name: 'x' }) }), [])
    ).toBeNull()
  })
})
