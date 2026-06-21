import { app, dialog, shell, BrowserWindow, safeStorage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { initStore } from './store'
import { registerIpcHandlers } from './ipc'
import { isInternalUrl, isSafeExternalUrl } from './security'
import { log } from './logger'
import { hasRunningAgents, killAllRuns } from './agentRunner'
import { pruneAllWorktreesAndDiffs } from './gitEngine'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
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
    mainWindow.show()
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

// Stabilize the userData dir name across dev and packaged builds.
app.setName('Aerie')

// Single instance: a second launch must not fight over the SQLite/WAL files.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
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
      registerIpcHandlers()
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
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Drain in-flight agents (and their subprocess trees) before quitting.
  let quitting = false
  app.on('before-quit', (event) => {
    // A second quit during the drain window force-quits (skips the grace).
    if (quitting || !hasRunningAgents()) return
    event.preventDefault()
    quitting = true
    log.info('quitting — killing in-flight agents')
    killAllRuns()
    // NOT unref'd: this timer must hold the process open for the grace window so
    // the killed children can exit and finalize before we exit.
    setTimeout(() => app.exit(0), 2500)
  })

  app.on('window-all-closed', () => {
    // On macOS apps stay active until the user quits with Cmd+Q.
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
