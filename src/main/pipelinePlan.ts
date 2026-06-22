// Pure pipeline orchestration logic (ROADMAP M9a engine slice). Electron-free +
// unit-tested — the engine's "brain": resolve step dependencies into execution waves
// (the wait-for-all barrier ordering), decide guardrail eligibility, and pace polling
// (rate-backoff + jitter, relative-to-now so a wake from sleep can't burst). The live
// poller/engine wiring (timers, startRun, runEvents) consumes these in the next slice.

import type { PipelineGuardrails, PipelineStep } from '../shared/types'
import { nextPollDelayMs, type RateLimit } from './rateLimit'

// --- step wave planning (the wait-for-all-steps barrier ordering) ------------

export interface PlannedWaves {
  /** Step ids grouped into ordered waves; every wave runs in parallel, fully drains
   *  (the barrier) before the next starts. Empty when `ok` is false. */
  waves: string[][]
  ok: boolean
  error?: string
}

/**
 * Resolves `dependsOn` into ordered parallel waves via Kahn-style layering: wave 0 is
 * the steps with no dependencies, wave N the steps whose deps all landed in waves < N.
 * Within a wave, steps keep their input-array order. Fails (ok:false) on a duplicate step
 * id, a `dependsOn` referencing an unknown id, a self-dependency, or a cycle.
 *
 * NOTE: this is the ONLY dependency-graph validator — `isPipelineDraft` checks per-step
 * shape only, not the graph. The engine MUST check `planWaves(steps).ok` (and surface
 * `error`) before starting any run, so an unsatisfiable plan never partially executes.
 */
export function planWaves(steps: PipelineStep[]): PlannedWaves {
  const ids = new Set<string>()
  for (const s of steps) {
    if (ids.has(s.id)) return { waves: [], ok: false, error: `duplicate step id: ${s.id}` }
    ids.add(s.id)
  }
  for (const s of steps) {
    for (const dep of s.dependsOn ?? []) {
      if (dep === s.id) return { waves: [], ok: false, error: `step ${s.id} depends on itself` }
      if (!ids.has(dep)) {
        return { waves: [], ok: false, error: `step ${s.id} depends on unknown id: ${dep}` }
      }
    }
  }

  const placed = new Set<string>()
  const waves: string[][] = []
  let remaining = steps.slice()
  while (remaining.length > 0) {
    const ready = remaining.filter((s) => (s.dependsOn ?? []).every((d) => placed.has(d)))
    if (ready.length === 0) {
      return { waves: [], ok: false, error: 'dependency cycle among steps' }
    }
    waves.push(ready.map((s) => s.id))
    for (const s of ready) placed.add(s.id)
    remaining = remaining.filter((s) => !placed.has(s.id))
  }
  return { waves, ok: true }
}

// --- guardrail eligibility ----------------------------------------------------

export interface GuardrailState {
  nowMs: number
  /** Most recent run-start (any pipeline) for this repo, or null if none. */
  lastRepoRunStartedAtMs: number | null
  /** Run-start timestamps for this pipeline within the trailing hour. */
  pipelineRunStartsLastHourMs: number[]
  /** Runs this pipeline currently has active (queued/running). */
  activeRunCount: number
}

export interface GuardrailDecision {
  allowed: boolean
  reason?: 'concurrency' | 'cooldown' | 'rate'
  /** When known, how long until a retry could pass (cooldown/rate); absent for concurrency
   *  (retry when a slot frees, event-driven not time-driven). */
  retryAfterMs?: number
}

const HOUR_MS = 60 * 60 * 1000

/**
 * Whether a pipeline may start a run NOW given its guardrails + recent activity. Checks,
 * in order: concurrency cap (active runs), per-repo cooldown, and runs-per-hour. An absent
 * or non-positive guardrail is disabled. Returns the first failing reason (with a retry
 * delay where time-bounded) or `{allowed:true}`. Callers pass guardrails already validated
 * by `isPipelineDraft` (finite, non-negative) — a NaN/negative would read as "disabled".
 */
