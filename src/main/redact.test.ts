import { describe, it, expect } from 'vitest'
import { extractSecrets } from './findings'
import { redact, redactText } from './redact'

describe('redact', () => {
  it('redacts a classic ghp_ token', () => {
    expect(redact('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).toBe('token [REDACTED]')
  })

  it('redacts a fine-grained github_pat_ token', () => {
    const t = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEF'
    expect(redact(`Bearer ${t}`)).toBe('Bearer [REDACTED]')
  })

  it('redacts a token inside an Authorization header string', () => {
    const out = redact('Authorization: token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    expect(out).not.toContain('ghp_')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts tokens nested in objects and arrays', () => {
    const input = {
      msg: 'ok',
      headers: { authorization: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
      list: ['github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEF']
    }
    const out = redact(input) as typeof input
    expect(out.headers.authorization).toBe('token [REDACTED]')
    expect(out.list[0]).toBe('[REDACTED]')
    expect(out.msg).toBe('ok')
  })

  it('leaves non-token values untouched', () => {
    expect(redact('a normal log line')).toBe('a normal log line')
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBe(null)
    expect(redact(true)).toBe(true)
  })
})

describe('redactText', () => {
  it('redacts GitHub tokens by default', () => {
    expect(redactText('x ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 y')).toBe('x [REDACTED] y')
  })

  it('scrubs provided literal secrets verbatim (everywhere, incl. inside a fragment)', () => {
    const secret = '60f41f67-b43b-4552-bb80-f2f29b861ef0'
    const raw = `value=${secret} and Match: "Secret: \\"${secret}\\""`
    const out = redactText(raw, [secret])
    expect(out).not.toContain(secret)
    expect(out).toContain('[REDACTED]')
  })

  it('ignores very short secrets to avoid over-redaction', () => {
    expect(redactText('the cat sat', ['cat'])).toBe('the cat sat')
  })

  it('is a no-op when there is nothing to redact', () => {
    expect(redactText('clean output', [])).toBe('clean output')
  })

  it('the finalize scrub pipeline removes a gitleaks secret AND a token from raw output', () => {
    // Mirrors agentRunner.finalize: extractSecrets(tool) -> redactText(output, secrets).
    const SECRET = '60f41f67-b43b-4552-bb80-f2f29b861ef0'
    const raw = JSON.stringify([
      {
        RuleID: 'generic-api-key',
        Secret: SECRET,
        Match: `token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ${SECRET}`,
        File: 'data.json'
      }
    ])
    const scrubbed = redactText(raw, extractSecrets('gitleaks', raw))
    expect(scrubbed).not.toContain(SECRET)
    expect(scrubbed).not.toContain('ghp_')
  })
})

describe('redactText — third-party provider secrets (agents authenticate with their own keys)', () => {
  // Aerie shells out to coding agents whose auth errors / verbose output can print a non-GitHub
  // secret. Each is a realistic shape; the value must not survive into a .out / .log / posted body.
  const cases: Array<[string, string]> = [
    ['OpenAI sk-', 'error: invalid api key sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd done'],
    ['OpenAI sk-proj-', 'OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 set'],
    [
      'Anthropic sk-ant-',
      'auth failed: sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345-_AA reported'
    ],
    ['AWS AKIA', 'using AKIAIOSFODNN7EXAMPLE as the access key'],
    ['Google AIza', 'key AIzaSyA1234567890abcdefghijklmnopqrstuv rejected'],
    ['Slack xoxb-', 'SLACK_TOKEN=xoxb-123456789012-abcdefABCDEF here']
  ]
  for (const [name, line] of cases) {
    it(`redacts a ${name} key`, () => {
      const out = redactText(line)
      expect(out).toContain('[REDACTED]')
      // the distinctive prefix+body should be gone (the bare prefix may remain harmlessly)
      expect(out).not.toMatch(/sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/)
      expect(out).not.toMatch(/AKIA[0-9A-Z]{16}/)
      expect(out).not.toMatch(/AIza[0-9A-Za-z_-]{35}/)
      expect(out).not.toMatch(/xox[baprs]-[A-Za-z0-9-]{10,}/)
    })
  }

  it('redacts a Google AIza key whose 35-char body ends in a dash (no trailing-\\b leak)', () => {
    const out = redactText('GOOGLE_API_KEY=AIzaSyA1234567890abcdefghijklmnopqrstu- next')
    expect(out).not.toMatch(/AIza[0-9A-Za-z_-]{35}/)
    expect(out).toContain('[REDACTED]')
  })

  it('redacts credentials embedded in a URL authority (e.g. a git remote with a PAT)', () => {
    const out = redactText(
      'fatal: unable to access https://x-access-token:ghp_SECRETPLACEHOLDER@github.com/o/r'
    )
    expect(out).not.toContain('ghp_SECRETPLACEHOLDER')
    expect(out).toContain('https://[REDACTED]@github.com/o/r')
  })

  it('does NOT touch a normal URL with no credentials or a host:port', () => {
    expect(redactText('cloning https://github.com/owner/repo and http://localhost:8080/x')).toBe(
      'cloning https://github.com/owner/repo and http://localhost:8080/x'
    )
  })

  it('redacts a whole PEM private-key block', () => {
    const pem =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\nAAAAC3NzaC1l\n-----END OPENSSH PRIVATE KEY-----'
    const out = redactText(`before\n${pem}\nafter`)
    expect(out).toBe('before\n[REDACTED]\nafter')
  })

  it('does NOT false-match ordinary hyphenated words that merely contain "sk-"', () => {
    const prose =
      'task-management-dashboard and risk-assessment-workflow and disk-usage-report-tool'
    expect(redactText(prose)).toBe(prose)
  })

  it('does NOT redact ordinary uppercase or base64-ish prose', () => {
    expect(redactText('THE QUICK BROWN FOX AKIA jumps')).toBe('THE QUICK BROWN FOX AKIA jumps')
    expect(redactText('a normal review: looks good, ship it')).toBe(
      'a normal review: looks good, ship it'
    )
  })
})
