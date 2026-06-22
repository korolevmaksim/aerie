// Multi-agent fan-out planning (ROADMAP M8/M9 — first slice). Pure helper that turns
// a requested set of agent ids into the runnable set, deciding which to start and which
// to skip. The orchestration (starting the correlated runs) lives in the runner; this is
// the electron-free, unit-tested decision logic so the cap/dedup/eligibility rules are
// pinned. Concurrency is still bounded downstream by the run semaphore.

/** Max agents one fan-out may launch — a guard against an accidental huge batch. */
export const MAX_BATCH_AGENTS = 8

export interface BatchPlan {
  /** Agent ids to actually start, in request order, de-duplicated and capped. */
  run: string[]
  /** Requested ids that won't start, with why (not eligible, duplicate-collapsed away, or over the cap). */
  skipped: { id: string; reason: 'not-eligible' | 'over-cap' }[]
}

/**
 * Decide which requested agents to run. `eligible` is the set of agent ids that are
 * installed/available (the caller derives it). Unknown/not-installed ids are skipped
 * (not-eligible); duplicates collapse to the first occurrence; anything past
 * `max` eligible ids is skipped (over-cap). Order is preserved.
 */
export function planBatch(
  requested: string[],
  eligible: ReadonlySet<string>,
  max: number = MAX_BATCH_AGENTS
): BatchPlan {
  const run: string[] = []
  const skipped: BatchPlan['skipped'] = []
  const seen = new Set<string>()
  for (const id of requested) {
    if (seen.has(id)) continue // a duplicate is silently collapsed, not "skipped"
    seen.add(id)
    if (!eligible.has(id)) {
      skipped.push({ id, reason: 'not-eligible' })
    } else if (run.length >= max) {
      skipped.push({ id, reason: 'over-cap' })
    } else {
      run.push(id)
    }
  }
  return { run, skipped }
}
