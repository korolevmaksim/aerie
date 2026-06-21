import { useEffect, useMemo, useState } from 'react'
import type { RepoSummary } from '@shared/types'
import { formatRelativeTime } from '../lib/format'

function ReposPanel({
  accountId,
  onOpenRepo
}: {
  accountId: number
  onOpenRepo: (repo: RepoSummary) => void
}): React.JSX.Element {
  const [repos, setRepos] = useState<RepoSummary[]>([])
  const [filter, setFilter] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fromCache, setFromCache] = useState(false)
  // `loadedFor` drives a derived loading flag, so the effect never calls setState
  // synchronously (which the react-hooks rule forbids).
  const [loadedFor, setLoadedFor] = useState<number | null>(null)
  const loading = loadedFor !== accountId

  // Load (cached + ETag-aware) whenever the selected account changes.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await window.aerie.repos.list(accountId)
      if (cancelled) return
      if (result.ok) {
        setRepos(result.value.repos)
        setFromCache(result.value.fromCache)
        setError(null)
      } else {
        setError(result.error)
        setRepos([])
      }
      setLoadedFor(accountId)
    })()
    return () => {
      cancelled = true
    }
  }, [accountId])

  const onRefresh = async (): Promise<void> => {
    setRefreshing(true)
    setError(null)
    try {
      const result = await window.aerie.repos.refresh(accountId)
      if (result.ok) {
        setRepos(result.value.repos)
        setFromCache(result.value.fromCache)
      } else {
        setError(result.error)
      }
    } finally {
      setRefreshing(false)
    }
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos
  }, [repos, filter])

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">
          Repositories <span className="muted">({filtered.length})</span>
          {fromCache && <span className="chip">cached</span>}
        </h2>
        <button className="btn btn--ghost" onClick={onRefresh} disabled={refreshing || loading}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <input
        className="field field--grow filter"
        type="search"
        placeholder="Filter repositories…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {!loading && error && <p className="alert">{error}</p>}

      {loading ? (
        <p className="empty">Loading repositories…</p>
      ) : filtered.length === 0 ? (
        <p className="empty">{repos.length === 0 ? 'No repositories found.' : 'No matches.'}</p>
      ) : (
        <ul className="repos">
          {filtered.map((repo) => (
            <li key={repo.id} className="repo repo--clickable" onClick={() => onOpenRepo(repo)}>
              <div className="repo__main">
                <span className="repo__name">{repo.fullName}</span>
                <span className={`badge badge--${repo.isPrivate ? 'private' : 'public'}`}>
                  {repo.isPrivate ? 'private' : 'public'}
                </span>
              </div>
              <div className="repo__meta">
                {repo.defaultBranch && <span className="branch">{repo.defaultBranch}</span>}
                <span className="muted">pushed {formatRelativeTime(repo.pushedAt)}</span>
                {repo.htmlUrl && (
                  <a
                    className="link"
                    href={repo.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    open ↗
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default ReposPanel
