// The automation POLLER (ROADMAP M9a): a single self-rescheduling timer that, each tick,
// derives the watches for the enabled pipelines, polls the due ones for a new head
// (`pollCommitHead` — ETag-cheap), and on a change drives `processDelta` through the live
// engine ports. Pure decisions live in `pollerLogic.ts`; this file owns the electron-bound
// timer, network/store calls, and lifecycle. Started after the store is ready and stopped on
// quit (teardown clears the timer + disposes the engine ports, and never starts a run during
// shutdown). SPEC §10: pipelines are user-run/scheduled — this is a local poll loop, not a
// webhook; every GitHub write stays behind the per-pipeline auto-post opt-in.

import { pollCommitHead } from './github'
import { log } from './logger'
import { buildEnginePorts, loadEnabledPipelines } from './pipelineEngine'
import { planNextPollAt } from './pipelinePlan'
import { processDelta, type EnginePorts } from './pipelines'
import {
  buildCommitDelta,
  deriveWatches,
  matchingPipelines,
  selectDueWatches,
  watchKey,
  DELTA_META,
  type RepoInfo,
  type WatchSpec
} from './pollerLogic'
import { getRepoById } from './store'

const BASE_INTERVAL_MS = 60_000
const MAX_INTERVAL_MS = 15 * 60_000
// No watches yet (e.g. no pipelines) → re-check later in case one was added.
const IDLE_INTERVAL_MS = 5 * 60_000
const MAX_CONCURRENT_POLLS = 8
const JITTER_RATIO = 0.1

let timer: NodeJS.Timeout | null = null
let engine: { ports: EnginePorts; dispose: () => void } | null = null
let stopped = true
/** watchKey → next-poll epoch ms; persists across ticks. */
const schedule = new Map<string, number>()

function repoInfo(repoId: number): RepoInfo | null {
  const r = getRepoById(repoId)
  if (!r) return null
  return {
    id: r.id,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    accountId: r.account_id
  }
}

/** Starts the poll loop (idempotent). Builds the engine ports it drives. */
export function startPoller(): void {
  if (!stopped) return
  stopped = false
  engine = buildEnginePorts()
  schedule.clear()
  log.info('poller started')
  armTimer(0)
}

/** Stops the loop: clears the timer, disposes the engine ports, and blocks further runs. */
export function stopPoller(): void {
  if (stopped) return
  stopped = true
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  engine?.dispose()
  engine = null
  schedule.clear()
  log.info('poller stopped')
}

function armTimer(delayMs: number): void {
  if (stopped) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void tick(), Math.max(0, delayMs))
}

async function tick(): Promise<void> {
  if (stopped || !engine) return
  const ports = engine.ports

  let pipelines: ReturnType<typeof loadEnabledPipelines>
  let watches: WatchSpec[]
  try {
    pipelines = loadEnabledPipelines()
    watches = deriveWatches(pipelines, repoInfo)
  } catch (err) {
    log.error('poller: failed to derive watches', { error: String(err) })
    armTimer(IDLE_INTERVAL_MS)
    return
  }

  // Everything after the (already-guarded) derive runs in a try/finally so the loop is
  // STRUCTURALLY self-healing: `armNextTick` always re-arms, even if a future edit makes the
  // prune/select section throw — the loop can never silently die.
  try {
    // Drop schedule entries for watches that no longer exist (pipeline removed/disabled).
    const liveKeys = new Set(watches.map(watchKey))
    for (const k of [...schedule.keys()]) if (!liveKeys.has(k)) schedule.delete(k)

    const due = selectDueWatches(watches, (k) => schedule.get(k), Date.now(), MAX_CONCURRENT_POLLS)
    for (const watch of due) {
      if (stopped) return // a quit during the tick: do not start new work
      // throughput: due watches are processed serially (one long agent run blocks the rest);
      // parallelizing is a post-v1 follow-up — serial keeps the no-double-run guarantee simple.
      try {
        const result = await pollCommitHead(
          watch.accountId,
          watch.repoId,
          watch.repoFullName,
          watch.ref
        )
        schedule.set(
          watchKey(watch),
          planNextPollAt({
            rate: result.rate,
            nowMs: Date.now(),
            baseIntervalMs: BASE_INTERVAL_MS,
            maxIntervalMs: MAX_INTERVAL_MS,
            jitterRatio: JITTER_RATIO,
            rand: Math.random()
          })
        )
        // Await the full pipeline run before moving on. A successfully processed head has its
        // last_seen advanced (in `processDelta`) and its next poll scheduled ≥BASE out, so it
        // won't re-run. On a pipeline error `processDelta` deliberately does NOT advance
        // last_seen, so the same head is re-detected next cycle — that retry is safe because
        // the engine's dedupe gate skips any already-completed identical work (no double write).
        if (result.changed && result.headSha && !stopped) {
          const delta = buildCommitDelta(watch, result.headSha, DELTA_META)
          await processDelta(matchingPipelines(pipelines, watch), delta, ports)
        }
      } catch (err) {
        log.warn('poller: poll failed', {
          repo: watch.repoFullName,
          ref: watch.ref,
          error: String(err)
        })
        schedule.set(watchKey(watch), Date.now() + BASE_INTERVAL_MS) // back off, retry later
      }
    }
  } catch (err) {
    log.error('poller: tick failed', { error: String(err) })
  } finally {
    armNextTick(watches)
  }
}

/** Schedules the next tick at the soonest upcoming poll, or an idle interval if no watches. */
function armNextTick(watches: WatchSpec[]): void {
  if (stopped) return
  if (watches.length === 0) {
    armTimer(IDLE_INTERVAL_MS)
    return
  }
  const now = Date.now()
  let soonest = Infinity
  for (const watch of watches) soonest = Math.min(soonest, schedule.get(watchKey(watch)) ?? now)
  armTimer((Number.isFinite(soonest) ? soonest : now + IDLE_INTERVAL_MS) - now)
}
