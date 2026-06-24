// Pure poll-cycle logic for the automation poller (ROADMAP M9a). Electron-free +
// unit-tested: derive the watch set from the enabled pipelines, pick which watches are due
// this tick, build the commit delta, and select the pipelines a delta applies to. The
// electron-bound timer + pollCommitHead + processDelta wiring lives in `poller.ts`.

import type { Pipeline } from '../shared/types'
import { parseScheduleMs } from '../shared/schedule'
import type { DeltaContext } from './pipelines'

/** The repo facts a watch needs (resolved by the poller from the store). */
export interface RepoInfo {
  id: number
  fullName: string
  defaultBranch: string | null
  accountId: number
}

/** A branch the poller watches for new commits. (PR watches are a later slice.) */
export interface WatchSpec {
  repoId: number
  accountId: number
  repoFullName: string
  refType: 'commit'
  /** Branch name. */
  ref: string
  /**
   * Fixed poll interval in ms for a SCHEDULE-only watch (its `schedule` trigger cadence). `null`
   * means rate-based continuous polling — used when any `commit` pipeline shares this branch (the
   * faster cadence wins) or for a pure commit watch.
   */
  scheduleMs: number | null
}

/** Merge a watch's interval across contributing pipelines: a commit (null) forces rate-based; else the most frequent (min) schedule interval. */
function mergeInterval(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null
  return Math.min(a, b)
}

/** Stable schedule key for a watch — `<repoId>:<refType>:<ref>`. */
export function watchKey(spec: { repoId: number; refType: string; ref: string }): string {
  return `${spec.repoId}:${spec.refType}:${spec.ref}`
}

/**
 * Derives the unique default-branch watches for the enabled pipelines. A `commit` pipeline watches
 * its repo's default branch at the rate-based cadence; a `schedule` pipeline watches it at its own
 * fixed interval (parsed from `schedule`, e.g. "6h"); a pipeline whose repo is missing/has no
 * default branch, or a `schedule` pipeline with no valid interval, is skipped. PR/manual triggers
 * produce no watches. Deduped by (repo, ref): pipelines on one branch share a single watch, and the
 * watch's `scheduleMs` is the most-frequent cadence among them (a commit pipeline forces rate-based).
 */
export function deriveWatches(
  pipelines: Pipeline[],
  repoInfo: (repoId: number) => RepoInfo | null
): WatchSpec[] {
  const byKey = new Map<string, WatchSpec>()
  for (const p of pipelines) {
    if (p.trigger !== 'commit' && p.trigger !== 'schedule') continue
    const interval = p.trigger === 'schedule' ? parseScheduleMs(p.schedule) : null
    if (p.trigger === 'schedule' && interval === null) continue // no/invalid cadence → no watch
    const repo = repoInfo(p.repoId)
    if (!repo || !repo.defaultBranch) continue
    const spec: WatchSpec = {
      repoId: repo.id,
      accountId: repo.accountId,
      repoFullName: repo.fullName,
      refType: 'commit',
      ref: repo.defaultBranch,
      scheduleMs: interval
    }
    const key = watchKey(spec)
    const existing = byKey.get(key)
    if (existing) existing.scheduleMs = mergeInterval(existing.scheduleMs, interval)
    else byKey.set(key, spec)
  }
  return [...byKey.values()]
}

/**
 * The watches due to poll now: scheduled time `<= now` (a never-scheduled watch defaults to
 * due), soonest first, capped at `maxConcurrent` (the global poll budget; `<=0` = no cap).
 */
export function selectDueWatches(
  watches: WatchSpec[],
  scheduledAt: (key: string) => number | undefined,
  now: number,
  maxConcurrent: number
): WatchSpec[] {
  const due = watches
    .map((w) => ({ w, at: scheduledAt(watchKey(w)) ?? 0 }))
    .filter((x) => x.at <= now)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.w)
  return maxConcurrent > 0 ? due.slice(0, maxConcurrent) : due
}

export interface DeltaMeta {
  /** Tool/agent catalog version (bumping it re-runs unchanged heads). */
  catalogVersion: string
  /** Review-prompt body hash. */
  promptHash: string
}

/**
 * The delta metadata the engine dedup-keys on, shared by the poller and the run-now/dry-run
 * handlers so a manual run and an auto run on the same head produce the same dedupe key.
 * TODO(post-M9a): derive from the real tool/agent catalog + per-pipeline prompt so a catalog
 * or prompt change re-runs an unchanged head (constant for now).
 */
export const DELTA_META: DeltaMeta = { catalogVersion: '1', promptHash: '' }

/** Builds the commit `DeltaContext` for a due watch whose head moved to `headSha`. */
export function buildCommitDelta(spec: WatchSpec, headSha: string, meta: DeltaMeta): DeltaContext {
  return {
    accountId: spec.accountId,
    repoId: spec.repoId,
    refType: 'commit',
    ref: spec.ref,
    headSha,
    baseSha: null,
    scope: { branch: spec.ref },
    catalogVersion: meta.catalogVersion,
    promptHash: meta.promptHash
  }
}

/**
 * The enabled pipelines a watch's delta applies to: its repo's `commit` pipelines plus due
 * `schedule` pipelines. `dueScheduleIds` is optional for older tests/helpers; the live poller passes
 * it so a slow schedule sharing a faster watch does not run early.
 */
export function matchingPipelines(
  pipelines: Pipeline[],
  spec: WatchSpec,
  dueScheduleIds?: ReadonlySet<number>
): Pipeline[] {
  return pipelines.filter(
    (p) =>
      p.repoId === spec.repoId &&
      (p.trigger === 'commit' ||
        (p.trigger === 'schedule' &&
          parseScheduleMs(p.schedule) !== null &&
          (dueScheduleIds === undefined || dueScheduleIds.has(p.id))))
  )
}

/** The schedule pipelines on this watch whose own cadence is due now. */
export function dueSchedulePipelineIds(
  pipelines: Pipeline[],
  spec: WatchSpec,
  scheduledAt: (pipelineId: number) => number | undefined,
  now: number
): Set<number> {
  const due = new Set<number>()
  for (const p of pipelines) {
    if (p.repoId !== spec.repoId || p.trigger !== 'schedule') continue
    if (parseScheduleMs(p.schedule) === null) continue
    if ((scheduledAt(p.id) ?? 0) <= now) due.add(p.id)
  }
  return due
}

/**
 * Whether a due watch should drive the engine. Commit-diff pipelines need a new head; scheduled
 * project audits are cadence-based and intentionally re-run on the current snapshot.
 */
export function shouldProcessHead(pipelines: Pipeline[], changed: boolean): boolean {
  return changed || pipelines.some((p) => p.trigger === 'schedule' && p.reviewTarget === 'project')
}
