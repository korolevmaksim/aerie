// Rate-limit-aware poll pacing (ROADMAP M8). Pure, electron-free, unit-tested. The
// automation poller (M9a) calls `nextPollDelayMs` after each conditional GET so it
// widens its cadence as the GitHub primary-rate budget shrinks, and parks until the
// window resets when the budget is exhausted — never hammering toward a 403.

/** A snapshot of the GitHub primary rate-limit headers (`x-ratelimit-*`). */
export interface RateLimit {
  /** Calls left in the current window, or null if the header was absent/unparseable. */
  remaining: number | null
  /** The window's ceiling (e.g. 5000), or null if unknown. */
  limit: number | null
  /** Epoch milliseconds when the window resets, or null if unknown. */
  resetAt: number | null
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * Reads the primary rate-limit budget from a response's headers. GitHub reports
 * `x-ratelimit-reset` in epoch SECONDS; we normalize it to milliseconds so callers
 * can compare against `Date.now()` directly. A 304 (conditional hit) still carries
 * these headers, so the poller always learns the current budget — even for free hits.
 */
export function parseRateLimit(headers: Record<string, unknown> | undefined): RateLimit {
  const h = headers ?? {}
  const resetSec = num(h['x-ratelimit-reset'])
  return {
    remaining: num(h['x-ratelimit-remaining']),
    limit: num(h['x-ratelimit-limit']),
    resetAt: resetSec === null ? null : resetSec * 1000
  }
}

export interface BackoffOptions {
  rate: RateLimit
  /** Current time in epoch ms (injected so the function stays pure/testable). */
  nowMs: number
  /** The healthy-budget cadence (also the floor for every returned delay). */
  baseIntervalMs: number
  /** The cap for budget-driven backoff (a reset-wait may legitimately exceed it). */
  maxIntervalMs: number
}

/**
 * How long to wait before the next poll, from the rate-limit headroom:
 * - healthy budget (or unknown) → `baseIntervalMs`;
 * - as `remaining/limit` drops, back off exponentially (×2 → ×4 → ×8) toward
 *   `maxIntervalMs`;
 * - exhausted (`remaining <= 0`) → park until the window resets (`resetAt - now`),
 *   which can exceed `maxIntervalMs` since polling sooner only yields 403s.
 * Always at least `baseIntervalMs`.
 */
export function nextPollDelayMs(opts: BackoffOptions): number {
  const { rate, nowMs, baseIntervalMs, maxIntervalMs } = opts

  // Exhausted: a poll before reset just 403s, so honor the reset even past maxInterval.
  if (rate.remaining !== null && rate.remaining <= 0) {
    if (rate.resetAt !== null) return Math.max(baseIntervalMs, rate.resetAt - nowMs)
    return maxIntervalMs
  }

  // Unknown budget → keep the base cadence rather than guessing a backoff.
  if (rate.remaining === null || rate.limit === null || rate.limit <= 0) {
    return baseIntervalMs
  }

  const ratio = rate.remaining / rate.limit
  let factor = 1
  if (ratio < 0.05) factor = 8
  else if (ratio < 0.1) factor = 4
  else if (ratio < 0.25) factor = 2
  return Math.min(maxIntervalMs, Math.max(baseIntervalMs, baseIntervalMs * factor))
}
