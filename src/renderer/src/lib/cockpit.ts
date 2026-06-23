import type { RunHistoryItem, RunStatus } from '@shared/types'

const ACTIVE_STATUSES = new Set<RunStatus>(['queued', 'running'])

export interface CockpitSummary {
  active: number
  attention: number
  readyToPost: number
  handled: number
  posted: number
  completed: number
}

export function isActiveRun(run: RunHistoryItem): boolean {
  return ACTIVE_STATUSES.has(run.status)
}

export function isReadyToPost(run: RunHistoryItem): boolean {
  return run.status === 'done' && !run.postedUrl && run.localStatus === 'open'
}

export function needsHumanAttention(run: RunHistoryItem): boolean {
  return (
    run.localStatus === 'open' &&
    (run.status === 'error' || run.status === 'killed' || isReadyToPost(run))
  )
}

export function startedAtMs(run: RunHistoryItem): number {
  const ms = Date.parse(run.startedAt)
  return Number.isFinite(ms) ? ms : 0
}

export function newestRuns(runs: RunHistoryItem[]): RunHistoryItem[] {
  return [...runs].sort((a, b) => startedAtMs(b) - startedAtMs(a))
}

export function cockpitSummary(runs: RunHistoryItem[]): CockpitSummary {
  let active = 0
  let attention = 0
  let readyToPost = 0
  let handled = 0
  let posted = 0
  let completed = 0

  for (const run of runs) {
    if (isActiveRun(run)) active += 1
    if (needsHumanAttention(run)) attention += 1
    if (isReadyToPost(run)) readyToPost += 1
    if (run.localStatus !== 'open') handled += 1
    if (run.postedUrl) posted += 1
    if (run.status === 'done') completed += 1
  }

  return { active, attention, readyToPost, handled, posted, completed }
}

export function runAttentionLabel(run: RunHistoryItem): string {
  if (run.postedUrl) return 'Posted'
  if (run.localStatus === 'verified') return 'Verified locally'
  if (run.localStatus === 'handled') return 'Handled locally'
  if (run.status === 'error') return 'Failed'
  if (run.status === 'killed') return 'Stopped'
  if (isReadyToPost(run)) return 'Ready to post'
  if (run.status === 'running') return 'Running'
  if (run.status === 'queued') return 'Queued'
  return 'Complete'
}
