import { app, dialog, shell, BrowserWindow, safeStorage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { CHANNELS } from '../shared/channels'
import { initStore, getSetting, setSetting } from './store'
import { registerIpcHandlers } from './ipc'
import { isInternalUrl, isSafeExternalUrl } from './security'
import { log } from './logger'
import { hasActiveRuns, killAllRuns } from './agentRunner'
import { pruneAllWorktreesAndDiffs } from './gitEngine'
import { startPoller, stopPoller } from './poller'
import { augmentedPath, mergePaths } from './osPath'
import { loginShellPath } from './shellPath'
import { onChange, onFinished, onOutput, onStatus } from './runEvents'
import { onPipelineRunChange } from './pipelineEvents'
import { initTray, destroyTray } from './tray'
import { notifyRunFinished, showCloseToTrayHint } from './notifications'

// The single main window. Held at module scope so the tray/notifications and the
// lifecycle helpers can show, hide, and re-create it.
let mainWindow: BrowserWindow | null = null
// Set true once a real quit begins, so the close-to-tray intercept lets the window
// actually close instead of re-hiding it.
let isQuitting = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    title: 'Aerie',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security model (SPEC §4) — set explicitly, never relied on as defaults.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Close-to-tray: a window close (Cmd+W / the red button) hides the window and
  // keeps the app alive in the menu bar, unless we are really quitting or the user
  // turned the behavior off. The first time it happens we explain it once.
  mainWindow.on('close', (event) => {
    if (isQuitting || !closeToTraySetting()) return
    event.preventDefault()
    mainWindow?.hide()
    if (!boolSetting('ui.closeToTrayHintShown', false)) {
      showCloseToTrayHint(() => setSetting('ui.closeToTrayHintShown', '1'))
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Open external links in the OS browser — but only http(s), never file:// or
  // other OS-handler schemes (avoids shell.openExternal as an exfil/RCE vector).
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  // Never let the top-level frame navigate away from the app's own content;
  // otherwise a remote page would inherit the preload bridge.
  const blockExternalNavigation = (event: Electron.Event, url: string): void => {
    if (!isInternalUrl(url)) event.preventDefault()
  }
  mainWindow.webContents.on('will-navigate', blockExternalNavigation)
  mainWindow.webContents.on('will-redirect', blockExternalNavigation)

  // HMR for the renderer in dev; the built HTML file in production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// --- settings helpers (main owns the privileged close/notify decisions) -------

function boolSetting(key: string, fallback: boolean): boolean {
  const value = getSetting(key)
  return value === undefined ? fallback : value === '1'
}

function closeToTraySetting(): boolean {
  return boolSetting('ui.closeToTray', true)
}

function notifyOnFinishSetting(): boolean {
  return boolSetting('ui.notifyOnFinish', true)
}

// --- window helpers used by the tray, notifications, and app events -----------

/** Restores and focuses the main window, re-creating it if it was destroyed. */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Shows the window and tells the renderer to open a specific run in History. */
function openRun(runId: number): void {
  showMainWindow()
  const wc = mainWindow?.webContents
  if (!wc) return
  const send = (): void => {
    if (!wc.isDestroyed()) wc.send(CHANNELS.trayOpenRun, { runId })
  }
  // A freshly created window has not loaded yet — wait so the renderer's listener
  // is mounted before the navigation message arrives.
  if (wc.isLoading()) wc.once('did-finish-load', send)
  else send()
}

/** Sends a push payload to every live window (status/output fan-out). */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

// Stabilize the userData dir name across dev and packaged builds.
app.setName('Aerie')

// Single instance: a second launch must not fight over the SQLite/WAL files.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Re-surface the window — including un-hiding it from the tray.
    showMainWindow()
  })

  // Last-resort handlers so the main process never dies invisibly.
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', { error: err.message, stack: err.stack })
  })
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', {
      error: reason instanceof Error ? reason.message : String(reason)
    })
  })

  app.whenReady().then(() => {
    // Fix the macOS GUI-launch truncated PATH so tools installed via Homebrew,
    // cargo, npm, bun, version managers (nvm), and custom dirs are detected
    // (autodiscovery). Must run before any tool lookup (listAgentInfos) and before
    // the agent runner spawns a CLI. Strategy: take the user's real LOGIN-SHELL PATH
    // (the exact env their terminal sees — picks up nvm/custom dirs a static list
    // can't predict), then merge the static well-known-dir fallback for anything the
    // shell missed. If the shell resolve fails it degrades to the static augment.
    const shellPath = loginShellPath()
    process.env.PATH = mergePaths(
      shellPath ?? '',
      augmentedPath(process.env.PATH ?? '', {
        home: app.getPath('home'),
        platform: process.platform,
        exists: existsSync
      })
    )
    // Diagnostic for "tool still not detected" reports — note the source, not the PATH itself.
    log.info('startup PATH resolved', { fromLoginShell: shellPath !== null })

    electronApp.setAppUserModelId('com.aerie.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    if (!safeStorage.isEncryptionAvailable()) {
      log.warn(
        'OS secure storage unavailable — adding accounts will fail until a keyring is present'
      )
    }

    try {
      // Open the SQLite store (also reconciles interrupted runs) before wiring IPC.
      initStore()
      // Fresh process → no run is live; drop leftover worktrees/diffs from a prior session.
      pruneAllWorktreesAndDiffs()

      // Wire the central run-events hub BEFORE IPC/agents so no early run can emit
      // status/output/finish into a hub with no subscriber:
      //  - status + output fan out to ALL windows (re-shown windows keep streaming),
      //  - a finished run fires a desktop notification,
      //  - the tray reflects live state and drives show/open/quit.
      onStatus((update) => broadcast(CHANNELS.runnerStatus, update))
      onOutput((chunk) => broadcast(CHANNELS.runnerOutput, chunk))
      onPipelineRunChange((change) => broadcast(CHANNELS.pipelineStatus, change))
      onFinished((run) => notifyRunFinished(run, openRun, notifyOnFinishSetting()))
      initTray(icon, {
        showMainWindow,
        openRun,
        quit: () => {
          isQuitting = true
          app.quit()
        }
      })

      registerIpcHandlers()
      // Start the automation poller. Idles cheaply when no pipelines are enabled (no
      // watches → no polls → no writes); a per-pipeline auto-post opt-in still gates writes.
      startPoller()
      log.info('app ready')
      createWindow()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('startup failed', {
        error: message,
        stack: err instanceof Error ? err.stack : undefined
      })
      dialog.showErrorBox('Aerie failed to start', message)
      app.exit(1)
      return
    }

    app.on('activate', function () {
      // On macOS a Dock click reactivates the app — re-surface (or re-create) the
      // window, including un-hiding it from the tray.
      showMainWindow()
    })
  })

  // Drain in-flight agents (and their subprocess trees) before quitting.
  let quitting = false
  app.on('before-quit', (event) => {
    // before-quit fires before the window 'close', so flagging here makes the
    // close-to-tray intercept let the window actually close during a real quit.
    isQuitting = true
    // Stop the poller first: clears its timer and disposes the engine ports so no new
    // pipeline run is started during the shutdown drain.
    stopPoller()
    // A second quit during the drain window force-quits (skips the grace).
    if (quitting || !hasActiveRuns()) return
    event.preventDefault()
    quitting = true
    log.info('quitting — killing in-flight agents')
    killAllRuns()

    let exited = false
    const finishQuit = (): void => {
      if (exited) return
      exited = true
      destroyTray()
      app.exit(0)
    }
    // Exit the instant the active set drains to zero: a run only leaves the set
    // after its `finalize()` has persisted output + the DB status, so this both
    // shortens the common case and guarantees we don't cut off a slow process
    // tree's output writes. The 2.5s timer is a hard ceiling so an agent that
    // never dies can't block shutdown forever; a final kill sweep catches any run
    // that spawned during the grace. The timer is NOT unref'd — it must hold the
    // process open across the grace window.
    const offDrain = onChange(() => {
      if (!hasActiveRuns()) {
        offDrain()
        finishQuit()
      }
    })
    setTimeout(() => {
      offDrain()
      killAllRuns()
      finishQuit()
    }, 2500)
  })

  // Remove the OS tray icon promptly on a normal (non-drain) quit.
  app.on('will-quit', () => {
    destroyTray()
  })

  app.on('window-all-closed', () => {
    // With close-to-tray on, the window hides rather than closes, so this rarely
    // fires; honor the setting and the platform convention when it does.
    if (closeToTraySetting()) return
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
