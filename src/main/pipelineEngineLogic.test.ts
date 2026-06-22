import { describe, expect, it } from 'vitest'
import type { PipelineDraft } from '../shared/types'
import {
  assembleGuardrailState,
  parsePipelineRow,
  prNumberFromRef,
  splitIssueBody
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
