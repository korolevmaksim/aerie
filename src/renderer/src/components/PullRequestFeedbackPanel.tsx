import { useEffect, useMemo, useState } from 'react'
import type { PullRequestFeedbackItem, PullRequestFeedbackResult } from '@shared/types'
import { formatRelativeTime } from '../lib/format'

function feedbackKindLabel(item: PullRequestFeedbackItem): string {
  if (item.kind === 'issue_comment') return 'PR comment'
  if (item.isResolved === false)
    return item.isOutdated ? 'Unresolved outdated thread' : 'Unresolved thread'
  if (item.isResolved === true)
    return item.isOutdated ? 'Resolved outdated thread' : 'Resolved thread'
  return item.isOutdated ? 'Outdated review thread' : 'Review thread'
}

function feedbackLocation(item: PullRequestFeedbackItem): string {
  if (!item.path) return 'PR'
  return `${item.path}${item.line !== null ? `:${item.line}` : ''}`
}

function PullRequestFeedbackPanel({
  accountId,
  repoId,
  repoFullName,
  number
}: {
  accountId: number
  repoId: number
  repoFullName: string
  number: number
}): React.JSX.Element {
  const [data, setData] = useState<PullRequestFeedbackResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const requestKey = `${accountId}:${repoId}:${number}`
  const loading = loadedKey !== requestKey
  const busy = loading || refreshing

  const load = async (manual = false): Promise<void> => {
    if (manual) setRefreshing(true)
    const res = await window.aerie.repo.pullFeedback(accountId, repoId, repoFullName, number)
    if (res.ok) {
      setData(res.value)
      setError(null)
    } else {
      setError(res.error)
    }
    setLoadedKey(requestKey)
    if (manual) setRefreshing(false)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.repo.pullFeedback(accountId, repoId, repoFullName, number)
      if (cancelled) return
      if (res.ok) {
        setData(res.value)
        setError(null)
      } else {
        setError(res.error)
      }
      setLoadedKey(requestKey)
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, repoId, repoFullName, number, requestKey])

  const visibleItems = useMemo(
    () => (loading ? [] : (data?.items.slice(0, 12) ?? [])),
    [data, loading]
  )
  const summary = loading ? null : data?.summary

  return (
    <section className="pr-feedback" aria-busy={busy}>
      <div className="pr-feedback__head">
        <div>
          <h3 className="subhead">PR feedback</h3>
          {summary?.lastSyncedAt && (
            <p className="pr-feedback__sync">Synced {formatRelativeTime(summary.lastSyncedAt)}</p>
          )}
        </div>
        <button className="btn btn--ghost" onClick={() => void load(true)} disabled={busy}>
          {busy ? 'Syncing...' : 'Refresh'}
        </button>
      </div>

      {error && <p className="alert">{error}</p>}

      {summary && (
        <div className="pr-feedback__metrics">
          <span className="chip">{summary.total} items</span>
          <span className="chip">{summary.unresolvedThreads} unresolved</span>
          <span className="chip">{summary.resolvedThreads} resolved</span>
          <span className="chip">{summary.issueComments} PR comments</span>
        </div>
      )}

      {loading ? (
        <p className="empty">Loading PR feedback...</p>
      ) : visibleItems.length === 0 ? (
        <p className="empty">No PR comments or review threads found.</p>
      ) : (
        <ul className="pr-feedback__list">
          {visibleItems.map((item) => (
            <li key={item.id} className="pr-feedback__item">
              <div className="pr-feedback__item-head">
                <span className="chip">{feedbackKindLabel(item)}</span>
                <code>{feedbackLocation(item)}</code>
                <span className="muted">{item.authorLogin ?? 'unknown'}</span>
                <span className="muted">
                  {formatRelativeTime(item.updatedAt ?? item.createdAt)}
                </span>
                {item.url && (
                  <a className="link" href={item.url} target="_blank" rel="noreferrer">
                    open
                  </a>
                )}
              </div>
              {item.body && <p className="pr-feedback__body">{item.body}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default PullRequestFeedbackPanel
