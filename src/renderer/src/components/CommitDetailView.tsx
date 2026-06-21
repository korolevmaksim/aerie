import { useEffect, useState } from 'react'
import type { CommitDetail, PrepareResult } from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import DiffView from './DiffView'
import RunPanel from './RunPanel'

function CommitDetailView({
  accountId,
  repoId,
  repoFullName,
  sha,
  onBack
}: {
  accountId: number
  repoId: number
  repoFullName: string
  sha: string
  onBack: () => void
}): React.JSX.Element {
  const [commit, setCommit] = useState<CommitDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedSha, setLoadedSha] = useState<string | null>(null)
  const loading = loadedSha !== sha
  const [preparing, setPreparing] = useState(false)
  const [prepared, setPrepared] = useState<PrepareResult | null>(null)
  const [prepareError, setPrepareError] = useState<string | null>(null)

  const onPrepare = async (): Promise<void> => {
    setPreparing(true)
    setPrepareError(null)
    try {
      const res = await window.aerie.git.prepare(accountId, repoId, sha)
      if (res.ok) setPrepared(res.value)
      else setPrepareError(res.error)
    } finally {
      setPreparing(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.repo.commit(accountId, repoFullName, sha)
      if (cancelled) return
      if (res.ok) {
        setCommit(res.value)
        setError(null)
      } else {
        setError(res.error)
        setCommit(null)
      }
      // Reset any prepare result from a previously-viewed commit.
      setPrepared(null)
      setPrepareError(null)
      setLoadedSha(sha)
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, repoFullName, sha])

  const [subject, ...rest] = (commit?.message ?? '').split('\n')
  const body = rest.join('\n').trim()

  return (
    <section className="panel">
      <button className="btn btn--ghost back" onClick={onBack}>
        ← Back
      </button>

      {loading ? (
        <p className="empty">Loading commit…</p>
      ) : error ? (
        <p className="alert">{error}</p>
      ) : commit ? (
        <>
          <h2 className="panel__title commit-subject">{subject}</h2>
          {body && <pre className="commit-body">{body}</pre>}
          <div className="commit-meta">
            <code className="sha">{commit.sha.slice(0, 10)}</code>
            <span className="muted">
              {commit.authorLogin ?? commit.authorName ?? 'unknown'} ·{' '}
              {formatRelativeTime(commit.authoredAt)}
            </span>
            {commit.stats && (
              <span className="muted">
                <span className="file__stat--add">+{commit.stats.additions}</span>{' '}
                <span className="file__stat--del">-{commit.stats.deletions}</span> across{' '}
                {commit.files.length} files
              </span>
            )}
            {commit.htmlUrl && (
              <a className="link" href={commit.htmlUrl} target="_blank" rel="noreferrer">
                open ↗
              </a>
            )}
          </div>

          <div className="prepare">
            <button className="btn btn--ghost" onClick={onPrepare} disabled={preparing}>
              {preparing ? 'Preparing local checkout…' : 'Prepare local checkout'}
            </button>
            {prepareError && <span className="alert prepare__err">{prepareError}</span>}
            {prepared && (
              <div className="prepare__result">
                <span className="chip">{prepared.mode}</span>
                <div className="mapping__row">
                  <span className="mapping__key">Worktree</span>
                  <code className="mapping__val">{prepared.worktreePath}</code>
                </div>
                <div className="mapping__row">
                  <span className="mapping__key">Diff file</span>
                  <code className="mapping__val">{prepared.diffPath}</code>
                </div>
              </div>
            )}
          </div>

          <RunPanel
            accountId={accountId}
            repoId={repoId}
            sha={commit.sha}
            refType="commit"
            refId={commit.sha}
            authorLogin={commit.authorLogin}
          />

          <DiffView files={commit.files} />
        </>
      ) : null}
    </section>
  )
}

export default CommitDetailView
