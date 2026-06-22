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
