import { describe, expect, it } from 'vitest'
import { aggregateFindings } from './aggregate'
import type { Finding, Severity } from './findings'

function f(over: { tool: string; fingerprint: string } & Partial<Finding>): Finding {
  return {
    tool: over.tool,
    ruleId: over.ruleId ?? null,
    severity: over.severity ?? 'medium',
    file: over.file ?? 'a.ts',
    line: over.line ?? 1,
    message: over.message ?? 'msg',
    fingerprint: over.fingerprint
  }
}

describe('aggregateFindings', () => {
  it('drops exact duplicates (same source, same fingerprint)', () => {
    const r = aggregateFindings([
      f({ tool: 'eslint', fingerprint: 'x' }),
      f({ tool: 'eslint', fingerprint: 'x' })
    ])
    expect(r.kept).toHaveLength(1)
    expect(r.deduped).toBe(1)
    expect(r.total).toBe(2)
    expect(r.filtered).toBe(1)
  })

  it('collapses the same issue across tools into one representative (highest severity)', () => {
    const r = aggregateFindings([
      f({
        tool: 'eslint',
        fingerprint: 'a',
        severity: 'low',
        message: 'unused import',
        file: 'x.ts',
        line: 1
      }),
      f({
        tool: 'biome',
        fingerprint: 'b',
        severity: 'medium',
        message: 'unused import',
        file: 'x.ts',
        line: 1
      })
    ])
    expect(r.kept).toHaveLength(1)
    expect(r.kept[0].severity).toBe('medium')
    expect(r.filtered).toBe(1)
  })

  it('requires >= consensusMin distinct sources when set', () => {
    const lone = f({ tool: 'eslint', fingerprint: 'a', file: 'x.ts', line: 1, message: 'm1' })
    const c1 = f({ tool: 'eslint', fingerprint: 'b', file: 'y.ts', line: 2, message: 'm2' })
    const c2 = f({ tool: 'biome', fingerprint: 'c', file: 'y.ts', line: 2, message: 'm2' })
    const r = aggregateFindings([lone, c1, c2], { consensusMin: 2 })
    expect(r.kept).toHaveLength(1)
    expect(r.kept[0].file).toBe('y.ts')
    expect(r.belowConsensus).toBe(1)
  })

  it('counts DISTINCT sources — the same tool reporting one issue twice is not consensus', () => {
    // Same tool, same issue (file+line+message), different rule ids → 2 findings,
    // 1 distinct source. With consensusMin 2 this must NOT survive.
    const r = aggregateFindings(
      [
        f({
          tool: 'eslint',
          fingerprint: 'a',
          ruleId: 'no-foo',
          file: 'x.ts',
          line: 1,
          message: 'm'
        }),
        f({
          tool: 'eslint',
          fingerprint: 'b',
          ruleId: 'no-bar',
          file: 'x.ts',
          line: 1,
          message: 'm'
        })
      ],
      { consensusMin: 2 }
    )
    expect(r.kept).toHaveLength(0)
    expect(r.belowConsensus).toBe(2)
  })

  it('collapses same location+message across different rules into one (intentional)', () => {
    // Different ruleIds → different fingerprints (not exact dups), but same issueKey
    // (file+line+message) → one representative even under defaults. Pins the lossy contract.
    const r = aggregateFindings([
      f({ tool: 't', fingerprint: 'a', ruleId: 'no-foo', file: 'x.ts', line: 1, message: 'same' }),
      f({ tool: 't', fingerprint: 'b', ruleId: 'no-bar', file: 'x.ts', line: 1, message: 'same' })
    ])
    expect(r.kept).toHaveLength(1)
    expect(r.deduped).toBe(0) // not exact dups
  })

  it('clamps a non-positive consensusMin to 1 (keep, do not drop everything)', () => {
    const r = aggregateFindings([f({ tool: 't', fingerprint: 'a' })], { consensusMin: 0 })
    expect(r.kept).toHaveLength(1)
    expect(r.belowConsensus).toBe(0)
  })

  it('drops findings below the minSeverity floor', () => {
    const r = aggregateFindings(
      [
        f({
          tool: 't',
          fingerprint: 'a',
          severity: 'info',
          file: 'x.ts',
          line: 1,
          message: 'hint'
        }),
        f({ tool: 't', fingerprint: 'b', severity: 'high', file: 'y.ts', line: 2, message: 'bad' })
      ],
      { minSeverity: 'medium' }
    )
    expect(r.kept).toHaveLength(1)
    expect(r.kept[0].severity).toBe('high')
    expect(r.belowSeverity).toBe(1)
  })

  it('orders kept most-severe first and tallies bySeverity', () => {
    const r = aggregateFindings([
      f({ tool: 't', fingerprint: 'a', severity: 'low', file: 'x.ts', line: 1, message: 'a' }),
      f({ tool: 't', fingerprint: 'b', severity: 'critical', file: 'y.ts', line: 2, message: 'b' })
    ])
    expect(r.kept.map((k) => k.severity as Severity)).toEqual(['critical', 'low'])
    expect(r.bySeverity).toMatchObject({ critical: 1, low: 1, high: 0 })
  })

  it('is a no-op-shaped result for no findings', () => {
    expect(aggregateFindings([])).toMatchObject({ kept: [], total: 0, filtered: 0, deduped: 0 })
  })

  it('default options (consensusMin 1, keep-all severity) only dedup/collapse', () => {
    const r = aggregateFindings([
      f({ tool: 't', fingerprint: 'a', severity: 'info', file: 'x.ts', line: 1, message: 'm' })
    ])
    expect(r.kept).toHaveLength(1) // info kept by default
    expect(r.belowConsensus).toBe(0)
    expect(r.belowSeverity).toBe(0)
  })
})
