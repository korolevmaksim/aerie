// Pure normalization of tool/agent output into a common Finding shape, plus
// diff-scoping (ROADMAP M4). Electron-free so it is unit-testable. The runner/store
// (persistence + redaction) and the remaining tool parsers (gitleaks/ruff/biome/tsc)
// wire in next; this is the keystone the noise-filter (M6) and grounding (M5) consume.

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface Finding {
  /** The tool/agent that produced this finding (e.g. 'eslint'). */
  tool: string
  /** Rule/check id, or null if the source has none. */
  ruleId: string | null
  severity: Severity
  /** File path as reported by the tool (often absolute; scoping normalizes paths). */
  file: string
  /** 1-based line in the new file, or null. */
  line: number | null
  message: string
  /** Stable across runs/sources for the same issue — the dedup key (M6). */
  fingerprint: string
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1
}

/** Sort comparator: most-severe first. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_ORDER[b] - SEVERITY_ORDER[a]
}

/** FNV-1a 32-bit hash → 8 hex chars. Deterministic and dependency-free. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

function normalizeMessage(m: string): string {
  return m.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** A stable fingerprint for "the same issue" across runs/sources (the dedup key). */
export function fingerprintOf(parts: {
  file: string
  line: number | null
  ruleId: string | null
  message: string
}): string {
  return fnv1a(
    [parts.file, parts.line ?? '', parts.ruleId ?? '', normalizeMessage(parts.message)].join(
      '\u0000'
    )
  )
}

function makeFinding(
  tool: string,
  f: {
    file: string
    line: number | null
    ruleId: string | null
    severity: Severity
    message: string
  }
): Finding {
  return {
    tool,
    ruleId: f.ruleId,
    severity: f.severity,
    file: f.file,
    line: f.line,
    message: f.message,
    fingerprint: fingerprintOf({ file: f.file, line: f.line, ruleId: f.ruleId, message: f.message })
  }
}

function firstLine(s: string): string {
  return s.split('\n')[0].trim()
}

/** Maps a string lint/diagnostic severity to the common scale. */
function mapLintSeverity(s: string | null): Severity {
  switch ((s ?? '').toLowerCase()) {
    case 'fatal':
      return 'high'
    case 'error':
      return 'medium'
    case 'warning':
      return 'low'
    case 'info':
    case 'hint':
      return 'info'
    default:
      return 'medium' // a reported violation with no/unknown severity is still real
  }
}

// --- per-tool parsers --------------------------------------------------------

/** Parse `eslint -f json` output. ESLint severity: 2 = error, 1 = warning. */
export function parseEslint(raw: string): Finding[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const out: Finding[] = []
  for (const fileResult of data) {
    const fr = fileResult as { filePath?: unknown; messages?: unknown }
    const file = typeof fr?.filePath === 'string' ? fr.filePath : ''
    const messages = Array.isArray(fr?.messages) ? fr.messages : []
    for (const msg of messages) {
      const m = msg as { ruleId?: unknown; severity?: unknown; message?: unknown; line?: unknown }
      if (!m || typeof m !== 'object') continue
      out.push(
        makeFinding('eslint', {
          file,
          line: typeof m.line === 'number' ? m.line : null,
          ruleId: typeof m.ruleId === 'string' ? m.ruleId : null,
          severity: m.severity === 2 ? 'medium' : 'low',
          message: typeof m.message === 'string' ? m.message : ''
        })
      )
    }
  }
  return out
}

/**
 * Parse `gitleaks dir . --report-format json` — a top-level array with PascalCase
 * keys (File, StartLine, RuleID, Description) and NO severity (every finding is a
 * detected secret → 'high'). SECURITY: never carries the matched Secret/Match value
 * into the Finding, so a secret can't leak into stored output / a posted comment.
 */