export function checkGuardrails(g: PipelineGuardrails, s: GuardrailState): GuardrailDecision {
  if (g.maxConcurrentRuns && g.maxConcurrentRuns > 0 && s.activeRunCount >= g.maxConcurrentRuns) {
    return { allowed: false, reason: 'concurrency' }
  }

  if (
    g.perRepoCooldownSeconds &&
    g.perRepoCooldownSeconds > 0 &&
    s.lastRepoRunStartedAtMs !== null
  ) {
    const cooldownMs = g.perRepoCooldownSeconds * 1000
    const elapsed = s.nowMs - s.lastRepoRunStartedAtMs
    if (elapsed < cooldownMs) {
      return { allowed: false, reason: 'cooldown', retryAfterMs: cooldownMs - elapsed }
    }
  }

  if (g.maxRunsPerHour && g.maxRunsPerHour > 0) {
    const inWindow = s.pipelineRunStartsLastHourMs.filter((t) => s.nowMs - t < HOUR_MS)
    if (inWindow.length >= g.maxRunsPerHour) {
      const oldest = Math.min(...inWindow)
      return { allowed: false, reason: 'rate', retryAfterMs: oldest + HOUR_MS - s.nowMs }
    }
  }

  return { allowed: true }
}

// --- poll scheduling (rate-backoff + jitter, relative to now) ----------------

/**
 * Spreads a delay by ±`jitterRatio` using an injected `rand` in [0,1) (so the poller's
 * many watches don't fire in lockstep). `rand=0.5` is no change; 0 is −ratio, ~1 is +ratio.
 * Never returns below 0.
 */
export function applyJitter(delayMs: number, jitterRatio: number, rand: number): number {
  if (jitterRatio <= 0) return delayMs
  const clampedRand = Math.min(1, Math.max(0, rand))
  const factor = 1 + (clampedRand * 2 - 1) * jitterRatio
  return Math.max(0, delayMs * factor)
}

export interface PollPlanInput {
  rate: RateLimit
  nowMs: number
  baseIntervalMs: number
  maxIntervalMs: number
  /** Spread factor (e.g. 0.1 = ±10%); 0 disables jitter. */
  jitterRatio: number
  /** Injected randomness in [0,1) (the engine passes Math.random()). */
  rand: number
}

/**
 * The epoch-ms timestamp for a watch's NEXT poll: the rate-aware backoff delay
 * (`nextPollDelayMs`) jittered, added to `nowMs`. Always relative to now, so a wake from
 * sleep schedules one future poll rather than replaying every missed deadline (no
 * catch-up burst). When the budget is exhausted (`remaining<=0`) the result is floored at
 * the reset deadline — jitter must never pull a poll BEFORE the reset (that only 403s).
 * Callers pass validated, finite, non-negative intervals.
 */
export function planNextPollAt(input: PollPlanInput): number {
  const delay = nextPollDelayMs({
    rate: input.rate,
    nowMs: input.nowMs,
    baseIntervalMs: input.baseIntervalMs,
    maxIntervalMs: input.maxIntervalMs
  })
  const at = input.nowMs + applyJitter(delay, input.jitterRatio, input.rand)
  if (input.rate.remaining !== null && input.rate.remaining <= 0 && input.rate.resetAt !== null) {
    return Math.max(at, input.rate.resetAt)
  }
  return at
}

// --- global poll budget -------------------------------------------------------

export interface DueWatch {
  id: number
  nextPollAtMs: number
}

/**
 * Selects which watches to poll this tick: those due (`nextPollAtMs <= now`), soonest
 * first, capped at `maxConcurrent` (the global poll budget across many watches). A
 * non-positive cap means no limit. Ties on equal `nextPollAtMs` keep input order (stable).
 */
export function selectDuePolls(
  watches: DueWatch[],
  nowMs: number,
  maxConcurrent: number
): number[] {
  const due = watches
    .filter((w) => w.nextPollAtMs <= nowMs)
    .sort((a, b) => a.nextPollAtMs - b.nextPollAtMs)
    .map((w) => w.id)
  return maxConcurrent > 0 ? due.slice(0, maxConcurrent) : due
}
