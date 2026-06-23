import { describe, expect, it } from 'vitest'
import type { PipelineDraft } from '@shared/types'
import {
  blankForm,
  draftToForm,
  formToDraft,
  isPipelineFormDirty,
  joinCsv,
  splitCsv,
  type PipelineFormState
} from './pipelineForm'

const validForm = (over: Partial<PipelineFormState> = {}): PipelineFormState => ({
  ...blankForm(),
  name: 'CI review',
  repoId: '7',
  steps: [{ id: 's1', ref: 'codex', model: '', dependsOn: '' }],
  ...over
})

describe('splitCsv / joinCsv', () => {
  it('splits, trims, and drops empties', () => {
    expect(splitCsv('a, b ,, c')).toEqual(['a', 'b', 'c'])
    expect(splitCsv('  ')).toEqual([])
  })
  it('joins with ", "', () => {
    expect(joinCsv(['a', 'b'])).toBe('a, b')
    expect(joinCsv(undefined)).toBe('')
  })
})

describe('isPipelineFormDirty', () => {
  it('detects nested edits against the original form state', () => {
    const initial = validForm()
    expect(isPipelineFormDirty({ ...initial }, initial)).toBe(false)
    expect(
      isPipelineFormDirty(
        { ...initial, steps: [{ ...initial.steps[0], ref: 'claude-code' }] },
        initial
      )
    ).toBe(true)
  })
})

describe('formToDraft — happy path', () => {
  it('builds a minimal commit/notify draft (disabled by default)', () => {
    const r = formToDraft(validForm())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.draft).toEqual({
        name: 'CI review',
        repoId: 7,
        trigger: 'commit',
        enabled: false,
        scope: {},
        steps: [{ id: 's1', kind: 'agent', ref: 'codex' }],
        action: { kind: 'notify', autoPost: false },
        guardrails: {}
      })
    }
  })

  it('maps scope CSV fields, includeDrafts=false, and maxCommits', () => {
    const r = formToDraft(
      validForm({
        branchesText: 'main, release',
        pathsText: 'src/',
        labelsText: 'review',
        authorsText: 'octocat',
        includeDrafts: false,
        maxCommitsText: '5'
      })
    )
    expect(r.ok && r.draft.scope).toEqual({
      branches: ['main', 'release'],
      paths: ['src/'],
      labels: ['review'],
      authors: ['octocat'],
      includeDrafts: false,
      maxCommits: 5
    })
  })

  it('keeps autoPost + target only for a post action', () => {
    const post = formToDraft(validForm({ actionKind: 'post', autoPost: true, postTarget: 'pr' }))
    expect(post.ok && post.draft.action).toEqual({ kind: 'post', autoPost: true, target: 'pr' })
    // autoPost is dropped for a non-post action even if the form flag is on.
    const notify = formToDraft(validForm({ actionKind: 'notify', autoPost: true }))
    expect(notify.ok && notify.draft.action).toEqual({ kind: 'notify', autoPost: false })
  })

  it('maps step model + dependsOn and guardrails', () => {
    const r = formToDraft(
      validForm({
        steps: [
          { id: 's1', ref: 'codex', model: 'o3', dependsOn: '' },
          { id: 's2', ref: 'claude', model: '', dependsOn: 's1' }
        ],
        maxConcurrentRunsText: '2',
        perRepoCooldownSecondsText: '60',
        maxRunsPerHourText: '10'
      })
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.draft.steps).toEqual([
        { id: 's1', kind: 'agent', ref: 'codex', model: 'o3' },
        { id: 's2', kind: 'agent', ref: 'claude', dependsOn: ['s1'] }
      ])
      expect(r.draft.guardrails).toEqual({
        maxConcurrentRuns: 2,
        perRepoCooldownSeconds: 60,
        maxRunsPerHour: 10
      })
    }
  })

  it('preserves enabled from base, and drops a stale schedule for a non-schedule trigger', () => {
    const base: PipelineDraft = {
      ...((formToDraft(validForm()) as { draft: PipelineDraft }).draft as PipelineDraft),
      enabled: true,
      schedule: '6h'
    }
    const r = formToDraft(validForm({ name: 'edited' }), base) // trigger stays 'commit'
    expect(r.ok && r.draft.enabled).toBe(true)
    expect(r.ok && r.draft.schedule).toBeUndefined()
  })

  it('builds the schedule string from the form for a schedule trigger', () => {
    const r = formToDraft(
      validForm({ trigger: 'schedule', scheduleEvery: '30', scheduleUnit: 'm' })
    )
    expect(r.ok && r.draft.trigger).toBe('schedule')
    expect(r.ok && r.draft.schedule).toBe('30m')
  })

  it('round-trips a schedule cadence through draftToForm → formToDraft', () => {
    const draft = (
      formToDraft(validForm({ trigger: 'schedule', scheduleEvery: '2', scheduleUnit: 'd' })) as {
        draft: PipelineDraft
      }
    ).draft
    const form = draftToForm(draft)
    expect(form.scheduleEvery).toBe('2')
    expect(form.scheduleUnit).toBe('d')
    expect((formToDraft(form) as { draft: PipelineDraft }).draft.schedule).toBe('2d')
  })
})

