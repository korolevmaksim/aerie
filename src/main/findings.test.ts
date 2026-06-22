import { describe, expect, it } from 'vitest'
import {
  compareSeverity,
  fingerprintOf,
  inChangedRange,
  parseChangedLineRanges,
  parseEslint,
  parseToolOutput,
  scopeToChanges,
  type Severity
} from './findings'

// A real `eslint -f json .` sample shape (captured from actual ESLint output):
// top-level array of { filePath, messages: [{ ruleId, severity(1=warn,2=error), message, line }] }.
const ESLINT_SAMPLE = JSON.stringify([
  {
    filePath: '/tmp/wt/bad.js',
    messages: [
      {
        ruleId: 'no-unused-vars',
        severity: 1,
        message: "'x' is assigned a value but never used.",
        line: 2,
        column: 7
      },
      {
        ruleId: 'no-debugger',
        severity: 2,
        message: "Unexpected 'debugger' statement.",
        line: 3,
        column: 3
      }
    ]
  }
])

describe('parseEslint', () => {
  it('normalizes the real ESLint JSON shape into Findings', () => {
    const f = parseEslint(ESLINT_SAMPLE)
    expect(f).toHaveLength(2)
    expect(f[0]).toMatchObject({
      tool: 'eslint',
      ruleId: 'no-unused-vars',
      severity: 'low', // warning (1) → low
      file: '/tmp/wt/bad.js',
      line: 2
    })
    expect(f[1]).toMatchObject({ ruleId: 'no-debugger', severity: 'medium', line: 3 }) // error (2) → medium
    expect(f[0].fingerprint).toMatch(/^[0-9a-f]{8}$/)
  })

  it('returns [] on malformed or non-array input', () => {
    expect(parseEslint('not json')).toEqual([])
    expect(parseEslint('{}')).toEqual([])
    expect(parseEslint('[]')).toEqual([])
  })

  it('parseToolOutput dispatches eslint and ignores unknown tools', () => {
    expect(parseToolOutput('eslint', ESLINT_SAMPLE)).toHaveLength(2)
    expect(parseToolOutput('not-a-tool', ESLINT_SAMPLE)).toEqual([])
  })
})

describe('fingerprintOf', () => {
  const base = { file: 'a.ts', line: 10, ruleId: 'r', message: 'Bad thing here' }
  it('is stable for the same issue and whitespace/case-insensitive on the message', () => {
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base, message: '  bad   THING here ' }))
  })
  it('differs when file, line, or rule differ', () => {
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, line: 11 }))
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, file: 'b.ts' }))
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, ruleId: 'r2' }))
  })
})

describe('compareSeverity', () => {
  it('orders most-severe first', () => {
    const sorted = (['low', 'critical', 'medium'] as Severity[]).sort(compareSeverity)
    expect(sorted).toEqual(['critical', 'medium', 'low'])
  })
})

describe('diff scoping', () => {
  const diff = [
    'diff --git a/src/x.ts b/src/x.ts',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -10,3 +10,4 @@',
    ' context',
    '+added line',
    ' context',
    ' context',
    'diff --git a/docs/y.md b/docs/y.md',
    '--- /dev/null',
    '+++ b/docs/y.md',
    '@@ -0,0 +1,2 @@',
    '+new file line 1',
    '+new file line 2'
  ].join('\n')

  it('parses per-file changed line ranges from hunks', () => {
    const r = parseChangedLineRanges(diff)
    expect(r.get('src/x.ts')).toEqual([[10, 13]])
    expect(r.get('docs/y.md')).toEqual([[1, 2]])
  })

  it('matches absolute tool paths to repo-relative diff paths by suffix', () => {
    const r = parseChangedLineRanges(diff)
    expect(inChangedRange('/work/tree/src/x.ts', 11, r)).toBe(true)
    expect(inChangedRange('/work/tree/src/x.ts', 99, r)).toBe(false) // outside the hunk
    expect(inChangedRange('/work/tree/src/other.ts', 11, r)).toBe(false) // different file
    expect(inChangedRange('/work/tree/src/x.ts', null, r)).toBe(false) // no line
  })

  it('scopeToChanges keeps only findings inside the changed ranges', () => {
    const r = parseChangedLineRanges(diff)
    const findings = parseEslint(
      JSON.stringify([
        {
          filePath: '/work/tree/src/x.ts',
          messages: [
            { ruleId: 'r1', severity: 2, message: 'in range', line: 11 },
            { ruleId: 'r2', severity: 2, message: 'out of range', line: 200 }
          ]
        }
      ])
    )
    const scoped = scopeToChanges(findings, r)
    expect(scoped.map((f) => f.message)).toEqual(['in range'])
  })
})
