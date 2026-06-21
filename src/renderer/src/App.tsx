import { useCallback, useEffect, useState } from 'react'
import type { AccountSummary, RepoSummary } from '@shared/types'
import AccountsPanel from './components/AccountsPanel'
import ReposPanel from './components/ReposPanel'
import RepoView from './components/RepoView'
import HistoryPanel from './components/HistoryPanel'
import SettingsPanel from './components/SettingsPanel'

type View = 'repos' | 'accounts' | 'history' | 'settings'

function App(): React.JSX.Element {
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [view, setView] = useState<View>('accounts')
  const [openRepo, setOpenRepo] = useState<RepoSummary | null>(null)
  const { electron } = window.aerie.versions

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

  const goRepos = (): void => {
    setView('repos')
    setOpenRepo(null)
  }

  const reposReady = selectedId !== null

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="wordmark" onClick={goRepos}>
            Aerie
          </span>
          <span className="tagline">GitHub mission control</span>
        </div>
        <div className="topbar__right">
          {accounts.length > 0 && (
            <select
              className="field account-select"
              value={selectedId ?? ''}
              onChange={(e) => {
                setSelectedId(Number(e.target.value))
                setOpenRepo(null)
                setView('repos')
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.login} · {a.label}
                </option>
              ))}
            </select>
          )}
          <nav className="tabs">
            <button
              className={`tab ${view === 'repos' ? 'tab--active' : ''}`}
              onClick={goRepos}
              disabled={!reposReady}
            >
              Repos
            </button>
            <button
              className={`tab ${view === 'history' ? 'tab--active' : ''}`}
              onClick={() => setView('history')}
            >
              History
            </button>
            <button
              className={`tab ${view === 'accounts' ? 'tab--active' : ''}`}
              onClick={() => setView('accounts')}
            >
              Accounts
            </button>
            <button
              className={`tab ${view === 'settings' ? 'tab--active' : ''}`}
              onClick={() => setView('settings')}
            >
              Settings
            </button>
          </nav>
          <span className="env">Electron {electron}</span>
        </div>
      </header>
      <main className="content">
        {view === 'accounts' || !reposReady ? (
          <AccountsPanel onAccountsChanged={reloadAccounts} />
        ) : view === 'history' ? (
          <HistoryPanel />
        ) : view === 'settings' ? (
          <SettingsPanel />
        ) : openRepo ? (
          <RepoView accountId={selectedId} repo={openRepo} onBack={() => setOpenRepo(null)} />
        ) : (
          <ReposPanel key={selectedId} accountId={selectedId} onOpenRepo={setOpenRepo} />
        )}
      </main>
    </div>
  )
}

export default App