export function parseGitleaks(raw: string): Finding[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return [] // an empty scan can be [] or null
  const out: Finding[] = []
  for (const item of data) {
    const g = item as {
      File?: unknown
      StartLine?: unknown
      RuleID?: unknown
      Description?: unknown
    }
    if (!g || typeof g !== 'object') continue
    const ruleId = typeof g.RuleID === 'string' ? g.RuleID : null
    const desc =
      typeof g.Description === 'string' && g.Description.trim()
        ? g.Description
        : (ruleId ?? 'secret')
    out.push(
      makeFinding('gitleaks', {
        file: typeof g.File === 'string' ? g.File : '',
        line: typeof g.StartLine === 'number' ? g.StartLine : null,
        ruleId,
        severity: 'high',
        message: firstLine(desc) // deliberately NOT the Secret/Match value
      })
    )
  }
  return out
}

/** Parse `ruff check --output-format json` — a top-level array; line is location.row. */
export function parseRuff(raw: string): Finding[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const out: Finding[] = []
  for (const item of data) {
    const r = item as {
      filename?: unknown
      code?: unknown
      message?: unknown
      severity?: unknown
      location?: { row?: unknown }
    }
    if (!r || typeof r !== 'object') continue
    out.push(
      makeFinding('ruff', {
        file: typeof r.filename === 'string' ? r.filename : '',
        line: typeof r.location?.row === 'number' ? r.location.row : null,
        ruleId: typeof r.code === 'string' ? r.code : null,
        severity: mapLintSeverity(typeof r.severity === 'string' ? r.severity : null),
        message: typeof r.message === 'string' ? firstLine(r.message) : ''
      })
    )
  }
  return out
}

/** Parse `biome check --reporter=json` — an object whose `diagnostics[]` carry the findings. */
export function parseBiome(raw: string): Finding[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  const diags = (data as { diagnostics?: unknown })?.diagnostics
  if (!Array.isArray(diags)) return []
  const out: Finding[] = []
  for (const item of diags) {
    const b = item as {
      category?: unknown
      message?: unknown
      severity?: unknown
      location?: { path?: unknown; start?: { line?: unknown } }
    }
    if (!b || typeof b !== 'object') continue
    const loc = b.location ?? {}
    const lp = loc.path
    const file =
      typeof lp === 'string'
        ? lp
        : lp && typeof lp === 'object' && typeof (lp as { file?: unknown }).file === 'string'
          ? (lp as { file: string }).file
          : ''
    out.push(
      makeFinding('biome', {
        file,
        line: typeof loc.start?.line === 'number' ? loc.start.line : null,
        ruleId: typeof b.category === 'string' ? b.category : null,
        severity: mapLintSeverity(typeof b.severity === 'string' ? b.severity : null),
        message: typeof b.message === 'string' ? firstLine(b.message) : ''
      })
    )
  }
  return out
}

