import { describe, it, expect } from 'vitest'
import { formatRelativeTime } from './format'

const NOW = Date.parse('2026-06-21T12:00:00Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('formatRelativeTime', () => {
  it('handles null and invalid input', () => {
    expect(formatRelativeTime(null, NOW)).toBe('—')
    expect(formatRelativeTime('not-a-date', NOW)).toBe('—')
  })
  it('buckets recent times', () => {
    expect(formatRelativeTime(ago(10 * SEC), NOW)).toBe('just now')
    expect(formatRelativeTime(ago(5 * MIN), NOW)).toBe('5m ago')
    expect(formatRelativeTime(ago(3 * HOUR), NOW)).toBe('3h ago')
    expect(formatRelativeTime(ago(2 * DAY), NOW)).toBe('2d ago')
  })
  it('buckets months and years', () => {
    expect(formatRelativeTime(ago(60 * DAY), NOW)).toBe('2mo ago')
    expect(formatRelativeTime(ago(400 * DAY), NOW)).toBe('1y ago')
  })
})
