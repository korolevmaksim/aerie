import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AccountSummary, RepoSummary, ReviewHistoryItem } from '@shared/types'
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
type HistoryOpenTarget = { kind: 'run' | 'group'; id: number }

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'aerie.sidebarCollapsed'
const IS_MACOS =
  /\bMac\b/.test(navigator.platform) || /\bMacintosh\b|\bMac OS X\b/.test(navigator.userAgent)

function readInitialSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function accountSwitchView(view: View): View {
  return view === 'history' || view === 'repos' || view === 'automate' ? view : 'cockpit'
}

function renderNavIcon(id: View): React.JSX.Element | null {
  const props = {
    className: 'sidebar-nav__icon',
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  } as const

  switch (id) {
    case 'cockpit':
      return (
        <svg {...props}>
          <rect width="7" height="9" x="3" y="3" rx="1" />
          <rect width="7" height="5" x="14" y="3" rx="1" />
          <rect width="7" height="9" x="14" y="12" rx="1" />
          <rect width="7" height="5" x="3" y="16" rx="1" />
        </svg>
      )
    case 'repos':
      return (
        <svg {...props}>
          <line x1="6" x2="6" y1="3" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      )
    case 'history':
      return (
        <svg {...props}>
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l4 2" />
        </svg>
      )
    case 'automate':
      return (
        <svg {...props}>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      )
    case 'tools':
      return (
        <svg {...props}>
          <rect width="16" height="16" x="4" y="4" rx="2" />
          <rect width="6" height="6" x="9" y="9" rx="1" />
          <path d="M9 1v3" />
          <path d="M15 1v3" />
          <path d="M9 20v3" />
          <path d="M15 20v3" />
          <path d="M20 9h3" />
          <path d="M20 15h3" />
          <path d="M1 9h3" />
          <path d="M1 15h3" />
        </svg>
      )
    case 'accounts':
      return (
        <svg {...props}>
          <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      )
    default:
      return null
  }
}

function App(): React.JSX.Element {
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [view, setView] = useState<View>('accounts')
  const [openRepo, setOpenRepo] = useState<RepoSummary | null>(null)
  // A run/group the tray, notification, or cockpit asked us to open; consumed by History.
  const [pendingHistoryTarget, setPendingHistoryTarget] = useState<HistoryOpenTarget | null>(null)
  // Command palette (M14): Cmd/Ctrl-K opens it; repos are loaded lazily for "jump to repo".
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteRepos, setPaletteRepos] = useState<RepoSummary[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readInitialSidebarCollapsed)

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
      setPendingHistoryTarget({ kind: 'run', id: payload.runId })
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

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? '1' : '0')
    } catch {
      // Ignore storage failures; the toggle still works for the current window.
    }
  }, [sidebarCollapsed])

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
          setView(accountSwitchView)
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

  const openHistoryItem = (item: ReviewHistoryItem): void => {
    setOpenRepo(null)
    setView('history')
    setPendingHistoryTarget({ kind: item.kind, id: item.id })
  }

  const openRunGroupFromAutomate = (groupId: number): void => {
    setOpenRepo(null)
    setView('history')
    setPendingHistoryTarget({ kind: 'group', id: groupId })
  }

  const openRepoFromCockpit = (repo: RepoSummary): void => {
    setOpenRepo(repo)
    setView('repos')
  }

  const navigate = (target: Exclude<View, 'cockpit'>): void => {
    setOpenRepo(null)
    setView(target)
  }

  const sidebarToggleLabel = sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
  const shellClassName = [
    'app',
    'app-shell',
    IS_MACOS ? 'app-shell--mac' : '',
    sidebarCollapsed ? 'app-shell--sidebar-collapsed' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const navItems: {
    id: View
    label: string
    shortLabel: string
    hint: string
    disabled?: boolean
  }[] = [
    {
      id: 'cockpit',
      label: 'Cockpit',
      shortLabel: 'Co',
      hint: 'Active reviews and next actions',
      disabled: !reposReady
    },
    {
      id: 'repos',
      label: 'Repositories',
      shortLabel: 'Re',
      hint: 'Pick a commit, PR, or working tree',
      disabled: !reposReady
    },
    {
      id: 'history',
      label: 'Run history',
      shortLabel: 'Hi',
      hint: 'Logs, findings, copies, and re-runs'
    },
    { id: 'automate', label: 'Automate', shortLabel: 'Au', hint: 'Local polling pipelines' },
    {
      id: 'tools',
      label: 'Agents & tools',
      shortLabel: 'To',
      hint: 'Installed CLIs and approval'
    },
    {
      id: 'accounts',
      label: 'Accounts',
      shortLabel: 'Ac',
      hint: 'GitHub tokens and rate limits'
    },
    { id: 'settings', label: 'Settings', shortLabel: 'Se', hint: 'Prompts, presets, and safety' }
  ]

  return (
    <div className={shellClassName}>
      <div className="window-drag-region" aria-hidden="true" />
      <aside id="aerie-sidebar" className="sidebar" aria-label="Aerie workspace navigation">
        <div className="sidebar__top">
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
          <button
            className="sidebar-toggle"
            type="button"
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            aria-label={sidebarToggleLabel}
            aria-controls="aerie-sidebar"
            aria-expanded={!sidebarCollapsed}
            title={sidebarToggleLabel}
          >
            <span className="sidebar-toggle__icon" aria-hidden="true" />
          </button>
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
                setView(accountSwitchView)
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
              aria-label={`${item.label}: ${item.hint}`}
              title={`${item.label} — ${item.hint}`}
            >
              <span className="sidebar-nav__icon-wrapper" aria-hidden="true">
                {renderNavIcon(item.id)}
              </span>
              <span className="sidebar-nav__info">
                <span className="sidebar-nav__text">{item.label}</span>
                <small className="sidebar-nav__hint">{item.hint}</small>
              </span>
            </button>
          ))}
        </nav>
        <button
          className="sidebar-command"
          type="button"
          onClick={() => setPaletteOpen(true)}
          aria-label="Open command palette"
          title="Open command palette"
        >
          <span className="sidebar-command__inner">
            <svg
              className="sidebar-command__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              width="14"
              height="14"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <span className="sidebar-command__label">Command palette</span>
          </span>
          <kbd className="sidebar-command__kbd">⌘K</kbd>
        </button>
      </aside>
      <main className="content workspace">
        {view === 'cockpit' && reposReady ? (
          <MissionControlPanel
            accountId={selectedId}
            onNavigate={navigate}
            onOpenRepo={openRepoFromCockpit}
            onOpenRun={openHistoryItem}
          />
        ) : view === 'tools' ? (
          <ToolsPanel />
        ) : view === 'automate' ? (
          <AutomatePanel accountId={selectedId} onOpenRunGroup={openRunGroupFromAutomate} />
        ) : view === 'accounts' || !reposReady ? (
          <AccountsPanel onAccountsChanged={reloadAccounts} />
        ) : view === 'history' ? (
          <HistoryPanel
            key={selectedId}
            accountId={selectedId}
            externalTarget={pendingHistoryTarget}
            onConsumed={() => setPendingHistoryTarget(null)}
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
