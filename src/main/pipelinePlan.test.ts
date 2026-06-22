import { describe, expect, it } from 'vitest'
import type { PipelineGuardrails, PipelineStep } from '../shared/types'
import {
  applyJitter,
  checkGuardrails,
  planNextPollAt,
  planWaves,
  selectDuePolls,
  type GuardrailState
} from './pipelinePlan'
import type { RateLimit } from './rateLimit'

const step = (id: string, dependsOn?: string[]): PipelineStep => ({
  id,
  kind: 'agent',
  ref: 'codex',
  ...(dependsOn ? { dependsOn } : {})
})

describe('planWaves', () => {
  it('puts independent steps in one wave', () => {
    const r = planWaves([step('a'), step('b'), step('c')])
    expect(r.ok).toBe(true)
    expect(r.waves).toEqual([['a', 'b', 'c']])
  })

  it('layers dependencies into ordered waves', () => {
    const r = planWaves([step('c', ['a', 'b']), step('a'), step('b'), step('d', ['c'])])
    expect(r.ok).toBe(true)
    expect(r.waves).toEqual([['a', 'b'], ['c'], ['d']])
  })

  it('layers a diamond a→{b,c}→d so the join waits for BOTH parents', () => {
    // d depends on b AND c, which both depend on a. b/c must fully drain before d.
    const r = planWaves([step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])])
    expect(r.ok).toBe(true)
    expect(r.waves).toEqual([['a'], ['b', 'c'], ['d']])
  })

  it('keeps input order within a wave even when input is scrambled', () => {
    const r = planWaves([step('d', ['b', 'c']), step('c', ['a']), step('b', ['a']), step('a')])
    expect(r.ok).toBe(true)
    expect(r.waves).toEqual([['a'], ['c', 'b'], ['d']]) // wave order follows input array
  })

  it('handles an empty step list', () => {
    expect(planWaves([])).toEqual({ waves: [], ok: true })
  })

  it('fails on a duplicate step id', () => {
    const r = planWaves([step('a'), step('a')])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/duplicate/)
  })

  it('fails on an unknown dependency', () => {
    const r = planWaves([step('a', ['ghost'])])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unknown id/)
  })

  it('fails on a self-dependency', () => {
    const r = planWaves([step('a', ['a'])])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/itself/)
  })

  it('fails on a cycle', () => {
    const r = planWaves([step('a', ['b']), step('b', ['a'])])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/cycle/)
  })
})

describe('checkGuardrails', () => {
  const baseState = (over: Partial<GuardrailState> = {}): GuardrailState => ({
    nowMs: 1_000_000,
    lastRepoRunStartedAtMs: null,
    pipelineRunStartsLastHourMs: [],
    activeRunCount: 0,
    ...over
  })

  it('allows when no guardrails are set', () => {
    expect(checkGuardrails({}, baseState())).toEqual({ allowed: true })
  })

  it('blocks on the concurrency cap (no retry delay — slot-driven)', () => {
    const g: PipelineGuardrails = { maxConcurrentRuns: 2 }
    expect(checkGuardrails(g, baseState({ activeRunCount: 2 }))).toEqual({
      allowed: false,
      reason: 'concurrency'
    })
    expect(checkGuardrails(g, baseState({ activeRunCount: 1 })).allowed).toBe(true)
  })

  it('blocks within the per-repo cooldown and reports the remaining wait', () => {
    const g: PipelineGuardrails = { perRepoCooldownSeconds: 60 }
    const d = checkGuardrails(g, baseState({ lastRepoRunStartedAtMs: 1_000_000 - 20_000 }))
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('cooldown')
    expect(d.retryAfterMs).toBe(40_000) // 60s - 20s
    // Past the cooldown → allowed.
    expect(
      checkGuardrails(g, baseState({ lastRepoRunStartedAtMs: 1_000_000 - 61_000 })).allowed
    ).toBe(true)
  })

  it('blocks on runs-per-hour and reports when the window frees', () => {
    const g: PipelineGuardrails = { maxRunsPerHour: 2 }
    const now = 1_000_000
    // Two starts inside the trailing hour → blocked; oldest at now-30min frees in 30min.
    const d = checkGuardrails(
      g,
      baseState({ nowMs: now, pipelineRunStartsLastHourMs: [now - 30 * 60_000, now - 10 * 60_000] })
    )
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('rate')
    expect(d.retryAfterMs).toBe(30 * 60_000)
    // A start older than an hour falls out of the window → allowed.
    expect(
      checkGuardrails(
        g,
        baseState({
          nowMs: now,
          pipelineRunStartsLastHourMs: [now - 61 * 60_000, now - 5 * 60_000]
        })
      ).allowed
    ).toBe(true)
  })

  it('checks concurrency before cooldown before rate', () => {
    const g: PipelineGuardrails = { maxConcurrentRuns: 1, perRepoCooldownSeconds: 60 }
    const d = checkGuardrails(
      g,
      baseState({ activeRunCount: 1, lastRepoRunStartedAtMs: 1_000_000 - 1000 })
    )
    expect(d.reason).toBe('concurrency') // concurrency wins the order
  })

  it('treats the exact boundaries correctly (cooldown elapsed===window allowed; run exactly 1h old excluded)', () => {
    // elapsed === cooldownMs → allowed (strict `<`).
    expect(
      checkGuardrails(
        { perRepoCooldownSeconds: 60 },
        baseState({ lastRepoRunStartedAtMs: 1_000_000 - 60_000 })
      ).allowed
    ).toBe(true)
    const now = 1_000_000
    // A start exactly HOUR_MS old is out of the window (strict `<`), so only 1 in-window < cap 2.
    expect(
      checkGuardrails(
        { maxRunsPerHour: 2 },
        baseState({ nowMs: now, pipelineRunStartsLastHourMs: [now - 60 * 60_000, now - 1000] })
      ).allowed
    ).toBe(true)
    // inWindow.length === cap → blocked (`>=`).
    expect(
      checkGuardrails(
        { maxRunsPerHour: 1 },
        baseState({ nowMs: now, pipelineRunStartsLastHourMs: [now - 1000] })
      ).allowed
    ).toBe(false)
  })
})

