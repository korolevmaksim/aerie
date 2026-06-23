// The automation pipeline ENGINE (ROADMAP M9a). Dependency-injected and electron-free
// on purpose: every side effect (starting runs, waiting for them, aggregating, posting,
// the store + watch bookkeeping) arrives through `EnginePorts`, so the security-critical
// orchestration — above all the auto-post gate — is provable in vitest with fakes before
// the live poller/adapter (next slice) binds the real runner, store, and GitHub writers.
//
// SPEC §10 auto-post discipline (enforced here): a GitHub write is reachable ONLY inside
// the `effective === 'post'` branch, which `effectiveAction` enters only for an enabled
// post, and which calls `assertMayPost` immediately before the write. A disabled post can
// never reach `ports.post`. The human confirm path is a different code path entirely.

import type {
  ConsensusResult,
  Pipeline,
  PipelineAction,
  PipelineActionKind,
  PipelineReviewTarget,
  PipelineRunOutcome,
  PipelineRunStatus,
  PipelineStep,
  PipelineTrigger,
  PostTarget,
  RefType
} from '../shared/types'
import {
  assertMayPost,
  dedupeKey,
  effectiveAction,
  matchesScope,
  pipelineConfigHash,
  reviewTargetOf,
  type ScopeContext
} from './pipelineModel'
import { checkGuardrails, planWaves, type GuardrailState } from './pipelinePlan'

/** @deprecated use `PipelineRunOutcome` (kept as an alias for in-module readability). */
export type PipelineOutcome = PipelineRunOutcome

/** A detected change to drive one or more pipelines against. */
export interface DeltaContext {
  accountId: number
  repoId: number
  /** 'commit' (a branch head moved) or 'pr' (a PR head moved). */
  refType: Extract<RefType, 'commit' | 'pr'>
  /** The watch ref: a branch name ('commit') or `pr:<n>` ('pr'). */
  ref: string
  headSha: string
  baseSha: string | null
  /** Inputs for `matchesScope` (branch/labels/author/paths/draft/commitCount). */
  scope: ScopeContext
  /** Tool/agent catalog version + review-prompt hash, for the dedupe key. */
  catalogVersion: string
  promptHash: string
}

/**
 * Side-effect boundary. The vitest suite passes fakes; the live adapter (next slice)
 * binds these to the real runner (`startRun`/`runEvents`), the M6 aggregator, the store,
 * and the GitHub writers — `post` being the ONLY write port.
 */
export interface EnginePorts {
  nowIso(): string
  nowMs(): number
  /** True if a completed run already exists for this dedupe key (skip identical work). */
  findCompletedDedupe(key: string): boolean
  insertPipelineRun(input: {
    pipelineId: number
    trigger: PipelineTrigger
    refType: RefType
    ref: string
    headSha: string
    action: PipelineActionKind
    dedupeKey: string
    startedAt: string
  }): number
  updatePipelineRunStatus(id: number, status: PipelineRunStatus, finishedAt?: string): void
  /** Flags a pipeline_run as having actually written to GitHub. */
  setPipelineRunPosted(id: number): void
  /** Recent-activity snapshot for guardrail checks. */
  guardrailState(pipeline: Pipeline): GuardrailState
  /** Starts one step's run; returns the runId. Agent steps map to `startRun`. */
  startStep(step: PipelineStep, delta: DeltaContext, reviewTarget: PipelineReviewTarget): number
  /** Resolves when the run reaches a terminal state (via `runEvents.onFinished`). */
  waitForRun(runId: number): Promise<'done' | 'error' | 'killed'>
  /** M6 aggregation over the panel's persisted findings. */
  aggregate(runIds: number[]): ConsensusResult
  /**
   * The ONLY GitHub-write port — reached solely from the gated `post` branch. Receives the
   * `action` so the adapter can RE-assert `assertMayPost` independently (defense-in-depth:
   * even a future engine bug can't write unless the adapter also agrees it's an enabled post).
   */
  post(
    action: PipelineAction,
    target: PostTarget,
    delta: DeltaContext,
    body: string
  ): Promise<string>
  /** notify/stage surface (no GitHub write). */
  notify(pipeline: Pipeline, summary: string): void
  /** Advances the watch's last-seen SHA — called once per delta AFTER all pipelines settle. */
  advanceWatch(delta: DeltaContext): void
  log(event: string, data?: Record<string, unknown>): void
}

