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
  PipelineActionKind,
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
  type ScopeContext
} from './pipelineModel'
import { checkGuardrails, planWaves, type GuardrailState } from './pipelinePlan'

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
  startStep(step: PipelineStep, delta: DeltaContext): number
  /** Resolves when the run reaches a terminal state (via `runEvents.onFinished`). */
  waitForRun(runId: number): Promise<'done' | 'error' | 'killed'>
  /** M6 aggregation over the panel's persisted findings. */
  aggregate(runIds: number[]): ConsensusResult
  /** The ONLY GitHub-write port. Reached solely from the gated `post` branch. */
  post(target: PostTarget, delta: DeltaContext, body: string): Promise<string>
  /** notify/stage surface (no GitHub write). */
  notify(pipeline: Pipeline, summary: string): void
  /** Advances the watch's last-seen SHA — called once per delta AFTER all pipelines settle. */
  advanceWatch(delta: DeltaContext): void
  log(event: string, data?: Record<string, unknown>): void
}

export type PipelineOutcome =
  | {
      ran: false
      reason: 'scope' | 'invalid' | 'no-steps' | 'guardrail' | 'dedupe' | 'error'
      detail?: string
    }
  | {
      ran: true
      pipelineRunId: number
      action: PipelineActionKind
      posted: boolean
      findings: number
    }

function triggerMatches(pipeline: Pipeline, delta: DeltaContext): boolean {
  if (pipeline.repoId !== delta.repoId) return false
  if (pipeline.trigger === 'commit') return delta.refType === 'commit'
  if (pipeline.trigger === 'pr') return delta.refType === 'pr'
  // 'schedule'/'manual' pipelines are not delta-driven.
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
  ports: EnginePorts
): Promise<PipelineOutcome> {
  // Track the inserted run so a throw AFTER insert marks it 'error'; a throw BEFORE insert
  // (a store/guardrail port failure) still resolves to reason:'error' with no run to mark.
  let pipelineRunId: number | null = null
  try {
    if (!triggerMatches(pipeline, delta) || !matchesScope(pipeline.scope, delta.scope)) {
      return { ran: false, reason: 'scope' }
    }

    const plan = planWaves(pipeline.steps)
    if (!plan.ok) return { ran: false, reason: 'invalid', detail: plan.error }
    if (pipeline.steps.length === 0) return { ran: false, reason: 'no-steps' }

    const guard = checkGuardrails(pipeline.guardrails, ports.guardrailState(pipeline))
    if (!guard.allowed) return { ran: false, reason: 'guardrail', detail: guard.reason }

    const key = dedupeKey({
      repoId: delta.repoId,
      refType: delta.refType,
      ref: delta.ref,
      baseSha: delta.baseSha,
      headSha: delta.headSha,
      catalogVersion: delta.catalogVersion,
      promptHash: delta.promptHash,
      configHash: pipelineConfigHash(pipeline.steps, pipeline.action.kind)
    })
    if (ports.findCompletedDedupe(key)) return { ran: false, reason: 'dedupe' }

    const effective = effectiveAction(pipeline.action)
    pipelineRunId = ports.insertPipelineRun({
      pipelineId: pipeline.id,
      trigger: pipeline.trigger,
      refType: delta.refType,
      ref: delta.ref,
      headSha: delta.headSha,
      action: effective,
      dedupeKey: key,
      startedAt: ports.nowIso()
    })

    // Run each wave fully before the next — the wait-for-all-steps barrier. A failed step
    // doesn't abort the wave; it simply contributes no findings to the aggregate.
    const runIds: number[] = []
    for (const wave of plan.waves) {
      const started = wave.map((stepId) => {
        const step = pipeline.steps.find((s) => s.id === stepId)!
        return ports.startStep(step, delta)
      })
      runIds.push(...started)
      await Promise.all(started.map((runId) => ports.waitForRun(runId)))
    }

    const agg = ports.aggregate(runIds)
    const body = formatActionBody(pipeline.name, agg)

    let posted = false
    if (effective === 'post') {
      // Belt-and-suspenders: `effective` is only 'post' for an enabled auto-post, but
      // assert again immediately before the write so no future edit can slip a non-enabled
      // action into this branch.
      assertMayPost(pipeline.action)
      const target: PostTarget =
        pipeline.action.target ?? (delta.refType === 'pr' ? 'pr' : 'commit')
      await ports.post(target, delta, body)
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
