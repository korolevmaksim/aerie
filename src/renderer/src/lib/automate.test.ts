import { describe, expect, it } from 'vitest'
import type { PipelineRunChange, PipelineWithRuns } from '@shared/types'
import {
  applyLiveChange,
  describeOutcome,
  displayRunStatus,
  statusLabel,
  statusTone
} from './automate'

const item = (
  over: Partial<PipelineWithRuns['runs']> | { runs?: PipelineWithRuns['runs'] } = {}
): PipelineWithRuns => ({
  pipeline: {
    id: 1,
    name: 'CI',
    repoId: 7,
    trigger: 'commit',
    enabled: true,
    scope: {},
    steps: [{ id: 's1', kind: 'agent', ref: 'codex' }],
    action: { kind: 'notify', autoPost: false },
    guardrails: {}
  },
  repoFullName: 'o/r',
  runs: (over as { runs?: PipelineWithRuns['runs'] }).runs ?? []
})

const run = (
  over: Partial<PipelineWithRuns['runs'][number]> = {}
): PipelineWithRuns['runs'][number] => ({
  id: 10,
  pipelineId: 1,
  trigger: 'commit',
  refType: 'commit',
  ref: 'main',
  headSha: 'a'.repeat(40),
  status: 'done',
  action: 'notify',
  posted: false,
  dedupeKey: 'k',
  startedAt: '2026-06-22T00:00:00Z',
  finishedAt: '2026-06-22T00:05:00Z',
  ...over
})

const change = (over: Partial<PipelineRunChange> = {}): PipelineRunChange => ({
  pipelineId: 1,
  pipelineRunId: 11,
  status: 'running',
  action: 'notify',
  posted: false,
  ...over
})

describe('displayRunStatus', () => {
  it("is 'never' with no runs and no live", () => {
    expect(displayRunStatus(item(), undefined)).toEqual({ status: 'never', posted: false })
  })

  it('uses the newest listed run when there is no live change', () => {
    expect(
      displayRunStatus(item({ runs: [run({ status: 'done', posted: true })] }), undefined)
    ).toEqual({
      status: 'done',
      posted: true
    })
  })

  it('prefers a matching live change over the listed run', () => {
    const live = change({ status: 'running' })
    expect(displayRunStatus(item({ runs: [run({ status: 'done' })] }), live)).toEqual({
      status: 'running',
      posted: false
    })
  })

  it('ignores a live change for a different pipeline', () => {
    const live = change({ pipelineId: 999, status: 'error' })
    expect(displayRunStatus(item({ runs: [run({ status: 'done' })] }), live).status).toBe('done')
  })
})

describe('statusLabel / statusTone', () => {
  it('labels each status', () => {
    expect(statusLabel('never')).toBe('Never run')
    expect(statusLabel('running')).toBe('Running…')
    expect(statusLabel('done')).toBe('Done')
    expect(statusLabel('error')).toBe('Error')
  })

  it('maps a tone (never color-only)', () => {
    expect(statusTone('done')).toBe('ok')
    expect(statusTone('running')).toBe('warn')
    expect(statusTone('pending')).toBe('warn')
    expect(statusTone('error')).toBe('bad')
    expect(statusTone('never')).toBe('muted')
    expect(statusTone('skipped')).toBe('muted')
  })
})

describe('describeOutcome', () => {
  it('summarizes a successful run (and notes a real post)', () => {
    expect(
      describeOutcome(
        { ran: true, pipelineRunId: 1, action: 'notify', posted: false, findings: 3 },
        false
      )
    ).toBe('Run done — notify, 3 findings.')
    expect(
      describeOutcome(
        { ran: true, pipelineRunId: 1, action: 'post', posted: true, findings: 1 },
        false
      )
    ).toBe('Run done — post, 1 finding, posted to GitHub.')
  })

  it('labels a dry run and a skip reason', () => {
    expect(
      describeOutcome(
        { ran: true, pipelineRunId: 1, action: 'stage', posted: false, findings: 0 },
        true
      )
    ).toBe('Dry run done — stage, 0 findings.')
    expect(describeOutcome({ ran: false, reason: 'dedupe' }, false)).toBe(
      'Run skipped — already run for this head.'
    )
  })
})

describe('applyLiveChange', () => {
  it('adds/overwrites the map entry by pipelineId (newest wins) without mutating', () => {
    const a = change({ pipelineId: 1, status: 'pending' })
    const m1 = applyLiveChange({}, a)
    expect(m1[1].status).toBe('pending')
    const b = change({ pipelineId: 1, status: 'done' })
    const m2 = applyLiveChange(m1, b)
    expect(m2[1].status).toBe('done')
    expect(m1[1].status).toBe('pending') // m1 untouched
  })
})