describe('formToDraft — schedule validation', () => {
  it('rejects a non-positive or non-numeric schedule interval', () => {
    expect(
      formToDraft(validForm({ trigger: 'schedule', scheduleEvery: '0', scheduleUnit: 'h' }))
    ).toMatchObject({ ok: false })
    expect(
      formToDraft(validForm({ trigger: 'schedule', scheduleEvery: 'abc', scheduleUnit: 'h' }))
    ).toMatchObject({ ok: false })
  })
})

describe('formToDraft — validation', () => {
  it('rejects an empty name / unselected repo / no steps', () => {
    expect(formToDraft(validForm({ name: '  ' }))).toMatchObject({ ok: false })
    expect(formToDraft(validForm({ repoId: '' }))).toMatchObject({ ok: false })
    expect(formToDraft(validForm({ repoId: '0' }))).toMatchObject({ ok: false })
    expect(formToDraft(validForm({ steps: [] }))).toMatchObject({ ok: false })
  })

  it('rejects a step with no agent, a duplicate id, a self-dep, or an unknown dep', () => {
    expect(
      formToDraft(validForm({ steps: [{ id: 's1', ref: '  ', model: '', dependsOn: '' }] }))
    ).toMatchObject({ ok: false })
    expect(
      formToDraft(
        validForm({
          steps: [
            { id: 's1', ref: 'a', model: '', dependsOn: '' },
            { id: 's1', ref: 'b', model: '', dependsOn: '' }
          ]
        })
      )
    ).toMatchObject({ ok: false })
    expect(
      formToDraft(validForm({ steps: [{ id: 's1', ref: 'a', model: '', dependsOn: 's1' }] }))
    ).toMatchObject({ ok: false })
    expect(
      formToDraft(validForm({ steps: [{ id: 's1', ref: 'a', model: '', dependsOn: 'ghost' }] }))
    ).toMatchObject({ ok: false })
  })

  it('rejects non-numeric maxCommits / guardrails', () => {
    expect(formToDraft(validForm({ maxCommitsText: 'lots' }))).toMatchObject({ ok: false })
    expect(formToDraft(validForm({ maxConcurrentRunsText: '-1' }))).toMatchObject({ ok: false })
    expect(formToDraft(validForm({ maxRunsPerHourText: '1.5' }))).toMatchObject({ ok: false })
  })
})

describe('draftToForm', () => {
  it('round-trips a draft through the form and back', () => {
    const original = formToDraft(
      validForm({
        branchesText: 'main',
        includeDrafts: false,
        maxCommitsText: '3',
        actionKind: 'post',
        autoPost: true,
        postTarget: 'issue',
        steps: [{ id: 's1', ref: 'codex', model: 'o3', dependsOn: '' }],
        perRepoCooldownSecondsText: '30'
      })
    )
    expect(original.ok).toBe(true)
    if (original.ok) {
      const back = formToDraft(draftToForm(original.draft), original.draft)
      expect(back.ok && back.draft).toEqual(original.draft)
    }
  })

  it('defaults an empty-steps draft to one blank step', () => {
    const form = draftToForm({ ...blankDraft(), steps: [] })
    expect(form.steps).toHaveLength(1)
    expect(form.steps[0].id).toBe('s1')
  })

  it('round-trips an explicit includeDrafts:true to the equivalent minimal scope (omitted)', () => {
    const d: PipelineDraft = { ...blankDraft(), scope: { includeDrafts: true } }
    const back = formToDraft(draftToForm(d), d)
    // Semantically identical (absent === true), stored minimally (no includeDrafts key).
    expect(back.ok && back.draft.scope).toEqual({})
  })
})

function blankDraft(): PipelineDraft {
  return {
    name: 'x',
    repoId: 1,
    trigger: 'commit',
    enabled: false,
    scope: {},
    steps: [{ id: 's1', kind: 'agent', ref: 'codex' }],
    action: { kind: 'notify', autoPost: false },
    guardrails: {}
  }
}
