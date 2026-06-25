// The LIVE pipeline-engine adapter (ROADMAP M9a): binds the engine's `EnginePorts` to the
// real runner, run-event hub, M6 aggregator, store, and GitHub writers. This is the thin
// electron-bound glue — the testable decisions live in `pipelineEngineLogic.ts` (write
// dispatch, config parse, guardrail assembly) and `pipelines.ts` (the orchestration). The
// ONLY engine→GitHub write call site is `dispatchGithubWrite`, which re-asserts the auto-post
// gate before any write. Verified by the build smoke (it compiles against the real signatures).

import type { Pipeline, PipelineReviewTarget, PipelineStep } from '../shared/types'
import { assessReviewQuality } from '../shared/quality'
import { aggregateRunFindings, getRunGroupReport, readRunOutput, startRun } from './agentRunner'
import { createCommitComment, createIssue, createPrComment } from './github'
import { log } from './logger'
import {
  assembleGuardrailState,
  dispatchGithubWrite,
  parsePipelineRow,
  prNumberFromRef,
  type GithubWriters
} from './pipelineEngineLogic'
import type { DeltaContext, EnginePorts } from './pipelines'
import { createRunWaiter } from './runWaiter'
import { emitPipelineRunChange } from './pipelineEvents'
import {
  countActivePipelineRuns,
  addRunToGroup,
  findCompletedPipelineRunByDedupe,
  getPipelineRun,
  getRun,
  getRepoById,
  insertPipelineRun,
  insertRunGroup,
  lastRepoPipelineRunStart,
  listEnabledPipelineRows,
  listFindingsForRun,
  markWatchSeen,
  recentPipelineRunStarts,
  setPipelineRunGroup as linkPipelineRunGroup,
  setPipelineRunPosted,
  setRunGroupPostedUrl,
  updatePipelineRunStatus
} from './store'

const HOUR_MS = 60 * 60 * 1000

const githubWriters: GithubWriters = { createCommitComment, createPrComment, createIssue }

function isRunPostEligible(runId: number): boolean {
  const run = getRun(runId)
  if (!run || run.status !== 'done') return false
  const output = run.output_path ? readRunOutput(run.output_path) : ''
  const quality = assessReviewQuality(output, { kind: 'agent' })
  return quality.level === 'ok' || listFindingsForRun(runId).length > 0
}

/** Maps a pipeline step to a real `startRun`. Only agent steps run (tool steps are filtered
 *  out by `loadEnabledPipelines`; this guards defensively). A PR delta runs against the PR
 *  number; a commit delta against the head SHA. */
function startStep(
  step: PipelineStep,
  delta: DeltaContext,
  reviewTarget: PipelineReviewTarget
): number {
  if (step.kind !== 'agent') {
    throw new Error(`pipeline step "${step.id}": tool steps are not yet supported`)
  }
  if (reviewTarget === 'project') {
    const run = startRun({
      accountId: delta.accountId,
      repoId: delta.repoId,
      sha: delta.headSha,
      refType: 'project',
      refId: delta.ref,
      agentId: step.ref,
      model: step.model
    })
    return run.id
  }
  let refId: string
  if (delta.refType === 'pr') {
    // Fail fast (symmetric with the write side) rather than passing an empty refId that
    // would silently degrade the run to a head-only diff — the throw surfaces as
    // {ran:false, reason:'error'} and the delta is retried.
    const prNumber = prNumberFromRef(delta.ref)
    if (prNumber === null) {
      throw new Error(
        `pipeline step "${step.id}": cannot resolve a PR number from ref "${delta.ref}"`
      )
    }
    refId = String(prNumber)
  } else {
    refId = delta.headSha
  }
  const run = startRun({
    accountId: delta.accountId,
    repoId: delta.repoId,
    sha: delta.headSha,
    refType: delta.refType,
    refId,
    agentId: step.ref,
    model: step.model
  })
  return run.id
}

/**
 * Builds the live `EnginePorts` plus a `dispose` (drops the run-event subscription). Each call
 * adds a `runEvents` subscription, so the caller owns the lifecycle and MUST `dispose`. The
 * poller builds one for its lifetime; an on-demand run-now/dry-run builds one and disposes it
 * in a `finally` (a brief second subscription that coexists harmlessly with the poller's).
 */
