import { describe, expect, it } from 'vitest'
import {
  compareSeverity,
  extractSecrets,
  fingerprintOf,
  inChangedRange,
  parseActionlint,
  parseAgentFindings,
  parseBandit,
  parseBiome,
  parseChangedLineRanges,
  parseEslint,
  parseGitleaks,
  parseOxlint,
  parseRuff,
  parseToolOutput,
  parseTsc,
  parseYamllint,
  redactFinding,
  renderFindingsForPrompt,
  scopeToChanges,
  type Finding,
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

describe('extractSecrets', () => {
  const SECRET = '60f41f67-b43b-4552-bb80-f2f29b861ef0'
  const sample = JSON.stringify([{ RuleID: 'generic-api-key', Secret: SECRET, File: 'data.json' }])

  it('pulls the literal secret values from gitleaks output', () => {
    expect(extractSecrets('gitleaks', sample)).toEqual([SECRET])
  })
  it('returns [] for non-gitleaks tools and malformed input', () => {
    expect(extractSecrets('eslint', sample)).toEqual([])
    expect(extractSecrets('gitleaks', 'not json')).toEqual([])
    expect(extractSecrets('gitleaks', '[]')).toEqual([])
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

describe('parseBandit', () => {
  const SAMPLE = JSON.stringify({
    results: [
      {
        filename: 'app/views.py',
        line_number: 12,
        test_id: 'B602',
        issue_severity: 'HIGH',
        issue_text: 'subprocess call with shell=True identified, security issue.'
      },
      {
        filename: 'app/util.py',
        line_number: 3,
        test_id: 'B311',
        issue_severity: 'LOW',
        issue_text: 'Standard pseudo-random generators are not suitable for security.'
      }
    ]
  })
  it('maps results with HIGH/LOW severity, file/line/test_id', () => {
    const f = parseBandit(SAMPLE)
    expect(f).toHaveLength(2)
    expect(f[0]).toMatchObject({
      tool: 'bandit',
      file: 'app/views.py',
      line: 12,
      ruleId: 'B602',
      severity: 'high'
    })
    expect(f[1].severity).toBe('low')
  })
  it('returns [] for malformed/empty output', () => {
    expect(parseBandit('not json')).toEqual([])
    expect(parseBandit('{"results":[]}')).toEqual([])
  })
})

describe('parseYamllint', () => {
  const SAMPLE = [
    '.github/x.yml:6:2: [warning] missing starting space in comment (comments)',
    '.github/x.yml:10:1: [error] too many blank lines (3 > 2) (empty-lines)'
  ].join('\n')
  it('parses parsable lines into file/line/level/rule', () => {
    const f = parseYamllint(SAMPLE)
    expect(f).toHaveLength(2)
    expect(f[0]).toMatchObject({
      tool: 'yamllint',
      file: '.github/x.yml',
      line: 6,
      ruleId: 'comments',
      severity: 'low'
    })
    expect(f[0].message).toBe('missing starting space in comment')
    expect(f[1]).toMatchObject({ line: 10, ruleId: 'empty-lines', severity: 'medium' })
  })
  it('ignores non-matching lines', () => {
    expect(parseYamllint('some banner\n\n')).toEqual([])
  })
  it('keeps a trailing non-rule paren in the message (no spurious ruleId)', () => {
    // A message that ends in "(...)" with spaces inside is NOT a rule id.
    const f = parseYamllint('a.yml:1:1: [error] wrong indentation (4 spaces)')
    expect(f).toHaveLength(1)
    expect(f[0].ruleId).toBeNull()
    expect(f[0].message).toBe('wrong indentation (4 spaces)')
  })
})

describe('parseActionlint', () => {
  const SAMPLE = JSON.stringify([
    {
      message: 'property "runs-on" is not defined',
      filepath: '.github/workflows/ci.yml',
      line: 14,
      column: 5,
      kind: 'syntax-check'
    }
  ])
  it('maps filepath/line/kind, severity medium', () => {
    const f = parseActionlint(SAMPLE)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({
      tool: 'actionlint',
      file: '.github/workflows/ci.yml',
      line: 14,
      ruleId: 'syntax-check',
      severity: 'medium'
    })
  })
  it('returns [] for malformed output', () => {
    expect(parseActionlint('boom')).toEqual([])
  })
})

describe('parseOxlint', () => {
  const SAMPLE = JSON.stringify({
    diagnostics: [
      {
        message: '`debugger` statement is not allowed',
        code: 'eslint(no-debugger)',
        severity: 'error',
        filename: 'src/a.ts',
        labels: [{ offset: 10, length: 8, line: 7, column: 1 }]
      }
    ]
  })
  it('maps diagnostics with code/severity/filename and first label line', () => {
    const f = parseOxlint(SAMPLE)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({
      tool: 'oxlint',
      file: 'src/a.ts',
      line: 7,
      ruleId: 'eslint(no-debugger)',
      severity: 'medium'
    })
  })
  it('returns [] for malformed/empty output', () => {
    expect(parseOxlint('x')).toEqual([])
    expect(parseOxlint('{"diagnostics":[]}')).toEqual([])
  })
})

describe('parseAgentFindings', () => {
  const block = (json: string): string =>
    `Here is my review.\n\nLooks mostly good.\n\n\`\`\`aerie-findings\n${json}\n\`\`\`\n`

  it('extracts findings (tool = agentId) and strips the block from the prose', () => {
    const out = block(
      JSON.stringify([
        { file: 'src/a.ts', line: 42, severity: 'high', ruleId: 'no-x', message: 'bad thing' },
        { file: 'src/b.ts', line: 7, severity: 'CRITICAL', message: 'worse thing' }
      ])
    )
    const { findings, prose } = parseAgentFindings('codex', out)
    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatchObject({
      tool: 'codex',
      file: 'src/a.ts',
      line: 42,
      ruleId: 'no-x',
      severity: 'high',
      message: 'bad thing'
    })
    expect(findings[1].severity).toBe('critical') // case-normalized
    expect(prose).not.toContain('aerie-findings')
    expect(prose).toContain('Here is my review.')
  })

  it('returns prose unchanged with no findings when the block is absent', () => {
    const out = 'Just a prose review, no block.'
    expect(parseAgentFindings('codex', out)).toEqual({ findings: [], prose: out })
  })

  it('leaves prose intact for a malformed block (does not strip / mangle, no findings)', () => {
    const out = block('{not json')
    const { findings, prose } = parseAgentFindings('codex', out)
    expect(findings).toEqual([])
    // A block that doesn't parse is NOT stripped (so backticks-in-a-message can't mangle prose).
    expect(prose).toBe(out)
  })

  it('keeps a truncation marker (appended after the block) in the prose', () => {
    const out = `${block(JSON.stringify([{ file: 'a.ts', line: 1, message: 'm' }]))}\n[aerie] output truncated at 10 bytes`
    const { findings, prose } = parseAgentFindings('codex', out)
    expect(findings).toHaveLength(1)
    expect(prose).toContain('output truncated') // M-Q can still detect truncation on the prose
    expect(prose).not.toContain('aerie-findings')
  })

  it('handles CRLF line endings in the block', () => {
    const out =
      'Review.\r\n\r\n```aerie-findings\r\n[{"file":"a.ts","line":2,"message":"crlf"}]\r\n```\r\n'
    const { findings } = parseAgentFindings('codex', out)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toBe('crlf')
  })

  it('caps the number of findings', () => {
    const many = Array.from({ length: 800 }, (_, i) => ({
      file: `f${i}.ts`,
      line: i,
      message: 'x'
    }))
    const { findings } = parseAgentFindings('codex', block(JSON.stringify(many)))
    expect(findings).toHaveLength(500)
  })

  it('skips entries missing a file or message, defaults bad severity to medium', () => {
    const out = block(
      JSON.stringify([
        { line: 1, message: 'no file' },
        { file: 'x.ts', line: 2 },
        { file: 'ok.ts', line: 3, severity: 'bogus', message: 'kept' }
      ])
    )
    const { findings } = parseAgentFindings('claude-code', out)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ file: 'ok.ts', severity: 'medium', message: 'kept' })
  })

  it('tolerates a non-array JSON body', () => {
    expect(parseAgentFindings('codex', block('{"file":"a"}')).findings).toEqual([])
  })
})

describe('redactFinding', () => {
  const f: Finding = {
    tool: 'codex',
    ruleId: 'r',
    severity: 'high',
    file: 'a.ts',
    line: 3,
    message: 'leaked ghp_0123456789abcdef0123456789abcdef0123 here',
    fingerprint: 'old'
  }
  it('scrubs secrets from the message and re-fingerprints', () => {
    const redact = (s: string): string => s.replace(/ghp_[A-Za-z0-9]+/g, '«redacted»')
    const r = redactFinding(f, redact)
    expect(r.message).not.toContain('ghp_')
    expect(r.message).toContain('«redacted»')
    expect(r.fingerprint).not.toBe('old') // recomputed from the redacted fields
  })
  it('leaves a null ruleId null', () => {
    expect(redactFinding({ ...f, ruleId: null }, (s) => s).ruleId).toBeNull()
  })
})

describe('parseToolOutput dispatch', () => {
  it('routes each tool id to its parser', () => {
    expect(parseToolOutput('gitleaks', '[]')).toEqual([])
    expect(parseToolOutput('ruff', '[]')).toEqual([])
    expect(parseToolOutput('biome', '{"diagnostics":[]}')).toEqual([])
    expect(parseToolOutput('tsc', '')).toEqual([])
    expect(parseToolOutput('bandit', '{"results":[]}')).toEqual([])
    expect(parseToolOutput('yamllint', '')).toEqual([])
    expect(parseToolOutput('actionlint', '[]')).toEqual([])
    expect(parseToolOutput('oxlint', '{"diagnostics":[]}')).toEqual([])
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

describe('renderFindingsForPrompt', () => {
  const findings: Finding[] = [
    {
      tool: 'eslint',
      ruleId: 'no-debugger',
      severity: 'low',
      file: 'x.ts',
      line: 3,
      message: 'debugger',
      fingerprint: 'a'
    },
    {
      tool: 'gitleaks',
      ruleId: 'key',
      severity: 'high',
      file: 'd.json',
      line: 2,
      message: 'API Key',
      fingerprint: 'b'
    }
  ]
  it('renders a severity-ordered, compact block', () => {
    const out = renderFindingsForPrompt(findings)
    expect(out.indexOf('[high]')).toBeLessThan(out.indexOf('[low]')) // most severe first
    expect(out).toContain('- [high] gitleaks (d.json:2) key: API Key')
    expect(out).toContain('- [low] eslint (x.ts:3) no-debugger: debugger')
  })
  it('returns an empty string for no findings', () => {
    expect(renderFindingsForPrompt([])).toBe('')
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