describe('applyJitter', () => {
  it('rand=0.5 is no change; 0 is -ratio; ~1 is +ratio', () => {
    expect(applyJitter(1000, 0.1, 0.5)).toBe(1000)
    expect(applyJitter(1000, 0.1, 0)).toBeCloseTo(900)
    expect(applyJitter(1000, 0.1, 1)).toBeCloseTo(1100)
  })

  it('disabled when ratio <= 0 and never negative', () => {
    expect(applyJitter(1000, 0, 0)).toBe(1000)
    expect(applyJitter(1000, 0.5, 0)).toBe(500)
    expect(applyJitter(1000, 2, 0)).toBe(0) // would be -1000 → clamped to 0
  })

  it('clamps an out-of-range rand to [0,1]', () => {
    expect(applyJitter(1000, 0.1, 1.5)).toBeCloseTo(1100) // rand>1 → treated as 1
    expect(applyJitter(1000, 0.1, -1)).toBeCloseTo(900) // rand<0 → treated as 0
  })
})

describe('planNextPollAt', () => {
  const rate = (
    remaining: number | null,
    limit: number | null,
    resetAt: number | null = null
  ): RateLimit => ({
    remaining,
    limit,
    resetAt
  })

  it('is always in the future relative to now (no catch-up burst)', () => {
    const at = planNextPollAt({
      rate: rate(5000, 5000),
      nowMs: 1_000_000,
      baseIntervalMs: 60_000,
      maxIntervalMs: 600_000,
      jitterRatio: 0,
      rand: 0.5
    })
    expect(at).toBe(1_060_000) // now + base, no jitter
  })

  it('widens with a shrinking budget and applies jitter', () => {
    const healthy = planNextPollAt({
      rate: rate(5000, 5000),
      nowMs: 0,
      baseIntervalMs: 60_000,
      maxIntervalMs: 600_000,
      jitterRatio: 0,
      rand: 0.5
    })
    const low = planNextPollAt({
      rate: rate(100, 5000), // ratio 0.02 → ×8 backoff
      nowMs: 0,
      baseIntervalMs: 60_000,
      maxIntervalMs: 600_000,
      jitterRatio: 0,
      rand: 0.5
    })
    expect(low).toBeGreaterThan(healthy)
  })

  it('never schedules before the reset when the budget is exhausted (downward jitter floored)', () => {
    const resetAt = 3_600_000 // 1h out from now=0
    const at = planNextPollAt({
      rate: rate(0, 5000, resetAt), // exhausted → park until reset
      nowMs: 0,
      baseIntervalMs: 60_000,
      maxIntervalMs: 600_000,
      jitterRatio: 0.1,
      rand: 0 // maximal DOWNWARD jitter — must NOT pull the poll before resetAt
    })
    expect(at).toBeGreaterThanOrEqual(resetAt)
  })

  it('falls back to ~maxInterval when exhausted with no known reset', () => {
    const at = planNextPollAt({
      rate: rate(0, 5000, null), // exhausted but resetAt unknown → nextPollDelayMs = maxInterval
      nowMs: 1_000_000,
      baseIntervalMs: 60_000,
      maxIntervalMs: 600_000,
      jitterRatio: 0,
      rand: 0.5
    })
    expect(at).toBe(1_600_000) // now + maxInterval, bounded (no tight loop)
  })
})

describe('selectDuePolls', () => {
  it('returns due watches soonest-first, capped by the budget', () => {
    const watches = [
      { id: 1, nextPollAtMs: 500 },
      { id: 2, nextPollAtMs: 100 },
      { id: 3, nextPollAtMs: 2000 }, // not due
      { id: 4, nextPollAtMs: 300 }
    ]
    expect(selectDuePolls(watches, 1000, 2)).toEqual([2, 4]) // soonest two due
    expect(selectDuePolls(watches, 1000, 0)).toEqual([2, 4, 1]) // 0 = no cap, all due
    expect(selectDuePolls(watches, 50, 5)).toEqual([]) // none due yet
  })
})
