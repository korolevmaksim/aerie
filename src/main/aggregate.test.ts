import { describe, expect, it } from 'vitest'
import { aggregateFindings } from './aggregate'
import type { Finding, Severity } from './findings'

function f(over: { tool: string; fingerprint: string } & Partial<Finding>): Finding {
  return {
    tool: over.tool,
    ruleId: over.ruleId ?? null,
    severity: over.severity ?? 'medium',
    file: over.file ?? 'a.ts',
    line: over.line === undefined ? 1 : over.line, // respect an explicit null
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

  it('reports per-finding agreement (distinct sources), aligned with kept', () => {
    const r = aggregateFindings(
      [
        // two tools agree on x.ts:1 (same issue text)
        f({ tool: 'eslint', fingerprint: 'a', file: 'x.ts', line: 1, message: 'same' }),
        f({ tool: 'biome', fingerprint: 'b', file: 'x.ts', line: 1, message: 'same' }),
        // one tool on y.ts:2
        f({ tool: 'eslint', fingerprint: 'c', file: 'y.ts', line: 2, message: 'lone' })
      ],
      { minSeverity: 'info' }
    )
    expect(r.kept).toHaveLength(2)
    const idx = r.kept.findIndex((k) => k.file === 'x.ts')
    expect(r.agreement[idx]).toBe(2)
    expect(r.agreement[r.kept.findIndex((k) => k.file === 'y.ts')]).toBe(1)
  })

  describe("groupBy 'location' (cross-agent consensus)", () => {
    it('groups by file+line IGNORING message, so differently-phrased agents agree', () => {
      // Two agents flag x.ts:42 with DIFFERENT wording — message grouping would miss it.
      const findings = [
        f({ tool: 'codex', fingerprint: 'a', file: 'x.ts', line: 42, message: 'null deref here' }),
        f({
          tool: 'claude',
          fingerprint: 'b',
          file: 'x.ts',
          line: 42,
          message: 'possible NPE on line 42'
        }),
        f({ tool: 'codex', fingerprint: 'c', file: 'z.ts', line: 9, message: 'only codex' })
      ]
      // message grouping: x.ts:42 splits into 2 single-source groups → consensus 2 keeps nothing.
      expect(aggregateFindings(findings, { consensusMin: 2 }).kept).toHaveLength(0)
      // location grouping: x.ts:42 is one group with 2 distinct agents → survives consensus 2.
      const loc = aggregateFindings(findings, { consensusMin: 2, groupBy: 'location' })
      expect(loc.kept).toHaveLength(1)
      expect(loc.kept[0].file).toBe('x.ts')
      expect(loc.agreement[0]).toBe(2)
    })

    it('counts a single agent reporting two issues at one line as ONE source', () => {
      const findings = [
        f({ tool: 'codex', fingerprint: 'a', file: 'x.ts', line: 5, message: 'issue one' }),
        f({ tool: 'codex', fingerprint: 'b', file: 'x.ts', line: 5, message: 'issue two' })
      ]
      expect(
        aggregateFindings(findings, { consensusMin: 2, groupBy: 'location' }).kept
      ).toHaveLength(0)
    })

    it('does NOT false-merge two unrelated file-level (line-null) findings', () => {
      // Different agents, different file-level issues, both line null — must NOT collapse
      // into one "location" with agreement 2 (no real line to confirm agreement on).
      const findings = [
        f({ tool: 'codex', fingerprint: 'a', file: 'x.ts', line: null, message: 'missing tests' }),
        f({ tool: 'claude', fingerprint: 'b', file: 'x.ts', line: null, message: 'no license' })
      ]
      expect(
        aggregateFindings(findings, { consensusMin: 2, groupBy: 'location' }).kept
      ).toHaveLength(0)
    })

    it('DOES agree on the same file-level (line-null) issue across agents', () => {
      const findings = [
        f({ tool: 'codex', fingerprint: 'a', file: 'x.ts', line: null, message: 'missing tests' }),
        f({ tool: 'claude', fingerprint: 'b', file: 'x.ts', line: null, message: 'missing tests' })
      ]
      const r = aggregateFindings(findings, { consensusMin: 2, groupBy: 'location' })
      expect(r.kept).toHaveLength(1)
      expect(r.agreement[0]).toBe(2)
    })
  })
})
