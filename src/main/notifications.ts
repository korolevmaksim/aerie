import { BrowserWindow, Notification } from 'electron'
import { log } from './logger'
import type { FinishedRun } from './runEvents'

/**
 * Native desktop notifications fired from the MAIN process (not renderer HTML5
 * notifications). The only event Aerie notifies on is a review finishing, which is
 * exactly what the user wants surfaced while the window is hidden in the tray.
 *
 * Notifications are held in a module-scoped Map so their click handlers are not
 * garbage-collected before the user interacts with the banner.
 */

const held = new Map<string, Notification>()

function release(key: string): void {
  held.delete(key)
}

function refLabel(run: FinishedRun): string {
  if (run.refType === 'project') return `project ${run.refId}`
  return run.refType === 'pr' ? `PR #${run.refId}` : run.shortSha
}

/**
 * Shows a "review finished" banner for a terminal run, then focuses that run when
 * clicked. Suppressed when:
 *  - notifications are disabled in settings,
 *  - the run was killed (user-initiated — no banner),
 *  - a window is currently focused (the in-app History/RunView already shows the
 *    result, so an OS banner would be redundant; this is also the only state in
 *    which the macOS click event reliably misfires).
 */
export function notifyRunFinished(
  run: FinishedRun,
  openRun: (runId: number) => void,
  enabled: boolean
): void {
  if (!enabled) return
  if (run.status === 'killed') return
  if (!Notification.isSupported()) return
  // A focused window means the app is frontmost and visible — the result is
  // already on screen, so skip the banner.
  if (BrowserWindow.getFocusedWindow()) return

  const ok = run.status === 'done'
  const detail = ok ? '' : ` · exit ${run.exitCode ?? '—'}`
  const notification = new Notification({
    title: ok ? 'Review passed' : 'Review failed',
    body: `${run.repoFullName} · ${refLabel(run)} · ${run.agentId}${detail}`,
    silent: ok
  })

  const key = `run-${run.runId}`
  held.set(key, notification)
  notification.on('click', () => {
    release(key)
    openRun(run.runId)
  })
  notification.on('close', () => release(key))
  // Unsigned/dev macOS builds emit 'failed' instead of showing — log, don't throw.
  notification.on('failed', (_e, error) => {
    release(key)
    log.warn('notification failed', { error })
  })
  notification.show()
}

/**
 * One-time educational banner the first time the window is hidden to the tray, so
 * the user understands the app is still running and recoverable. Caller persists
 * the "already shown" flag.
 */
export function showCloseToTrayHint(markShown: () => void): void {
  markShown()
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: 'Aerie is still running',
    body: 'Aerie stays in the menu bar and will notify you when reviews finish. Quit it from the menu-bar icon.'
  })
  const key = 'close-to-tray-hint'
  held.set(key, notification)
  notification.on('click', () => release(key))
  notification.on('close', () => release(key))
  notification.on('failed', () => release(key))
  notification.show()
}
