// Pure request-shaping + validation for the pipelines IPC surface (ROADMAP M9a).
// Electron-free + unit-tested: validate an incoming save request before it touches the
// store, and shape store rows into the renderer DTOs. The IPC handlers in `ipc.ts` stay a
// thin guard + store-call layer over these.

import type { Pipeline, PipelineDraft, PipelineRunSummary, PipelineWithRuns } from '../shared/types'
import { parsePipelineRow, stripDangerousKeys } from './pipelineEngineLogic'
import { isPipelineDraft } from './pipelineModel'
import type { WatchSpec } from './pollerLogic'
import type { PipelineRow, PipelineRunRow, RepoRow } from './store'

export interface ValidatedSave {
  /** Non-null = update that pipeline; null = insert a new one. */
  id: number | null
  draft: PipelineDraft
}

/**
 * Validates a `pipelines:save` request from the renderer. The draft must pass
 * `isPipelineDraft` (so a malformed/forged config is rejected before persistence); the
 * optional `id` must be a positive integer. The renderer MAY propose `action.autoPost:true`
 * — that only persists the config; the engine's `assertMayPost` still gates any actual write.
 */
export function validateSaveRequest(
  input: unknown
): { ok: true; value: ValidatedSave } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'Invalid pipeline request.' }
  }
  const req = input as { id?: unknown; draft?: unknown }
  let id: number | null = null
  if (req.id !== undefined && req.id !== null) {
    if (typeof req.id !== 'number' || !Number.isInteger(req.id) || req.id <= 0) {
      return { ok: false, error: 'Invalid pipeline id.' }
    }
    id = req.id
  }
  if (!isPipelineDraft(req.draft)) {
    return { ok: false, error: 'Invalid pipeline configuration.' }
  }
  // Strip any forged prototype keys before the draft is persisted (defense-in-depth — the
  // engine also strips on read, but this keeps the DB clean at the write boundary too).
  return { ok: true, value: { id, draft: stripDangerousKeys(req.draft) } }
}

/** Shapes a `pipeline_runs` row into the renderer DTO (snake → camel, posted → boolean). */
export function rowToRunSummary(row: PipelineRunRow): PipelineRunSummary {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    trigger: row.trigger,
    refType: row.ref_type,
    ref: row.ref,
    headSha: row.head_sha,
    status: row.status,
    action: row.action,
    posted: row.posted === 1,
    dedupeKey: row.dedupe_key,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  }
}

/**
 * Shapes a pipeline row + its recent runs into the `pipelines:list` DTO. Returns null when
 * the persisted `config` is unparseable/invalid (a corrupt row is skipped, never surfaced as
 * a half-built pipeline).
 */
export function toPipelineWithRuns(
  row: PipelineRow,
  runs: PipelineRunRow[],
  repoFullName: string | null
): PipelineWithRuns | null {
  const pipeline = parsePipelineRow(row)
  if (!pipeline) return null
  return { pipeline, repoFullName, runs: runs.map(rowToRunSummary) }
}

/**
 * Resolves whether a pipeline can be run manually (run-now / dry-run) and the commit watch
 * spec to run it against. Currently supports commit-trigger pipelines on the repo's default
 * branch; the repo must be one the user has added (so the account is authorized) and have a
 * default branch. The handler then resolves that branch's current head and runs one pass.
 */
export function planManualRun(
  pipeline: Pipeline,
  repo: RepoRow | undefined
): { ok: true; spec: WatchSpec } | { ok: false; error: string } {
  if (pipeline.trigger !== 'commit') {
    return { ok: false, error: 'Run-now currently supports commit-trigger pipelines.' }
  }
  if (!repo) return { ok: false, error: 'Unknown repository.' }
  if (!repo.default_branch) return { ok: false, error: 'Repository has no default branch.' }
  return {
    ok: true,
    spec: {
      repoId: repo.id,
      accountId: repo.account_id,
      repoFullName: repo.full_name,
      refType: 'commit',
      ref: repo.default_branch
    }
  }
}
