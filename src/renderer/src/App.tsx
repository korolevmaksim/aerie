import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AccountSummary, RepoSummary } from '@shared/types'
import { clickableRow } from './lib/a11y'
import type { PaletteCommand } from './lib/palette'
import AccountsPanel from './components/AccountsPanel'
import CommandPalette from './components/CommandPalette'
import ReposPanel from './components/ReposPanel'
import RepoView from './components/RepoView'
import HistoryPanel from './components/HistoryPanel'
import SettingsPanel from './components/SettingsPanel'
import ToolsPanel from './components/ToolsPanel'

type View = 'repos' | 'accounts' | 'history' | 'tools' | 'settings'

function App(): React.JSX.Element {
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [view, setView] = useState<View>('accounts')
  const [openRepo, setOpenRepo] = useState<RepoSummary | null>(null)
  // A run the tray (or a finish notification) asked us to open; consumed by History.
  const [pendingRunId, setPendingRunId] = useState<number | null>(null)
  // Command palette (M14): Cmd/Ctrl-K opens it; repos are loaded lazily for "jump to repo".
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteRepos, setPaletteRepos] = useState<RepoSummary[]>([])

  const reloadAccounts = useCallback(async (): Promise<void> => {
    const list = await window.aerie.accounts.list()
    setAccounts(list)
    setSelectedId((prev) =>
      prev && list.some((a) => a.id === prev) ? prev : (list[0]?.id ?? null)
    )
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await window.aerie.accounts.list()
      if (cancelled) return
      setAccounts(list)
      setSelectedId(list[0]?.id ?? null)
      setView(list.length === 0 ? 'accounts' : 'repos')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Open-from-tray / open-from-notification: jump to History and let it select
  // the run. Guard the payload so a malformed message can't drive a refetch loop.
  useEffect(() => {
    return window.aerie.onTrayOpenRun((payload) => {
      if (typeof payload?.runId !== 'number') return
      setView('history')
      setPendingRunId(payload.runId)
    })
  }, [])

  const goRepos = (): void => {
    setView('repos')
    setOpenRepo(null)
  }

  const reposReady = selectedId !== null

  // Cmd/Ctrl-K toggles the command palette (Esc closes it from inside the palette).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Lazily load the selected account's (cached) repos the first time the palette opens,
  // so "jump to repo" has something to match. Cheap (ETag-cached, ~0 quota).
  useEffect(() => {
    if (!paletteOpen || selectedId === null) return
    let cancelled = false
    void (async () => {
      const res = await window.aerie.repos.list(selectedId)
      if (!cancelled && res.ok) setPaletteRepos(res.value.repos)
    })()
    return () => {
      cancelled = true
    }
  }, [paletteOpen, selectedId])

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const cmds: PaletteCommand[] = []
    const views: { id: View; title: string }[] = [
      { id: 'repos', title: 'Repos' },
      { id: 'history', title: 'History' },
      { id: 'tools', title: 'Tools' },
      { id: 'accounts', title: 'Accounts' },
      { id: 'settings', title: 'Settings' }
    ]
    for (const v of views) {
      if (v.id === 'repos' && !reposReady) continue
      cmds.push({
        id: `view:${v.id}`,
        title: `Go to ${v.title}`,
        group: 'Views',
        run: () => (v.id === 'repos' ? goRepos() : setView(v.id))
      })
    }
    for (const a of accounts) {
      cmds.push({
        id: `account:${a.id}`,
        title: `Switch account: ${a.login}`,
        hint: a.label,
        group: 'Accounts',
        run: () => {
          setSelectedId(a.id)
          setOpenRepo(null)
          setView('repos')
        }
      })
    }
    for (const repo of paletteRepos) {
      cmds.push({
        id: `repo:${repo.id}`,
        title: `Open ${repo.fullName}`,
        hint: 'repository',
        group: 'Repos',
        run: () => {
          setOpenRepo(repo)
          setView('repos')
        }
      })
    }
    return cmds
  }, [accounts, paletteRepos, reposReady])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span
            className="wordmark"
            aria-label="Aerie — go to repositories"
            {...clickableRow(goRepos)}
          >
            Aerie
          </span>
          <span className="tagline">GitHub mission control</span>
        </div>
        <div className="topbar__right">
          {accounts.length > 0 && (
            <select
              className="field account-select"
              aria-label="Account"
              value={selectedId ?? ''}
              onChange={(e) => {
                setSelectedId(Number(e.target.value))
                setOpenRepo(null)
                // Switching account is the way to re-scope History, so stay on it
                // when it's open; otherwise fall back to the account's repo list.
                setView((v) => (v === 'history' ? 'history' : 'repos'))
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.login} · {a.label}
                </option>
              ))}
            </select>
          )}
          <nav className="tabs" aria-label="Views">
            <button
              className={`tab ${view === 'repos' ? 'tab--active' : ''}`}
              onClick={goRepos}
              disabled={!reposReady}
              aria-current={view === 'repos' ? 'page' : undefined}
            >
              Repos
            </button>
            <button
              className={`tab ${view === 'history' ? 'tab--active' : ''}`}
              onClick={() => setView('history')}
              aria-current={view === 'history' ? 'page' : undefined}
            >
              History
            </button>
            <button
              className={`tab ${view === 'tools' ? 'tab--active' : ''}`}
              onClick={() => setView('tools')}
              aria-current={view === 'tools' ? 'page' : undefined}
            >
              Tools
            </button>
            <button
              className={`tab ${view === 'accounts' ? 'tab--active' : ''}`}
              onClick={() => setView('accounts')}
              aria-current={view === 'accounts' ? 'page' : undefined}
            >
              Accounts
            </button>
            <button
              className={`tab ${view === 'settings' ? 'tab--active' : ''}`}
              onClick={() => setView('settings')}
              aria-current={view === 'settings' ? 'page' : undefined}
            >
              Settings
            </button>
          </nav>
        </div>
      </header>
      <main className="content">
        {view === 'tools' ? (
          <ToolsPanel />
        ) : view === 'accounts' || !reposReady ? (
          <AccountsPanel onAccountsChanged={reloadAccounts} />
        ) : view === 'history' ? (
          <HistoryPanel
            key={selectedId}
            accountId={selectedId}
            externalRunId={pendingRunId}
            onConsumed={() => setPendingRunId(null)}
          />
        ) : view === 'settings' ? (
          <SettingsPanel />
        ) : openRepo ? (
          <RepoView accountId={selectedId} repo={openRepo} onBack={() => setOpenRepo(null)} />
        ) : (
          <ReposPanel key={selectedId} accountId={selectedId} onOpenRepo={setOpenRepo} />
        )}
      </main>
      {paletteOpen && (
        <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
      )}
    </div>
  )
}

export default App
