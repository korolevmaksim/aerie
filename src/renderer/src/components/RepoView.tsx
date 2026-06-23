import { useEffect, useState } from 'react'
import type { BranchSummary, CommitSummary, PullRequestSummary, RepoSummary } from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import CommitDetailView from './CommitDetailView'
import PrDetailView from './PrDetailView'
import RepoMappingPanel from './RepoMappingPanel'
import WorkingTreeView from './WorkingTreeView'

type Detail = { kind: 'commit'; sha: string } | { kind: 'pull'; number: number } | null

function CommitsTab({
  accountId,
  repo,
  onOpenCommit
}: {
  accountId: number
  repo: RepoSummary
  onOpenCommit: (sha: string) => void
}): React.JSX.Element {
  const [branches, setBranches] = useState<BranchSummary[]>([])
  const [branch, setBranch] = useState(repo.defaultBranch ?? '')
  const [commits, setCommits] = useState<CommitSummary[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadedBranch, setLoadedBranch] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const loading = loadedBranch !== branch

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.repo.branches(accountId, repo.fullName)
      if (!cancelled && res.ok) setBranches(res.value)
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, repo.fullName])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.repo.commits(accountId, repo.fullName, { branch, page: 1 })
      if (cancelled) return
      if (res.ok) {
        setCommits(res.value.items)
        setHasMore(res.value.hasMore)
        setPage(1)
        setError(null)
      } else {
        setError(res.error)
        setCommits([])
      }
      setLoadedBranch(branch)
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, repo.fullName, branch])

  const onMore = async (): Promise<void> => {
    setMore(true)
    try {
      const next = page + 1
      const res = await window.aerie.repo.commits(accountId, repo.fullName, { branch, page: next })
      if (res.ok) {
        // GitHub uses offset pagination, so a concurrent push can shift items;
        // dedupe by sha guarantees we never render a row twice.
        setCommits((prev) => {
          const seen = new Set(prev.map((c) => c.sha))
          return [...prev, ...res.value.items.filter((c) => !seen.has(c.sha))]
        })
        setHasMore(res.value.hasMore)
        setPage(next)
      } else {
        setError(res.error)
      }
    } finally {
      setMore(false)
    }
  }

  return (
    <>
      {branches.length > 0 && (
        <select
          className="field branch-select"
          aria-label="Branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        >
          {branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
      )}
      {!loading && error && <p className="alert">{error}</p>}
      {loading ? (
        <p className="empty">Loading commits…</p>
      ) : commits.length === 0 ? (
        <p className="empty">No commits.</p>
      ) : (
        <>
          <ul className="commits">
            {commits.map((c) => (
              <li key={c.sha}>
                <button type="button" className="commit-row" onClick={() => onOpenCommit(c.sha)}>
                  <code className="sha">{c.sha.slice(0, 8)}</code>
                  <span className="commit-row__msg">{c.message.split('\n')[0]}</span>
                  <span className="muted">
                    {c.authorLogin ?? c.authorName ?? ''} · {formatRelativeTime(c.authoredAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {hasMore && (
            <button className="btn btn--ghost more" onClick={onMore} disabled={more}>
              {more ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </>
  )
}

function PullsTab({
  accountId,
  repo,
  onOpenPull
}: {
  accountId: number
  repo: RepoSummary
  onOpenPull: (n: number) => void
}): React.JSX.Element {
  const [pulls, setPulls] = useState<PullRequestSummary[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [more, setMore] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.repo.pulls(accountId, repo.fullName, { page: 1 })
      if (cancelled) return
      if (res.ok) {
        setPulls(res.value.items)
        setHasMore(res.value.hasMore)
        setPage(1)
        setError(null)
      } else {
        setError(res.error)
        setPulls([])
      }
      setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, repo.fullName])

  const onMore = async (): Promise<void> => {
    setMore(true)
    try {
      const next = page + 1
      const res = await window.aerie.repo.pulls(accountId, repo.fullName, { page: next })
      if (res.ok) {
        setPulls((prev) => {
          const seen = new Set(prev.map((p) => p.number))
          return [...prev, ...res.value.items.filter((p) => !seen.has(p.number))]
        })
        setHasMore(res.value.hasMore)
        setPage(next)
      } else {
        setError(res.error)
      }
    } finally {
      setMore(false)
    }
  }

  if (!loaded) return <p className="empty">Loading pull requests…</p>
  if (error) return <p className="alert">{error}</p>
  if (pulls.length === 0) return <p className="empty">No open pull requests.</p>

  return (
    <>
      <ul className="commits">
        {pulls.map((p) => (
          <li key={p.number}>
            <button type="button" className="commit-row" onClick={() => onOpenPull(p.number)}>
              <span className="muted">#{p.number}</span>
              <span className="commit-row__msg">{p.title}</span>
              <span className="muted">
                {p.authorLogin ?? ''} · {formatRelativeTime(p.createdAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button className="btn btn--ghost more" onClick={onMore} disabled={more}>
          {more ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  )
}

function RepoView({
  accountId,
  repo,
  onBack
}: {
  accountId: number
  repo: RepoSummary
  onBack: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<'commits' | 'pulls' | 'worktree'>('commits')
  const [detail, setDetail] = useState<Detail>(null)
  const [showMapping, setShowMapping] = useState(false)

  if (detail?.kind === 'commit') {
    return (
      <CommitDetailView
        accountId={accountId}
        repoId={repo.id}
        repoFullName={repo.fullName}
        sha={detail.sha}
        onBack={() => setDetail(null)}
      />
    )
  }
  if (detail?.kind === 'pull') {
    return (
      <PrDetailView
        accountId={accountId}
        repoId={repo.id}
        repoFullName={repo.fullName}
        number={detail.number}
        onBack={() => setDetail(null)}
        onOpenCommit={(sha) => setDetail({ kind: 'commit', sha })}
      />
    )
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">
          <button className="btn btn--ghost back" onClick={onBack}>
            ←
          </button>
          {repo.fullName}
        </h2>
        <div className="tabs">
          <button
            className={`tab ${tab === 'commits' ? 'tab--active' : ''}`}
            onClick={() => setTab('commits')}
          >
            Commits
          </button>
          <button
            className={`tab ${tab === 'pulls' ? 'tab--active' : ''}`}
            onClick={() => setTab('pulls')}
          >
            Pull Requests
          </button>
          <button
            className={`tab ${tab === 'worktree' ? 'tab--active' : ''}`}
            onClick={() => setTab('worktree')}
          >
            Working Tree
          </button>
          <button
            className={`tab ${showMapping ? 'tab--active' : ''}`}
            onClick={() => setShowMapping((m) => !m)}
          >
            Mapping
          </button>
        </div>
      </div>

      {showMapping && <RepoMappingPanel repoId={repo.id} />}

      {tab === 'commits' ? (
        <CommitsTab
          accountId={accountId}
          repo={repo}
          onOpenCommit={(sha) => setDetail({ kind: 'commit', sha })}
        />
      ) : tab === 'pulls' ? (
        <PullsTab
          accountId={accountId}
          repo={repo}
          onOpenPull={(number) => setDetail({ kind: 'pull', number })}
        />
      ) : (
        <WorkingTreeView
          accountId={accountId}
          repoId={repo.id}
          onOpenMapping={() => setShowMapping(true)}
        />
      )}
    </section>
  )
}

export default RepoView
