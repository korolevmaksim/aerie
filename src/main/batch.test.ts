import { describe, expect, it } from 'vitest'
import { MAX_BATCH_AGENTS, planBatch } from './batch'

describe('planBatch', () => {
  const eligible = new Set(['codex', 'claude-code', 'gemini', 'opencode'])

  it('runs the eligible requested agents in order', () => {
    const p = planBatch(['gemini', 'codex'], eligible)
    expect(p.run).toEqual(['gemini', 'codex'])
    expect(p.skipped).toEqual([])
  })

  it('skips not-eligible (unknown / not-installed) ids', () => {
    const p = planBatch(['codex', 'ghost', 'opencode'], eligible)
    expect(p.run).toEqual(['codex', 'opencode'])
    expect(p.skipped).toEqual([{ id: 'ghost', reason: 'not-eligible' }])
  })

  it('collapses duplicates to the first occurrence (not reported as skipped)', () => {
    const p = planBatch(['codex', 'codex', 'gemini'], eligible)
    expect(p.run).toEqual(['codex', 'gemini'])
    expect(p.skipped).toEqual([])
  })

  it('caps the eligible run set and reports the rest as over-cap', () => {
    const big = new Set(Array.from({ length: 10 }, (_, i) => `a${i}`))
    const requested = Array.from({ length: 10 }, (_, i) => `a${i}`)
    const p = planBatch(requested, big, 3)
    expect(p.run).toEqual(['a0', 'a1', 'a2'])
    expect(p.skipped).toEqual([
      { id: 'a3', reason: 'over-cap' },
      { id: 'a4', reason: 'over-cap' },
      { id: 'a5', reason: 'over-cap' },
      { id: 'a6', reason: 'over-cap' },
      { id: 'a7', reason: 'over-cap' },
      { id: 'a8', reason: 'over-cap' },
      { id: 'a9', reason: 'over-cap' }
    ])
  })

  it('defaults the cap to MAX_BATCH_AGENTS', () => {
    const big = new Set(Array.from({ length: MAX_BATCH_AGENTS + 2 }, (_, i) => `a${i}`))
    const requested = Array.from({ length: MAX_BATCH_AGENTS + 2 }, (_, i) => `a${i}`)
    const p = planBatch(requested, big)
    expect(p.run).toHaveLength(MAX_BATCH_AGENTS)
    expect(p.skipped).toHaveLength(2)
  })

  it('returns empty for no request', () => {
    expect(planBatch([], eligible)).toEqual({ run: [], skipped: [] })
  })
})
