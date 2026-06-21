import { EventEmitter } from 'events'
import type { RunOutputChunk, RunStatus, RunStatusUpdate } from '../shared/types'

/**
 * Central, in-process run lifecycle hub for the MAIN process — the single source
 * of truth for the tray and finish notifications, and the fan-out point for the
 * renderer.
 *
 * The agent runner feeds this on every status transition and output chunk. Unlike
 * the old per-`event.sender` IPC hooks (which reached only the window that started
 * a run), the hub lets the tray show live status even when every window is hidden,
 * and lets a re-shown window keep streaming a still-running review.
 *
 * No Electron imports here on purpose — this stays unit-testable in plain Node.
 */

/** A run currently queued or running, with the metadata the tray menu renders. */
export interface ActiveRun {
  runId: number
  /** owner/repo */
  repoFullName: string
  /** Short head SHA for compact display. */
  shortSha: string
  agentId: string
  refType: 'commit' | 'pr'
  refId: string
  status: RunStatus
  startedAt: string
}

/** A run that has reached a terminal state — payload for the finish notification. */
export interface FinishedRun extends ActiveRun {
  exitCode: number | null
}

function isTerminal(status: RunStatus): boolean {
  return status === 'done' || status === 'error' || status === 'killed'
}

const active = new Map<number, ActiveRun>()
const bus = new EventEmitter()
// Tray + IPC bridge both subscribe; the default cap (10) is too low for safety.
bus.setMaxListeners(50)

const CHANGE = 'change'
const STATUS = 'status'
const OUTPUT = 'output'
const FINISHED = 'finished'

/** Records a newly created (queued) run so the tray reflects it immediately. */
export function registerRun(meta: ActiveRun): void {
  active.set(meta.runId, meta)
  bus.emit(CHANGE)
}

/**
 * Records a status transition. Always emits `status` (for the renderer fan-out)
 * and `change` (for the tray). On a terminal status it also emits `finished`
 * (for the notification) and drops the run from the active set.
 *
 * Invariant: every `runId` reaching here was `registerRun`'d first (the runner
 * registers before it can transition). A terminal status for an unregistered run
 * still fans out `status`, but cannot emit `finished` — there is no metadata to
 * show in a notification.
 */
export function noteStatus(
  runId: number,
  status: RunStatus,
  extra?: { exitCode?: number | null; outputPath?: string | null }
): void {
  const entry = active.get(runId)
  if (entry) entry.status = status

  const update: RunStatusUpdate = {
    runId,
    status,
    exitCode: extra?.exitCode ?? null,
    outputPath: extra?.outputPath ?? null
  }
  bus.emit(STATUS, update)

  if (isTerminal(status)) {
    if (entry) {
      const finished: FinishedRun = { ...entry, status, exitCode: extra?.exitCode ?? null }
      bus.emit(FINISHED, finished)
      active.delete(runId)
    }
  }
  bus.emit(CHANGE)
}

/** Re-emits a live output chunk for the renderer fan-out. */
export function noteOutput(chunk: RunOutputChunk): void {
  bus.emit(OUTPUT, chunk)
}

/** Snapshot of queued + running runs, in start order, for the tray menu. */
export function getActiveRuns(): ActiveRun[] {
  return [...active.values()].sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId - b.runId
  )
}

/** Count of queued + running runs (drives the tray title/tooltip and quit drain). */
export function activeCount(): number {
  return active.size
}

/** Subscribe to active-set changes (tray rebuild). Returns an unsubscribe fn. */
export function onChange(cb: () => void): () => void {
  bus.on(CHANGE, cb)
  return () => bus.off(CHANGE, cb)
}

/** Subscribe to status transitions (renderer fan-out). Returns an unsubscribe fn. */
export function onStatus(cb: (update: RunStatusUpdate) => void): () => void {
  bus.on(STATUS, cb)
  return () => bus.off(STATUS, cb)
}

/** Subscribe to live output chunks (renderer fan-out). Returns an unsubscribe fn. */
export function onOutput(cb: (chunk: RunOutputChunk) => void): () => void {
  bus.on(OUTPUT, cb)
  return () => bus.off(OUTPUT, cb)
}

/** Subscribe to terminal-state runs (finish notification). Returns an unsubscribe fn. */
export function onFinished(cb: (run: FinishedRun) => void): () => void {
  bus.on(FINISHED, cb)
  return () => bus.off(FINISHED, cb)
}

/** Test/maintenance helper — clears the active set and all subscribers. */
export function resetRunEvents(): void {
  active.clear()
  bus.removeAllListeners()
  bus.setMaxListeners(50)
}