const TSC_RE = /^(.+?)\((\d+),\d+\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/

/** Parse `tsc --noEmit --pretty false` text diagnostics: `file(line,col): error TSxxxx: msg`. */
export function parseTsc(raw: string): Finding[] {
  const out: Finding[] = []
  for (const line of raw.split('\n')) {
    const m = TSC_RE.exec(line.trim())
    if (!m) continue
    out.push(
      makeFinding('tsc', {
        file: m[1],
        line: Number(m[2]),
        ruleId: m[4],
        severity: m[3] === 'error' ? 'medium' : 'low',
        message: m[5].trim()
      })
    )
  }
  return out
}

/** Maps bandit's HIGH/MEDIUM/LOW issue_severity to the common scale. */
function banditSeverity(s: string | null): Severity {
  switch ((s ?? '').toLowerCase()) {
    case 'high':
      return 'high'
    case 'medium':
      return 'medium'
    case 'low':
      return 'low'
    default:
      return 'medium'
  }
}

/**
 * Parse `bandit -r . -f json -q` (Python SAST) — `{results:[{filename, line_number,
 * test_id, issue_severity, issue_text}]}`. The `code` snippet field is deliberately
 * NOT carried into the Finding (it can echo source lines).
 */
export function parseBandit(raw: string): Finding[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  const results = (data as { results?: unknown })?.results
  if (!Array.isArray(results)) return []
  const out: Finding[] = []
  for (const item of results) {
    const r = item as {
      filename?: unknown
      line_number?: unknown
      test_id?: unknown
      issue_severity?: unknown
      issue_text?: unknown
    }
    if (!r || typeof r !== 'object') continue
    out.push(
      makeFinding('bandit', {
        file: typeof r.filename === 'string' ? r.filename : '',
        line: typeof r.line_number === 'number' ? r.line_number : null,
        ruleId: typeof r.test_id === 'string' ? r.test_id : null,
        severity: banditSeverity(typeof r.issue_severity === 'string' ? r.issue_severity : null),
        message: typeof r.issue_text === 'string' ? firstLine(r.issue_text) : ''
      })
    )
  }
  return out
}

const YAMLLINT_RE = /^(.+?):(\d+):(\d+):\s+\[(error|warning)\]\s+(.*)$/

/** Parse `yamllint -f parsable .` lines: `path:line:col: [level] message (rule)`. */
export function parseYamllint(raw: string): Finding[] {
  const out: Finding[] = []
  for (const line of raw.split('\n')) {
    const m = YAMLLINT_RE.exec(line.trim())
    if (!m) continue
    let message = m[5].trim()
    let ruleId: string | null = null
    // yamllint appends the rule id in trailing parens, e.g. "... (comments)".
    const rule = message.match(/\(([\w-]+)\)$/)
    if (rule) {
      ruleId = rule[1]
      message = message.slice(0, rule.index).trim()
    }
    out.push(
      makeFinding('yamllint', {
        file: m[1],
        line: Number(m[2]),
        ruleId,
        severity: mapLintSeverity(m[4]),
        message
      })
    )
  }
  return out
}

/**
 * Parse `actionlint -format '{{json .}}'` — an array of GitHub Actions workflow
 * problems `{message, filepath, line, column, kind}`. actionlint has no severity
 * scale (every entry is a problem) → 'medium'.
 */
export function parseActionlint(raw: string): Finding[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const out: Finding[] = []
  for (const item of data) {
    const a = item as { message?: unknown; filepath?: unknown; line?: unknown; kind?: unknown }
    if (!a || typeof a !== 'object') continue
    out.push(
      makeFinding('actionlint', {
        file: typeof a.filepath === 'string' ? a.filepath : '',
        line: typeof a.line === 'number' ? a.line : null,
        ruleId: typeof a.kind === 'string' ? a.kind : null,
        severity: 'medium',
        message: typeof a.message === 'string' ? firstLine(a.message) : ''
      })
    )
  }
  return out
}

/**
 * Parse `oxlint -f json` — `{diagnostics:[{message, code, severity, filename,
 * labels:[{line, column}]}]}`. `code` is like `eslint(no-debugger)`.
 */
export function parseOxlint(raw: string): Finding[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  const diags = (data as { diagnostics?: unknown })?.diagnostics
  if (!Array.isArray(diags)) return []
  const out: Finding[] = []
  for (const item of diags) {
    const d = item as {
      message?: unknown
      code?: unknown
      severity?: unknown
      filename?: unknown
      labels?: unknown
    }
    if (!d || typeof d !== 'object') continue
    const labels = Array.isArray(d.labels) ? d.labels : []
    const first = labels[0] as { line?: unknown } | undefined
    out.push(
      makeFinding('oxlint', {
        file: typeof d.filename === 'string' ? d.filename : '',
        line: typeof first?.line === 'number' ? first.line : null,
        ruleId: typeof d.code === 'string' ? d.code : null,
        severity: mapLintSeverity(typeof d.severity === 'string' ? d.severity : null),
        message: typeof d.message === 'string' ? firstLine(d.message) : ''
      })
    )
  }
  return out
}

/** Normalizes an agent-supplied severity string to the common scale (default medium). */
function normalizeSeverity(s: unknown): Severity {
  const v = typeof s === 'string' ? s.trim().toLowerCase() : ''
  if (v === 'critical' || v === 'high' || v === 'medium' || v === 'low' || v === 'info') return v
  return 'medium'
}

// The fenced block an LLM agent appends with its machine-readable findings (M8/M9).
const AERIE_FINDINGS_RE = /```aerie-findings[ \t]*\r?\n([\s\S]*?)\r?\n?```/
// Cap a single agent's findings so a runaway/malicious block can't bloat the DB or UI.
const MAX_AGENT_FINDINGS = 500

/**
 * Split an LLM review into its prose and a structured findings list. The agent is asked
 * to append a fenced ```aerie-findings JSON array (file/line/severity/ruleId/message);
 * this parses it best-effort (findings carry `tool = agentId` so cross-agent consensus
 * counts distinct agents). The block is stripped from the prose ONLY when it parses to a
 * valid array — a malformed/non-array block is left in place so a `` ``` `` inside a
 * message can't mangle the surrounding prose. Absent/malformed → no findings, prose
 * unchanged (never throws). An entry needs at least a file and a message; count is capped.
 */
export function parseAgentFindings(
  agentId: string,
  output: string
): { findings: Finding[]; prose: string } {
  const m = AERIE_FINDINGS_RE.exec(output)
  if (!m) return { findings: [], prose: output }
  let data: unknown
  try {
    data = JSON.parse(m[1].trim())
  } catch {
    return { findings: [], prose: output } // garbage block → leave prose intact, no findings
  }
  if (!Array.isArray(data)) return { findings: [], prose: output }
  // Valid array → now it's safe to strip the block from the prose.
  const prose = (output.slice(0, m.index) + output.slice(m.index + m[0].length)).trim()
  const findings: Finding[] = []
  for (const item of data) {
    if (findings.length >= MAX_AGENT_FINDINGS) break
    const f = item as {
      file?: unknown
      line?: unknown
      severity?: unknown
      ruleId?: unknown
      message?: unknown
    }
    if (!f || typeof f !== 'object') continue
    const file = typeof f.file === 'string' ? f.file.trim() : ''
    const message = typeof f.message === 'string' ? firstLine(f.message) : ''
    if (!file || !message) continue
    findings.push(
      makeFinding(agentId, {
        file,
        line: typeof f.line === 'number' && Number.isFinite(f.line) ? f.line : null,
        ruleId: typeof f.ruleId === 'string' && f.ruleId.trim() ? f.ruleId.trim() : null,
        severity: normalizeSeverity(f.severity),
        message
      })
    )
  }
  return { findings, prose }
}

/**
 * Re-redacts an agent finding's free-text fields (file/ruleId/message) and recomputes its
 * fingerprint, so a secret an agent echoed inside its findings block never persists to the
 * findings table or reaches the renderer unscrubbed. `redact` is the caller's scrubber.
 */
export function redactFinding(f: Finding, redact: (s: string) => string): Finding {
  const file = redact(f.file)
  const ruleId = f.ruleId !== null ? redact(f.ruleId) : null
  const message = redact(f.message)
  return {
    ...f,
    file,
    ruleId,
    message,
    fingerprint: fingerprintOf({ file, line: f.line, ruleId, message })
  }
}

/**
 * The literal secret values a tool surfaced, so they can be scrubbed from persisted
 * run output/transcripts. Only gitleaks exposes secret values; scrubbing the Secret
 * value also removes it from the Match fragment (which contains it as a substring).
 *
 * INVARIANT: any future kind:'tool' whose output can carry raw secret values (e.g.
 * trufflehog) MUST be handled here, or its secrets would persist unredacted to disk.
 */
export function extractSecrets(toolId: string, raw: string): string[] {
  if (toolId !== 'gitleaks') return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const secrets = new Set<string>()
  for (const item of data) {
    const g = item as { Secret?: unknown }
    if (g && typeof g === 'object' && typeof g.Secret === 'string' && g.Secret.length >= 8) {
      secrets.add(g.Secret)
    }
  }
  return [...secrets]
}

/** Dispatch raw tool output to its parser. Unknown tools / malformed output → []. */
export function parseToolOutput(toolId: string, raw: string): Finding[] {
  switch (toolId) {
    case 'eslint':
      return parseEslint(raw)
    case 'gitleaks':
      return parseGitleaks(raw)
    case 'ruff':
      return parseRuff(raw)
    case 'biome':
      return parseBiome(raw)
    case 'tsc':
      return parseTsc(raw)
    case 'bandit':
      return parseBandit(raw)
    case 'yamllint':
      return parseYamllint(raw)
    case 'actionlint':
      return parseActionlint(raw)
    case 'oxlint':
      return parseOxlint(raw)
    default:
      return []
  }
}

/**
 * Renders findings as a compact, severity-ordered block for injection into an agent
 * prompt as deterministic ground truth (M5). Returns '' for an empty set.
 */
export function renderFindingsForPrompt(findings: Finding[]): string {
  if (findings.length === 0) return ''
  return [...findings]
    .sort((a, b) => compareSeverity(a.severity, b.severity))
    .map((f) => {
      const loc = f.line != null ? `${f.file}:${f.line}` : f.file
      const rule = f.ruleId ? ` ${f.ruleId}` : ''
      return `- [${f.severity}] ${f.tool} (${loc})${rule}: ${f.message}`
    })
    .join('\n')
}

// --- diff scoping ------------------------------------------------------------

/** Maps each file to the new-side line spans touched by the diff's hunks. */
function unquoteGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path
  const inner = path.slice(1, -1)
  let out = ''
  let bytes: number[] = []
  const flushBytes = (): void => {
    if (bytes.length === 0) return
    out += Buffer.from(bytes).toString('utf8')
    bytes = []
  }
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch !== '\\') {
      flushBytes()
      out += ch
      continue
    }
    const next = inner[i + 1]
    if (next === undefined) {
      flushBytes()
      out += ch
      continue
    }
    if (/[0-7]/.test(next)) {
      const m = /^[0-7]{1,3}/.exec(inner.slice(i + 1))
      const octal = m?.[0] ?? next
      bytes.push(Number.parseInt(octal, 8))
      i += octal.length
      continue
    }
    flushBytes()
    switch (next) {
      case 'n':
        out += '\n'
        break
      case 't':
        out += '\t'
        break
      case 'r':
        out += '\r'
        break
      case 'b':
        out += '\b'
        break
      case 'f':
        out += '\f'
        break
      default:
        out += next
        break
    }
    i += 1
  }
  flushBytes()
  return out
}

