import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { log } from './logger'
import { getActiveRuns, onChange, type ActiveRun } from './runEvents'

/**
 * Menu-bar / system-tray presence for Aerie. Lives entirely in the main process
 * and is driven by the central run-events hub, so the menu, tooltip and (macOS)
 * count badge stay live even when every window is hidden.
 *
 * The Tray reference is module-scoped on purpose: a Tray held only by a local
 * gets garbage-collected and its OS icon silently disappears.
 */

let tray: Tray | null = null
let unsubscribe: (() => void) | null = null

/** How many active-run rows to render before collapsing the rest into an overflow item. */
const MAX_ROWS = 8

export interface TrayActions {
  /** Restore + focus the main window (creating it if needed). */
  showMainWindow: () => void
  /** Restore the window and open a specific run in the UI. */
  openRun: (runId: number) => void
  /** Begin a real application quit (runs the agent drain). */
  quit: () => void
}

/**
 * Builds the menu-bar image from the app icon. The shipped icon is a 512px color
 * PNG; passed raw to Tray it renders huge/blurry, so it is downscaled to ~18 logical
 * points. It is kept in COLOR (no template image) so the user's branded icon shows
 * as-is — the tradeoff is it does not auto-invert for the macOS light/dark menu bar.
 * Swapping in a monochrome `…Template.png` + `setTemplateImage(true)` (mac only) is
 * the future path to a fully native menu-bar glyph.
 */
function buildTrayImage(iconPath: string): Electron.NativeImage {
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) return image
  return image.resize({ width: 18, height: 18, quality: 'best' })
}

function statusGlyph(status: ActiveRun['status']): string {
  if (status === 'running') return '⟳'
  if (status === 'queued') return '○'
  return '•'
}

function refLabel(run: ActiveRun): string {
  if (run.refType === 'project') return `project ${run.refId}`
  return run.refType === 'pr' ? `PR #${run.refId}` : run.shortSha
}

function buildMenu(actions: TrayActions): Menu {
  const runs = getActiveRuns()
  const count = runs.length
  const template: MenuItemConstructorOptions[] = [
    { label: count > 0 ? `Aerie — ${count} running` : 'Aerie', enabled: false }
  ]

  if (count === 0) {
    template.push({ label: 'No active reviews', enabled: false })
  } else {
    template.push({ type: 'separator' })
    for (const run of runs.slice(0, MAX_ROWS)) {
      template.push({
        label: `${statusGlyph(run.status)}  ${run.repoFullName} @ ${refLabel(run)}`,
        click: () => actions.openRun(run.runId)
      })
    }
    if (count > MAX_ROWS) {
      template.push({
        label: `… and ${count - MAX_ROWS} more — Open Aerie`,
        click: () => actions.showMainWindow()
      })
    }
  }

  template.push(
    { type: 'separator' },
    { label: 'Open Aerie', click: () => actions.showMainWindow() },
    { label: 'Quit Aerie', click: () => actions.quit() }
  )

  return Menu.buildFromTemplate(template)
}

/** Rebuilds the (immutable) menu plus the tooltip and macOS title from current state. */
function rebuild(actions: TrayActions): void {
  if (!tray || tray.isDestroyed()) return
  const count = getActiveRuns().length
  tray.setContextMenu(buildMenu(actions))
  tray.setToolTip(count > 0 ? `Aerie — ${count} running` : 'Aerie')
  // setTitle is macOS-only — a compact count badge next to the menu-bar icon.
  if (process.platform === 'darwin') tray.setTitle(count > 0 ? ` ${count}` : '')
}

/**
 * Creates the tray (idempotent across dev hot-reloads) and wires it to the hub so
 * it rebuilds on every run-state change. Safe to call once after the app is ready.
 */
export function initTray(iconPath: string, actions: TrayActions): void {
  if (tray && !tray.isDestroyed()) return
  tray = new Tray(buildTrayImage(iconPath))
  tray.setToolTip('Aerie')
  // Left-click opens the app on Windows/Linux; on macOS setContextMenu suppresses
  // the 'click' event (the menu opens instead), so this is a harmless no-op there.
  tray.on('click', () => actions.showMainWindow())
  unsubscribe = onChange(() => rebuild(actions))
  rebuild(actions)
  log.info('tray ready')
}

/** Removes the OS icon and detaches the hub subscription (on quit). */
export function destroyTray(): void {
  unsubscribe?.()
  unsubscribe = null
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}