/** Options for a single pipeline run (the poller passes none; the IPC run-now/dry-run set these). */
export interface RunOptions {
  /** Explicit user run: skip the AUTO gates (trigger/scope/guardrail/dedupe) so it always runs. */
  manual?: boolean
  /** Force no GitHub write regardless of the action; the run row is salted so it can't make
   *  the poller skip a real auto run on the same head. */
  dryRun?: boolean
}

function triggerMatches(pipeline: Pipeline, delta: DeltaContext): boolean {
  if (pipeline.repoId !== delta.repoId) return false
  // Commit and schedule pipelines are both driven by the default-branch watch. The pipeline's
  // reviewTarget later decides whether that head becomes a commit diff or a whole-project audit.
  if (pipeline.trigger === 'commit' || pipeline.trigger === 'schedule') {
    return delta.refType === 'commit'
  }
  if (pipeline.trigger === 'pr') return delta.refType === 'pr'
  // 'manual' is not delta-driven (run-now sets opts.manual to bypass this gate).
  return false
}

/** A compact GitHub-comment / notification body from the aggregated findings. */
export function formatActionBody(name: string, agg: ConsensusResult): string {
  if (agg.findings.length === 0) {
    return `Aerie pipeline "${name}": no consensus findings (${agg.total} raw).`
  }
  const lines = agg.findings.map((f) => {
    const loc = f.line !== null ? `${f.file}:${f.line}` : f.file
    return `- [${f.severity}] ${loc} — ${f.message} (${f.agreement}×)`
  })
  return `Aerie pipeline "${name}" — ${agg.findings.length} consensus finding(s) of ${agg.total}:\n${lines.join('\n')}`
}

/**
 * Runs one pipeline against one delta: scope filter → graph/guardrail/dedupe gates →
 * insert a pipeline_run → run the steps wave by wave (the wait-for-all barrier) → M6
 * aggregate → actioner. NEVER throws to the caller — a thrown port (store/runner) is caught
 * too and surfaces as `{ran:false, reason:'error'}` (marking any inserted run 'error'), so
 * `processDelta` does NOT advance the watch and the delta is retried. Side-effect-free gate
 * failures return their own reason. Does NOT touch watch state itself.
 */