export function buildEnginePorts(): { ports: EnginePorts; dispose: () => void } {
  const waiter = createRunWaiter()
  const ports: EnginePorts = {
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now(),
    findCompletedDedupe: (key) => findCompletedPipelineRunByDedupe(key) !== undefined,
    // The three write ports also emit a live `pipeline:status` change so the Automate UI
    // updates without polling. The payload is run metadata only (token-free).
    insertPipelineRun: (input) => {
      const id = insertPipelineRun(input).id
      emitPipelineRunChange({
        pipelineId: input.pipelineId,
        pipelineRunId: id,
        runGroupId: null,
        status: 'pending',
        action: input.action,
        posted: false
      })
      return id
    },
    updatePipelineRunStatus: (id, status, finishedAt) => {
      updatePipelineRunStatus(id, status, finishedAt)
      const row = getPipelineRun(id)
      if (row) {
        emitPipelineRunChange({
          pipelineId: row.pipeline_id,
          pipelineRunId: id,
          runGroupId: row.run_group_id,
          status,
          action: row.action,
          posted: row.posted === 1
        })
      }
    },
    setPipelineRunPosted: (id) => {
      setPipelineRunPosted(id)
      const row = getPipelineRun(id)
      if (row) {
        emitPipelineRunChange({
          pipelineId: row.pipeline_id,
          pipelineRunId: id,
          runGroupId: row.run_group_id,
          status: row.status,
          action: row.action,
          posted: true
        })
      }
    },
    setPipelineRunGroup: (id, groupId) => {
      linkPipelineRunGroup(id, groupId)
      const row = getPipelineRun(id)
      if (row) {
        emitPipelineRunChange({
          pipelineId: row.pipeline_id,
          pipelineRunId: id,
          runGroupId: row.run_group_id,
          status: row.status,
          action: row.action,
          posted: row.posted === 1
        })
      }
    },
    createRunGroup: (input) =>
      insertRunGroup({
        repoId: input.repoId,
        refType: input.refType,
        refId: input.refId,
        headSha: input.headSha,
        startedAt: input.startedAt,
        authorLogin: input.authorLogin
      }).id,
    addRunToGroup: (input) =>
      addRunToGroup(input.groupId, input.runId, input.agentId, input.position),
    renderRunGroupReport: (groupId) => getRunGroupReport(groupId).markdown,
    setRunGroupPosted: (groupId, url) => setRunGroupPostedUrl(groupId, url),
    guardrailState: (pipeline) => {
      const now = Date.now()
      const sinceIso = new Date(now - HOUR_MS).toISOString()
      return assembleGuardrailState(
        now,
        countActivePipelineRuns(pipeline.id),
        recentPipelineRunStarts(pipeline.id, sinceIso),
        lastRepoPipelineRunStart(pipeline.repoId)
      )
    },
    startStep,
    waitForRun: (runId) => waiter.wait(runId),
    isRunPostEligible,
    aggregate: (runIds) => aggregateRunFindings({ runIds, groupBy: 'location', consensusMin: 1 }),
    // The ONLY engine→GitHub write path. `dispatchGithubWrite` re-asserts `assertMayPost`
    // before touching a writer (defense-in-depth on top of the engine's own gate).
    post: (action, target, delta, body) => {
      const repo = getRepoById(delta.repoId)
      return dispatchGithubWrite(
        githubWriters,
        repo?.full_name ?? null,
        action,
        target,
        delta,
        body
      )
    },
    // TODO(post-M9a): surface staged reviews in-app (tray/notification); log-only for now.
    notify: (pipeline, summary) =>
      log.info('pipeline notify', { pipeline: pipeline.name, summary }),
    advanceWatch: (delta) =>
      markWatchSeen(
        delta.repoId,
        delta.refType,
        delta.ref,
        delta.headSha,
        new Date().toISOString()
      ),
    log: (event, data) => log.info(event, data)
  }
  return { ports, dispose: () => waiter.dispose() }
}

/**
 * Loads the enabled pipelines the poller should run: parses + validates each persisted
 * config (a malformed/forged row is skipped), and — for now — skips any pipeline carrying a
 * tool step (tools run as grounding inside an agent review, not as standalone pipeline runs;
 * a later slice adds them). The engine still independently checks `planWaves(steps).ok`.
 */
export function loadEnabledPipelines(): Pipeline[] {
  const pipelines: Pipeline[] = []
  for (const row of listEnabledPipelineRows()) {
    const pipeline = parsePipelineRow(row)
    if (!pipeline) {
      log.warn('pipeline config invalid — skipping', { id: row.id })
      continue
    }
    if (!pipeline.steps.every((s) => s.kind === 'agent')) {
      log.info('pipeline has tool steps (not yet supported) — skipping', {
        id: row.id,
        name: pipeline.name
      })
      continue
    }
    pipelines.push(pipeline)
  }
  return pipelines
}
