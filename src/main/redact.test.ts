import { describe, it, expect } from 'vitest'
import { redact } from './redact'

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
