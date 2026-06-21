import { useCallback, useEffect, useState } from 'react'
import type { RunHistoryItem } from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import RunView from './RunView'

function HistoryPanel(): React.JSX.Element {
  const [runs, setRuns] = useState<RunHistoryItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<RunHistoryItem | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const res = await window.aerie.runner.listAllRuns()
    if (res.ok) setRuns(res.value)
    setLoaded(true)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.runner.listAllRuns()
      if (cancelled) return
      if (res.ok) setRuns(res.value)
      setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (selected) {
    return (
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">
            <button
              className="btn btn--ghost back"
              onClick={() => {
                setSelected(null)
                void reload()
              }}
            >
              ←
            </button>
            {selected.repoFullName}{' '}
            <span className="muted">
              · {selected.agentId} ·{' '}
              {selected.refType === 'pr' ? `PR #${selected.refId}` : selected.headSha.slice(0, 8)}
            </span>
          </h2>
        </div>
        <RunView key={selected.id} run={selected} />
      </section>
    )
  }

  return (
    <section className="panel">
      <h2 className="panel__title">Run history</h2>
      {!loaded ? (
        <p className="empty">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="empty">No runs yet. Use “Review with agent” on a commit or PR.</p>
      ) : (
        <ul className="commits">
          {runs.map((r) => (
            <li
              key={r.id}
              className="commit-row history-row history-row--clickable"
              onClick={() => setSelected(r)}
            >
              <span className={`chip run__status run__status--${r.status}`}>{r.status}</span>
              <span className="commit-row__msg">{r.repoFullName}</span>
              <code className="sha">
                {r.refType === 'pr' ? `PR #${r.refId}` : r.headSha.slice(0, 8)}
              </code>
              <span className="muted">{r.agentId}</span>
              <span className="muted">{formatRelativeTime(r.startedAt)}</span>
              {r.postedUrl && (
                <a
                  className="link"
                  href={r.postedUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  posted ↗
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default HistoryPanel
