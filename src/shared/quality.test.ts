import { describe, expect, it } from 'vitest'
import { assessReviewQuality } from './quality'

describe('assessReviewQuality', () => {
  const goodReview = [
    '## Review',
    'The change looks correct. One concern: `foo()` can throw on null input at',
    'src/a.ts:42 — guard it. Otherwise LGTM.'
  ].join('\n')

  it('passes a substantive review', () => {
    const q = assessReviewQuality(goodReview, { kind: 'agent' })
    expect(q.level).toBe('ok')
    expect(q.reasons).toEqual([])
  })

  it('flags empty / whitespace-only output as low', () => {
    expect(assessReviewQuality('', { kind: 'agent' }).level).toBe('low')
    expect(assessReviewQuality('   \n\t ', { kind: 'agent' }).level).toBe('low')
  })

  it('flags output too short to be a review', () => {
    const q = assessReviewQuality('LGTM', { kind: 'agent' })
    expect(q.level).toBe('low')
    expect(q.reasons.join(' ')).toMatch(/too short/i)
  })

  it('flags truncated output', () => {
    const truncated = `${goodReview}\n[aerie] output truncated at 4194304 bytes`
    const q = assessReviewQuality(truncated, { kind: 'agent' })
    expect(q.level).toBe('low')
    expect(q.reasons.join(' ')).toMatch(/truncated/i)
  })

  it('flags a leaked <thinking> transcript', () => {
    const leak = '<thinking>\nLet me read the diff and consider edge cases...\n</thinking>'
    const q = assessReviewQuality(leak, { kind: 'agent' })
    expect(q.level).toBe('low')
    expect(q.reasons.join(' ')).toMatch(/transcript/i)
  })

  it('flags output dominated by tool-call envelope lines', () => {
    const noise = [
      '● Read(src/a.ts)',
      '⏺ Grep(foo)',
      '{"type":"tool_use","name":"read"}',
      '● Bash(npm test)',
      'event: message'
    ].join('\n')
    expect(assessReviewQuality(noise, { kind: 'agent' }).level).toBe('low')
  })

  it('flags a bare Aerie error sentinel as the whole body', () => {
    const q = assessReviewQuality('[aerie] no output file configured.', { kind: 'agent' })
    expect(q.level).toBe('low')
    expect(q.reasons.join(' ')).toMatch(/Aerie error/i)
  })

  it('does NOT flag a review that merely mentions tools or thinking in prose', () => {
    // A real review can discuss "thinking" or reference tool output without being a leak.
    const review =
      'I was thinking about the error path: the eslint finding at a.ts:3 is real — confirm it. ' +
      'The data: prefix handling also needs a guard. Overall solid; ship after the fix.'
    expect(assessReviewQuality(review, { kind: 'agent' }).level).toBe('ok')
  })

  it('does NOT flag a review containing a fenced code block with type/data/event lines', () => {
    // Locks the 0.6 noise-ratio threshold: pasted JSON/SSE inside a real review is fine.
    const review = [
      '## Review',
      'The handler shape is wrong. It currently returns:',
      '```json',
      '{"type":"result","data":"ok"}',
      'event: done',
      'data: [DONE]',
      '```',
      'It should return a typed object — fix `handler()` at src/api.ts:88. Otherwise solid.'
    ].join('\n')
    expect(assessReviewQuality(review, { kind: 'agent' }).level).toBe('ok')
  })

  it('does NOT flag a bullet-list / table-heavy review', () => {
    const review = [
      '### Findings',
      '- `a.ts:10` — null deref, real, fix it',
      '- `b.ts:22` — minor naming nit',
      '',
      '| File | Severity | Note |',
      '| ---- | -------- | ---- |',
      '| a.ts | high | guard the input |',
      '| b.ts | low | rename `x` |',
      '',
      'Ship after the a.ts fix.'
    ].join('\n')
    expect(assessReviewQuality(review, { kind: 'agent' }).level).toBe('ok')
  })

  it('never flags tool runs (their reliability is the parser’s job)', () => {
    expect(assessReviewQuality('', { kind: 'tool' })).toEqual({ level: 'ok', reasons: [] })
    expect(assessReviewQuality('[]', { kind: 'tool' }).level).toBe('ok')
  })

  it('can return multiple reasons', () => {
    const q = assessReviewQuality('[aerie] output truncated at 10 bytes', { kind: 'agent' })
    // short + truncated + aerie-sentinel can all apply
    expect(q.level).toBe('low')
    expect(q.reasons.length).toBeGreaterThanOrEqual(2)
  })
})
