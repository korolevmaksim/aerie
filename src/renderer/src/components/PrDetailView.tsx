import { useEffect, useState } from 'react'
import type { PullRequestDetail } from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import RunPanel from './RunPanel'

function PrDetailView({
  accountId,
  repoId,
  repoFullName,
  number,
  onBack,
  onOpenCommit
}: {
  accountId: number
  repoId: number
  repoFullName: string
  number: number
  onBack: () => void
  onOpenCommit: (sha: string) => void
}): React.JSX.Element {
  const [pr, setPr] = useState<PullRequestDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedNumber, setLoadedNumber] = useState<number | null>(null)
  const loading = loadedNumber !== number

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.repo.pull(accountId, repoFullName, number)
      if (cancelled) return
      if (res.ok) {
        setPr(res.value)
        setError(null)
      } else {
        setError(res.error)
        setPr(null)
      }
      setLoadedNumber(number)
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, repoFullName, number])

  return (
    <section className="panel">
      <button className="btn btn--ghost back" onClick={onBack}>
        ← Back
      </button>

      {loading ? (
        <p className="empty">Loading pull request…</p>
      ) : error ? (
        <p className="alert">{error}</p>
      ) : pr ? (
        <>
          <h2 className="panel__title">
            <span className="muted">#{pr.number}</span> {pr.title}
          </h2>
          <div className="commit-meta">
            <span className="branch">{pr.headRef}</span>
            <span className="muted">→</span>
            <span className="branch">{pr.baseRef}</span>
            <span className="muted">
              {pr.authorLogin ?? 'unknown'} · {formatRelativeTime(pr.createdAt)}
            </span>
            {pr.htmlUrl && (
              <a className="link" href={pr.htmlUrl} target="_blank" rel="noreferrer">
                open ↗
              </a>
            )}
          </div>
          {pr.body && <pre className="commit-body">{pr.body}</pre>}
          {pr.commits.length > 0 && (
            <RunPanel
              accountId={accountId}
              repoId={repoId}
              sha={pr.commits[pr.commits.length - 1].sha}
              refType="pr"
              refId={String(pr.number)}
              authorLogin={pr.authorLogin}
            />
          )}
          <h3 className="subhead">Commits ({pr.commits.length})</h3>
          <ul className="commits">
            {pr.commits.map((c) => (
              <li key={c.sha}>
                <button type="button" className="commit-row" onClick={() => onOpenCommit(c.sha)}>
                  <code className="sha">{c.sha.slice(0, 8)}</code>
                  <span className="commit-row__msg">{c.message.split('\n')[0]}</span>
                  <span className="muted">{c.authorLogin ?? c.authorName ?? ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}

export default PrDetailView
