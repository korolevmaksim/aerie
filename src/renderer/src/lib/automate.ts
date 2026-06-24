// Pure display helpers for the Automate view (ROADMAP M13). Derive a pipeline's current
// run status (preferring a live `pipeline:status` push over the listed history) and its
// label/tone, so the component stays a thin render. Unit-tested.

import type {
  Pipeline,
  PipelineAction,
  PipelineRunChange,
  PipelineRunOutcome,
  PipelineRunStatus,
  PipelineRunSummary,
  PipelineWithRuns
} from '@shared/types'
import { parseScheduleMs, parseScheduleParts, type ScheduleUnit } from '@shared/schedule'

export type DisplayStatus = PipelineRunStatus | 'never'

export interface RunStatusView {
  status: DisplayStatus
  posted: boolean
}

/**
 * The status to show for a pipeline: a matching live push wins (it's always the most recent
 * transition for that pipeline), else the newest listed run (runs come newest-first), else
 * 'never'. `live` is the component's `pipelineId → latest change` map entry.
 */
export function displayRunStatus(
  item: PipelineWithRuns,
  live: PipelineRunChange | undefined
): RunStatusView {
  if (live && live.pipelineId === item.pipeline.id) {
    return { status: live.status, posted: live.posted }
  }
  const last = item.runs[0]
  return last ? { status: last.status, posted: last.posted } : { status: 'never', posted: false }
}

const LABELS: Record<DisplayStatus, string> = {
  never: 'Never run',
  pending: 'Queued',
  running: 'Running…',
  done: 'Done',
  error: 'Error',
  skipped: 'Skipped'
}

export function statusLabel(status: DisplayStatus): string {
  return LABELS[status]
}

/** A tone token for the status pill (maps to a CSS modifier; never color alone). */
export function statusTone(status: DisplayStatus): 'ok' | 'warn' | 'bad' | 'muted' {
  if (status === 'done') return 'ok'
  if (status === 'running' || status === 'pending') return 'warn'
  if (status === 'error') return 'bad'
  return 'muted' // never / skipped
}

/**
 * Applies a live `pipeline:status` change to the `pipelineId → change` map (newest wins).
 * Returns a new map; the component renders via `displayRunStatus(item, map[id])`.
 */
export function applyLiveChange(
  live: Record<number, PipelineRunChange>,
  change: PipelineRunChange
): Record<number, PipelineRunChange> {
  return { ...live, [change.pipelineId]: change }
}

const SKIP_REASONS: Record<string, string> = {
  scope: "didn't match scope",
  invalid: 'invalid step graph',
  'no-steps': 'no steps',
  guardrail: 'a guardrail blocked it',
  dedupe: 'already run for this head',
  error: 'an error occurred'
}

/** First 7 chars of a commit SHA for compact display (or '—' when absent). */
export function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : '—'
}

/**
 * A readable summary of a single run for the run-history list — action, posted flag, trigger,
 * short SHA. The status is shown separately as a pill (with tone), and the relative time is
 * rendered live in the component via `formatRelativeTime`, so neither is included here.
 */
export function formatRunLine(run: PipelineRunSummary): string {
  const parts: string[] = [run.action]
  if (run.posted) parts.push('posted')
  parts.push(run.refType === 'project' ? 'project audit' : run.trigger)
  if (run.headSha) parts.push(shortSha(run.headSha))
  return parts.join(' · ')
}

const SCHEDULE_LABELS: Record<ScheduleUnit, [string, string]> = {
  m: ['minute', 'minutes'],
  h: ['hour', 'hours'],
  d: ['day', 'days']
}

function pluralScheduleUnit(value: number, unit: ScheduleUnit): string {
  const [one, many] = SCHEDULE_LABELS[unit]
  return value === 1 ? one : many
}

export function describePipelineCadence(pipeline: Pipeline): string {
  if (pipeline.trigger === 'schedule') {
    if (parseScheduleMs(pipeline.schedule) === null) return 'Schedule invalid'
    const parts = parseScheduleParts(pipeline.schedule)
    return `Every ${parts.every} ${pluralScheduleUnit(parts.every, parts.unit)}`
  }
  if (pipeline.trigger === 'commit') return 'On new default-branch commits'
  if (pipeline.trigger === 'pr') return 'PR trigger'
  return 'Manual only'
}

export function describePipelineTarget(pipeline: Pipeline): string {
  return pipeline.reviewTarget === 'project' ? 'Project audit' : 'Commit diff'
}

export function describePipelineAction(action: PipelineAction): string {
  if (action.kind === 'post' && action.autoPost) return 'Auto-post to GitHub'
  if (action.kind === 'post') return 'Stage for manual post'
  if (action.kind === 'stage') return 'Stage result'
  return 'Notify only'
}

/** A short inline summary of a run-now / dry-run outcome for the row. */
export function describeOutcome(outcome: PipelineRunOutcome, dryRun: boolean): string {
  const verb = dryRun ? 'Dry run' : 'Run'
  if (!outcome.ran) {
    return `${verb} skipped — ${SKIP_REASONS[outcome.reason] ?? outcome.reason}.`
  }
  const findings = `${outcome.findings} finding${outcome.findings === 1 ? '' : 's'}`
  const posted = outcome.posted ? ', posted to GitHub' : ''
  return `${verb} done — ${outcome.action}, ${findings}${posted}.`
}
