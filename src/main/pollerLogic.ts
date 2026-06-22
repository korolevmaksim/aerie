// Pure poll-cycle logic for the automation poller (ROADMAP M9a). Electron-free +
// unit-tested: derive the watch set from the enabled pipelines, pick which watches are due
// this tick, build the commit delta, and select the pipelines a delta applies to. The
// electron-bound timer + pollCommitHead + processDelta wiring lives in `poller.ts`.

import type { Pipeline } from '../shared/types'
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
}

/** Stable schedule key for a watch — `<repoId>:<refType>:<ref>`. */
export function watchKey(spec: { repoId: number; refType: string; ref: string }): string {
  return `${spec.repoId}:${spec.refType}:${spec.ref}`
}

/**
 * Derives the unique commit-branch watches for the enabled pipelines. A commit-trigger
 * pipeline watches its repo's default branch; a pipeline whose repo is missing or has no
 * default branch is skipped. PR/schedule/manual triggers produce no watches in this slice.
 * Deduped by (repo, ref) so several pipelines on one repo share a single watch.
 */
export function deriveWatches(
  pipelines: Pipeline[],
  repoInfo: (repoId: number) => RepoInfo | null
): WatchSpec[] {
  const byKey = new Map<string, WatchSpec>()
  for (const p of pipelines) {
    if (p.trigger !== 'commit') continue
    const repo = repoInfo(p.repoId)
    if (!repo || !repo.defaultBranch) continue
    const spec: WatchSpec = {
      repoId: repo.id,
      accountId: repo.accountId,
      repoFullName: repo.fullName,
      refType: 'commit',
      ref: repo.defaultBranch
    }
    byKey.set(watchKey(spec), spec)
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

/** The enabled pipelines a watch's delta applies to (its repo + a commit trigger). */
export function matchingPipelines(pipelines: Pipeline[], spec: WatchSpec): Pipeline[] {
  return pipelines.filter((p) => p.trigger === 'commit' && p.repoId === spec.repoId)
}
