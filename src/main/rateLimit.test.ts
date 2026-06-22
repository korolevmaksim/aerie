import { describe, expect, it } from 'vitest'
import { nextPollDelayMs, parseRateLimit, type RateLimit } from './rateLimit'

describe('parseRateLimit', () => {
  it('reads the x-ratelimit headers and normalizes reset to ms', () => {
    const rate = parseRateLimit({
      'x-ratelimit-remaining': '4998',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-reset': '1700000000'
    })
    expect(rate).toEqual({ remaining: 4998, limit: 5000, resetAt: 1700000000 * 1000 })
  })

  it('accepts numeric header values too', () => {
    const rate = parseRateLimit({ 'x-ratelimit-remaining': 10, 'x-ratelimit-limit': 5000 })
    expect(rate.remaining).toBe(10)
    expect(rate.limit).toBe(5000)
  })

  it('returns nulls for absent or unparseable headers', () => {
    expect(parseRateLimit(undefined)).toEqual({ remaining: null, limit: null, resetAt: null })
    expect(parseRateLimit({ 'x-ratelimit-remaining': 'n/a' }).remaining).toBeNull()
  })
})

describe('nextPollDelayMs', () => {
  const base = 60_000
  const max = 600_000
  const make = (
    remaining: number | null,
    limit: number | null,
    resetAt: number | null
  ): RateLimit => ({
    remaining,
    limit,
    resetAt
  })
  const delay = (rate: RateLimit, nowMs = 0): number =>
    nextPollDelayMs({ rate, nowMs, baseIntervalMs: base, maxIntervalMs: max })

  it('uses the base cadence on a healthy budget', () => {
    expect(delay(make(4999, 5000, null))).toBe(base)
    expect(delay(make(2000, 5000, null))).toBe(base) // ratio 0.4 still healthy
  })

  it('backs off exponentially as the budget shrinks', () => {
    expect(delay(make(1000, 5000, null))).toBe(base * 2) // ratio 0.20 < 0.25
    expect(delay(make(400, 5000, null))).toBe(base * 4) // ratio 0.08 < 0.10
    expect(delay(make(100, 5000, null))).toBe(base * 8) // ratio 0.02 < 0.05
  })

  it('clamps budget-driven backoff to maxInterval', () => {
    // base 200_000 × 8 = 1_600_000 → clamped to max.
    expect(
      nextPollDelayMs({
        rate: make(100, 5000, null),
        nowMs: 0,
        baseIntervalMs: 200_000,
        maxIntervalMs: max
      })
    ).toBe(max)
  })

  it('parks until reset when the budget is exhausted (even past maxInterval)', () => {
    const resetAt = 3_600_000 // 1h out from now=0
    expect(delay(make(0, 5000, resetAt))).toBe(resetAt) // exceeds max on purpose
  })

  it('floors a past/near reset at the base interval', () => {
    expect(delay(make(0, 5000, 10_000), 50_000)).toBe(base) // reset already passed
  })

  it('falls back to maxInterval when exhausted with no known reset', () => {
    expect(delay(make(0, 5000, null))).toBe(max)
  })

  it('keeps the base cadence when the budget is unknown', () => {
    expect(delay(make(null, null, null))).toBe(base)
    expect(delay(make(5, null, null))).toBe(base) // limit unknown → no ratio
  })
})