export function parseChangedLineRanges(diff: string): Map<string, Array<[number, number]>> {
  const ranges = new Map<string, Array<[number, number]>>()
  let file: string | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = unquoteGitPath(line.slice(4).trim())
      file = p === '/dev/null' ? null : p.replace(/^b\//, '')
      continue
    }
    if (line.startsWith('@@') && file) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (m) {
        const start = Number(m[1])
        const count = m[2] === undefined ? 1 : Number(m[2])
        const end = start + Math.max(count, 1) - 1
        const arr = ranges.get(file) ?? []
        arr.push([start, end])
        ranges.set(file, arr)
      }
    }
  }
  return ranges
}

/** Suffix match anchored on a path-segment boundary (so 'pp.ts' ≠ 'app.ts'). */
function pathSuffixMatch(a: string, b: string): boolean {
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a)
}

/**
 * True if a finding's file+line falls within the diff's changed ranges. Tools
 * report absolute paths while the diff is repo-relative, so paths match by a
 * segment-anchored suffix.
 */
export function inChangedRange(
  file: string,
  line: number | null,
  ranges: Map<string, Array<[number, number]>>
): boolean {
  if (line == null) return false
  const norm = file.replace(/\\/g, '/')
  for (const [rfile, spans] of ranges) {
    if (pathSuffixMatch(norm, rfile)) {
      if (spans.some(([s, e]) => line >= s && line <= e)) return true
    }
  }
  return false
}

/** Keeps only findings whose line is within the diff's changed ranges. */
export function scopeToChanges(
  findings: Finding[],
  ranges: Map<string, Array<[number, number]>>
): Finding[] {
  return findings.filter((f) => inChangedRange(f.file, f.line, ranges))
}