export async function runPipelineForDelta(
  pipeline: Pipeline,
  delta: DeltaContext,
  ports: EnginePorts,
  opts: RunOptions = {}
): Promise<PipelineOutcome> {
  // Track the inserted run so a throw AFTER insert marks it 'error'; a throw BEFORE insert
  // (a store/guardrail port failure) still resolves to reason:'error' with no run to mark.
  let pipelineRunId: number | null = null
  try {
    // A manual run (the user explicitly triggered it) bypasses the AUTO gates — trigger,
    // scope, guardrail, dedupe — so it always runs. The poller path passes no opts.
    if (
      !opts.manual &&
      (!triggerMatches(pipeline, delta) || !matchesScope(pipeline.scope, delta.scope))
    ) {
      return { ran: false, reason: 'scope' }
    }

    const plan = planWaves(pipeline.steps)
    if (!plan.ok) return { ran: false, reason: 'invalid', detail: plan.error }
    if (pipeline.steps.length === 0) return { ran: false, reason: 'no-steps' }

    if (!opts.manual) {
      const guard = checkGuardrails(pipeline.guardrails, ports.guardrailState(pipeline))
      if (!guard.allowed) return { ran: false, reason: 'guardrail', detail: guard.reason }
    }

    const reviewTarget = reviewTargetOf(pipeline)
    const runRefType: RefType = reviewTarget === 'project' ? 'project' : delta.refType
    const key = dedupeKey({
      repoId: delta.repoId,
      refType: runRefType,
      ref: delta.ref,
      baseSha: delta.baseSha,
      headSha: delta.headSha,
      catalogVersion: delta.catalogVersion,
      promptHash: delta.promptHash,
      configHash: pipelineConfigHash(pipeline.steps, pipeline.action.kind, reviewTarget)
    })
    // A dry run always runs (you're testing) and a manual run is explicit — both bypass the
    // dedupe gate. Only the auto (poller) path skips already-completed work.
    // A scheduled project audit is intentionally cadence-based: it re-runs on the current
    // snapshot even if the head SHA has not changed. Commit-diff schedules stay deduped.
    const cadenceProjectAudit = pipeline.trigger === 'schedule' && reviewTarget === 'project'
    if (!opts.manual && !opts.dryRun && !cadenceProjectAudit && ports.findCompletedDedupe(key)) {
      return { ran: false, reason: 'dedupe' }
    }

    // A dry run forces the action to never post (autoPost off), so `effective` can never be
    // 'post' → the write branch is unreachable.
    const action = opts.dryRun ? { ...pipeline.action, autoPost: false } : pipeline.action
    const effective = effectiveAction(action)
    // Dedupe-key policy: a DRY run is salted (`dryrun:`) so it can NEVER make the poller skip a
    // real auto run on the same head. A non-dry MANUAL run (run-now) keeps the CANONICAL key on
    // purpose — it did the real work (and posted, if opted in), so a later auto run on the same
    // head SHOULD dedupe-skip it rather than redo/re-post identical work.
    pipelineRunId = ports.insertPipelineRun({
      pipelineId: pipeline.id,
      trigger: opts.manual ? 'manual' : pipeline.trigger,
      refType: runRefType,
      ref: delta.ref,
      headSha: delta.headSha,
      action: effective,
      dedupeKey: opts.dryRun ? `dryrun:${key}` : key,
      startedAt: ports.nowIso()
    })
    // Mark running so the live status push shows a run in progress (not just pending→done).
    ports.updatePipelineRunStatus(pipelineRunId, 'running')

    // Run each wave fully before the next — the wait-for-all-steps barrier. A failed step
    // doesn't abort the wave; it simply contributes no findings to the aggregate.
    const runIds: number[] = []
    for (const wave of plan.waves) {
      const started = wave.map((stepId) => {
        const step = pipeline.steps.find((s) => s.id === stepId)!
        return ports.startStep(step, delta, reviewTarget)
      })
      runIds.push(...started)
      await Promise.all(started.map((runId) => ports.waitForRun(runId)))
    }

    const agg = ports.aggregate(runIds)
    const body = formatActionBody(pipeline.name, agg)

    let posted = false
    if (effective === 'post') {
      // Belt-and-suspenders: `effective` is only 'post' for an enabled auto-post (and a dry
      // run forces `action` to autoPost:false, so it can never reach here), but assert again
      // immediately before the write so no future edit can slip a non-enabled action in.
      assertMayPost(action)
      const target: PostTarget =
        reviewTarget === 'project'
          ? 'issue'
          : (action.target ?? (delta.refType === 'pr' ? 'pr' : 'commit'))
      await ports.post(action, target, delta, body)
      ports.setPipelineRunPosted(pipelineRunId)
      posted = true
    } else {
      // notify or stage (a disabled post degrades to stage) — held for the manual confirm.
      ports.notify(pipeline, body)
    }

    ports.updatePipelineRunStatus(pipelineRunId, 'done', ports.nowIso())
    ports.log('pipeline run done', { pipelineId: pipeline.id, action: effective, posted })
    return { ran: true, pipelineRunId, action: effective, posted, findings: agg.findings.length }
  } catch (err) {
    if (pipelineRunId !== null)
      ports.updatePipelineRunStatus(pipelineRunId, 'error', ports.nowIso())
    ports.log('pipeline run error', { pipelineId: pipeline.id, error: String(err) })
    return { ran: false, reason: 'error', detail: String(err) }
  }
}

export interface DeltaResult {
  outcomes: PipelineOutcome[]
  /** Whether the watch's last-seen SHA was advanced (only when every pipeline settled
   *  without an execution error — so an errored delta is re-detected and retried). */
  advanced: boolean
}

/**
 * Dispatches one delta to every matching pipeline, then advances the watch ONCE — but only
 * if no pipeline ended in an execution 'error' (a skip via scope/guardrail/dedupe still
 * counts as settled). This keeps `markWatchSeen` strictly after the delta is fully
 * processed, so no unprocessed commit is ever skipped past.
 */
export async function processDelta(
  pipelines: Pipeline[],
  delta: DeltaContext,
  ports: EnginePorts
): Promise<DeltaResult> {
  // An empty pipeline list advances the watch (nothing watches this ref → mark it seen,
  // so a future pipeline starts from the current head rather than replaying old deltas).
  const outcomes: PipelineOutcome[] = []
  let hadError = false
  for (const pipeline of pipelines) {
    const outcome = await runPipelineForDelta(pipeline, delta, ports)
    outcomes.push(outcome)
    if (outcome.ran === false && outcome.reason === 'error') hadError = true
  }
  if (!hadError) {
    ports.advanceWatch(delta)
    return { outcomes, advanced: true }
  }
  return { outcomes, advanced: false }
}
