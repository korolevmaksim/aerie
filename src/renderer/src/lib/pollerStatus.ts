import type { PollerStatus } from '@shared/types'

/** A compact relative duration: "45s", "~3m", "~2h" (rounded; always non-negative input). */
function rel(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `~${m}m`
  return `~${Math.round(m / 60)}h`
}

/**
 * One-line poller liveness for the Automate view (ROADMAP M14). Pure: takes the snapshot + the
 * current time (injected for testability) and renders e.g.
 * "Watching 2 pipelines · next check in ~2m · last checked 30s ago · API 4800/5000", or a clear
 * idle/paused state when no automation can currently run.
 */
export function formatPollerStatus(status: PollerStatus, nowMs: number): string {
  if (!status.running) return 'Automation paused'
  if (status.enabledPipelineCount === 0) return 'Idle · no enabled pipelines'
  if (status.activeWatchCount === 0) return 'Idle · no runnable watches'
  const pipelineLabel =
    status.enabledPipelineCount === 1 ? '1 pipeline' : `${status.enabledPipelineCount} pipelines`
  const parts: string[] = [`Watching ${pipelineLabel}`]
  if (status.nextPollAt) {
    const delta = new Date(status.nextPollAt).getTime() - nowMs
    parts.push(delta <= 0 ? 'checking now' : `next check in ${rel(delta)}`)
  }
  if (status.lastPolledAt) {
    parts.push(`last checked ${rel(nowMs - new Date(status.lastPolledAt).getTime())} ago`)
  }
  if (status.rate && status.rate.remaining !== null && status.rate.limit !== null) {
    parts.push(`API ${status.rate.remaining}/${status.rate.limit}`)
  }
  return parts.join(' · ')
}
