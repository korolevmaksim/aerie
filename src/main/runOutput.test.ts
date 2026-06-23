import { describe, expect, it } from 'vitest'
import { parseAgentFindings } from './findings'
import { DIAG_TAIL_MAX, formatMissingOutputError, keepTail } from './runOutput'

describe('keepTail', () => {
  it('concatenates while under the cap', () => {
    expect(keepTail('abc', 'def', 10)).toBe('abcdef')
  })

  it('keeps only the last `max` chars (the tail) once over the cap', () => {
    expect(keepTail('abcdef', 'ghij', 4)).toBe('ghij')
    expect(keepTail('', '0123456789', 4)).toBe('6789')
  })

  it('keeps the most recent output across many small chunks', () => {
    let buf = ''
    for (const c of ['line1\n', 'line2\n', 'FATAL: boom\n']) buf = keepTail(buf, c, 12)
    expect(buf.endsWith('FATAL: boom\n')).toBe(true)
    expect(buf.length).toBeLessThanOrEqual(12)
  })

  it('defaults to DIAG_TAIL_MAX', () => {
    const big = 'x'.repeat(DIAG_TAIL_MAX + 100)
    expect(keepTail('', big).length).toBe(DIAG_TAIL_MAX)
  })
})

describe('formatMissingOutputError', () => {
  it('includes the exit code, reason, and the agent output tail', () => {
    const out = formatMissingOutputError(
      1,
      'declared output file not found',
      'Error loading config.toml: unknown variant `default`, expected `fast` or `flex` in `service_tier`'
    )
    expect(out).toContain('agent exited (code 1)')
    expect(out).toContain('declared output file not found')
    expect(out).toContain('--- last agent output ---')
    // The real cause must survive into the finalized output (the regression we are fixing).
    expect(out).toContain('unknown variant `default`')
  })

  it('renders a null exit code without crashing', () => {
    expect(formatMissingOutputError(null, 'declared output file not found', 'boom')).toContain(
      'code null'
    )
  })

  it('omits the output section when there is no captured tail', () => {
    const out = formatMissingOutputError(0, 'declared output file not found', '   \n  ')
    expect(out).toContain('agent exited (code 0)')
    expect(out).not.toContain('--- last agent output ---')
  })

  it('exit code 0 with no file is still reported (contract mismatch, not silent success)', () => {
    expect(
      formatMissingOutputError(0, 'declared output file not found', 'wrote nothing')
    ).toContain('agent exited (code 0)')
  })
})

describe('formatMissingOutputError ∘ parseAgentFindings (the regression being fixed)', () => {
  it('the composed error reaches the .out intact — backticks are not a findings block', () => {
    // codex aborts with backtick-laden config text; it must survive parsing as prose so the real
    // cause lands in the finalized output (not be mistaken for an aerie-findings fence and stripped).
    const composed = formatMissingOutputError(
      1,
      'declared output file not found',
      'Error loading config.toml: unknown variant `default`, expected `fast` or `flex` in `service_tier`'
    )
    const parsed = parseAgentFindings('codex', composed)
    expect(parsed.findings).toEqual([])
    expect(parsed.prose).toBe(composed)
    expect(parsed.prose).toContain('unknown variant `default`')
  })
})
