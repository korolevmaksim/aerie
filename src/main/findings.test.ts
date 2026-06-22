import { describe, expect, it } from 'vitest'
import {
  compareSeverity,
  fingerprintOf,
  inChangedRange,
  parseBiome,
  parseChangedLineRanges,
  parseEslint,
  parseGitleaks,
  parseRuff,
  parseToolOutput,
  parseTsc,
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

describe('parseGitleaks', () => {
  // Real gitleaks v8 JSON shape (PascalCase array, no severity field).
  const SECRET = '60f41f67-b43b-4552-bb80-f2f29b861ef0'
  const sample = JSON.stringify([
    {
      RuleID: 'generic-api-key',
      Description: 'Generic API Key',
      StartLine: 2,
      Match: `Secret: "${SECRET}"`,
      Secret: SECRET,
      File: 'data.json'
    }
  ])

  it('maps the PascalCase shape and treats every finding as high severity', () => {
    const f = parseGitleaks(sample)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({
      tool: 'gitleaks',
      ruleId: 'generic-api-key',
      severity: 'high',
      file: 'data.json',
      line: 2,
      message: 'Generic API Key'
    })
  })

  it('NEVER carries the matched secret value into the Finding (security)', () => {
    const f = parseGitleaks(sample)
    expect(JSON.stringify(f)).not.toContain(SECRET)
  })

  it('tolerates an empty / null scan result', () => {
    expect(parseGitleaks('[]')).toEqual([])
    expect(parseGitleaks('null')).toEqual([])
    expect(parseGitleaks('nope')).toEqual([])
  })
})

describe('parseRuff', () => {
  const sample = JSON.stringify([
    {
      code: 'F401',
      severity: 'error',
      filename: '/p/file.py',
      location: { row: 1, column: 8 },
      message: '`os` imported but unused'
    }
  ])
  it('maps the array shape with nested location.row', () => {
    const f = parseRuff(sample)
    expect(f[0]).toMatchObject({
      tool: 'ruff',
      ruleId: 'F401',
      severity: 'medium', // ruff "error" → medium
      file: '/p/file.py',
      line: 1
    })
  })
})

describe('parseBiome', () => {
  const sample = JSON.stringify({
    diagnostics: [
      {
        severity: 'error',
        message:
          'This import is unused.\nUnused imports might be the result of an incomplete refactoring.\n',
        category: 'lint/correctness/noUnusedImports',
        location: { path: 'index.ts', start: { line: 1, column: 8 } }
      }
    ]
  })
  it('reads diagnostics[] with nested location.start.line and first-line message', () => {
    const f = parseBiome(sample)
    expect(f[0]).toMatchObject({
      tool: 'biome',
      ruleId: 'lint/correctness/noUnusedImports',
      severity: 'medium',
      file: 'index.ts',
      line: 1,
      message: 'This import is unused.'
    })
  })
  it('returns [] when there is no diagnostics array', () => {
    expect(parseBiome('{}')).toEqual([])
  })
})

describe('parseTsc', () => {
  it('parses `file(line,col): error TSxxxx: msg` text diagnostics', () => {
    const f = parseTsc("src/x.ts(3,5): error TS2304: Cannot find name 'foo'.\n(noise line)")
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({
      tool: 'tsc',
      ruleId: 'TS2304',
      severity: 'medium',
      file: 'src/x.ts',
      line: 3
    })
  })
})

describe('parseToolOutput dispatch', () => {
  it('routes each tool id to its parser', () => {
    expect(parseToolOutput('gitleaks', '[]')).toEqual([])
    expect(parseToolOutput('ruff', '[]')).toEqual([])
    expect(parseToolOutput('biome', '{"diagnostics":[]}')).toEqual([])
    expect(parseToolOutput('tsc', '')).toEqual([])
    expect(parseToolOutput('unknown', 'x')).toEqual([])
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

  it('anchors path matching on a segment boundary (pp.ts is not app.ts)', () => {
    const ranges = new Map<string, Array<[number, number]>>([['src/app.ts', [[1, 5]]]])
    expect(inChangedRange('/wt/src/app.ts', 2, ranges)).toBe(true)
    expect(inChangedRange('/wt/src/pp.ts', 2, ranges)).toBe(false)
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
