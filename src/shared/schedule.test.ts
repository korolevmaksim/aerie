import { describe, expect, it } from 'vitest'
import { formatSchedule, MIN_SCHEDULE_MS, parseScheduleMs, parseScheduleParts } from './schedule'

describe('parseScheduleMs', () => {
  it('parses minutes, hours, days', () => {
    expect(parseScheduleMs('30m')).toBe(30 * 60_000)
    expect(parseScheduleMs('6h')).toBe(6 * 3_600_000)
    expect(parseScheduleMs('2d')).toBe(2 * 86_400_000)
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseScheduleMs('  6h ')).toBe(6 * 3_600_000)
  })

  it('returns null for absent / malformed input', () => {
    for (const bad of [undefined, null, '', 'h', '6', '6w', '6 h h', 'abc', '-3h', '0h']) {
      expect(parseScheduleMs(bad as string)).toBeNull()
    }
  })

  it('rejects below the 1-minute floor (but accepts exactly 1m)', () => {
    expect(parseScheduleMs('1m')).toBe(MIN_SCHEDULE_MS)
    // there is no sub-minute unit, so the floor is only reachable via the unit itself; 0m is invalid
    expect(parseScheduleMs('0m')).toBeNull()
  })
})

describe('formatSchedule / parseScheduleParts round-trip', () => {
  it('builds the canonical string', () => {
    expect(formatSchedule(30, 'm')).toBe('30m')
    expect(formatSchedule(6, 'h')).toBe('6h')
    expect(formatSchedule(2, 'd')).toBe('2d')
  })

  it('splits a stored string back into parts', () => {
    expect(parseScheduleParts('30m')).toEqual({ every: 30, unit: 'm' })
    expect(parseScheduleParts('2d')).toEqual({ every: 2, unit: 'd' })
  })

  it('round-trips', () => {
    for (const [n, u] of [
      [30, 'm'],
      [6, 'h'],
      [2, 'd']
    ] as const) {
      expect(parseScheduleParts(formatSchedule(n, u))).toEqual({ every: n, unit: u })
    }
  })

  it('falls back to a default (6h) for absent/invalid input', () => {
    expect(parseScheduleParts(undefined)).toEqual({ every: 6, unit: 'h' })
    expect(parseScheduleParts('garbage')).toEqual({ every: 6, unit: 'h' })
  })
})
