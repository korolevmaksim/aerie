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
import AutomatePanel from './components/AutomatePanel'
import MissionControlPanel from './components/MissionControlPanel'

type View = 'cockpit' | 'repos' | 'accounts' | 'history' | 'tools' | 'automate' | 'settings'

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
      setView(list.length === 0 ? 'accounts' : 'cockpit')
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

  const goHome = (): void => {
    setView(reposReady ? 'cockpit' : 'accounts')
    setOpenRepo(null)
  }

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
      { id: 'cockpit', title: 'Review cockpit' },
      { id: 'repos', title: 'Repos' },
      { id: 'history', title: 'History' },
      { id: 'tools', title: 'Tools' },
      { id: 'automate', title: 'Automate' },
      { id: 'accounts', title: 'Accounts' },
      { id: 'settings', title: 'Settings' }
    ]
    for (const v of views) {
      if (v.id === 'cockpit' && !reposReady) continue
      if (v.id === 'repos' && !reposReady) continue
      cmds.push({
        id: `view:${v.id}`,
        title: `Go to ${v.title}`,
        group: 'Views',
        run: () => {
          setOpenRepo(null)
          if (v.id === 'repos') goRepos()
          else setView(v.id)
        }
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

  const openHistoryRun = (runId: number): void => {
    setOpenRepo(null)
    setView('history')
    setPendingRunId(runId)
  }

  const openRepoFromCockpit = (repo: RepoSummary): void => {
    setOpenRepo(repo)
    setView('repos')
  }

  const navigate = (target: Exclude<View, 'cockpit'>): void => {
    setOpenRepo(null)
    setView(target)
  }

  const navItems: { id: View; label: string; hint: string; disabled?: boolean }[] = [
    {
      id: 'cockpit',
      label: 'Cockpit',
      hint: 'Active reviews and next actions',
      disabled: !reposReady
    },
    {
      id: 'repos',
      label: 'Repositories',
      hint: 'Pick a commit, PR, or working tree',
      disabled: !reposReady
    },
    { id: 'history', label: 'Run history', hint: 'Logs, findings, copies, and re-runs' },
    { id: 'automate', label: 'Automate', hint: 'Local polling pipelines' },
    { id: 'tools', label: 'Agents & tools', hint: 'Installed CLIs and approval' },
    { id: 'accounts', label: 'Accounts', hint: 'GitHub tokens and rate limits' },
    { id: 'settings', label: 'Settings', hint: 'Prompts, presets, and safety' }
  ]

  return (
    <div className="app app-shell">
      <aside className="sidebar" aria-label="Aerie workspace navigation">
        <div className="brand">
          <span
            className="wordmark"
            aria-label="Aerie — go to review cockpit"
            {...clickableRow(goHome)}
          >
            Aerie
          </span>
          <span className="tagline">Local agent mission control</span>
        </div>
        {accounts.length > 0 && (
          <div className="sidebar__account">
            <span className="sidebar__label">Account</span>
            <select
              className="field account-select"
              aria-label="Account"
              value={selectedId ?? ''}
              onChange={(e) => {
                setSelectedId(Number(e.target.value))
                setOpenRepo(null)
                setView((v) =>
                  v === 'history' || v === 'repos' || v === 'automate' ? v : 'cockpit'
                )
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.login} · {a.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <nav className="sidebar-nav" aria-label="Views">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`sidebar-nav__item ${view === item.id ? 'sidebar-nav__item--active' : ''}`}
              onClick={() => {
                setOpenRepo(null)
                if (item.id === 'repos') goRepos()
                else setView(item.id)
              }}
              disabled={item.disabled}
              aria-current={view === item.id ? 'page' : undefined}
            >
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </button>
          ))}
        </nav>
        <button className="sidebar-command" onClick={() => setPaletteOpen(true)}>
          <span>Command palette</span>
          <kbd>Cmd K</kbd>
        </button>
      </aside>
      <main className="content workspace">
        {view === 'cockpit' && reposReady ? (
          <MissionControlPanel
            accountId={selectedId}
            onNavigate={navigate}
            onOpenRepo={openRepoFromCockpit}
            onOpenRun={openHistoryRun}
          />
        ) : view === 'tools' ? (
          <ToolsPanel />
        ) : view === 'automate' ? (
          <AutomatePanel accountId={selectedId} />
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
