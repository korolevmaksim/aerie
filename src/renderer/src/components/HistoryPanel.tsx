import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunHistoryItem } from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import RunView from './RunView'

function HistoryPanel({
  externalRunId = null,
  onConsumed
}: {
  /** A run the tray asked to open; selected automatically when present. */
  externalRunId?: number | null
  /** Called once the external run id has been handled (found or not). */
  onConsumed?: () => void
} = {}): React.JSX.Element {
  const [runs, setRuns] = useState<RunHistoryItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState<RunHistoryItem | null>(null)
  // Remember which external id we've already acted on, so a not-yet-loaded (or
  // pruned) run never drives an endless reload loop.
  const handledRunIdRef = useRef<number | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const res = await window.aerie.runner.listAllRuns()
    if (res.ok) setRuns(res.value)
    setLoaded(true)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      await reload()
    } finally {
      setRefreshing(false)
    }
  }, [reload])

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

  // Live status: a run started in this window pushes status updates here too, so
  // patch the matching row in place (running → done/error/killed) without a refetch.
  useEffect(() => {
    return window.aerie.runner.onStatus((p) => {
      setRuns((prev) =>
        prev.map((r) =>
          r.id === p.runId
            ? {
                ...r,
                status: p.status,
                exitCode: p.exitCode ?? r.exitCode,
                outputPath: p.outputPath ?? r.outputPath
              }
            : r
        )
      )
    })
  }, [])

  // Open-from-tray: select the requested run. Try the loaded list first; if it
  // isn't there yet, reload once and select if it appears. Either way mark the id
  // handled (single attempt) and notify the parent so it can clear pending state.
  useEffect(() => {
    if (externalRunId == null) {
      // Reset so re-opening the SAME run from the tray (id goes N → null → N) is
      // handled again rather than ignored as already-seen.
      handledRunIdRef.current = null
      return
    }
    if (handledRunIdRef.current === externalRunId) return
    // Wait for the initial load before deciding a missing run needs a refetch.
    if (!loaded && !runs.some((r) => r.id === externalRunId)) return

    handledRunIdRef.current = externalRunId
    void (async () => {
      let match = runs.find((r) => r.id === externalRunId)
      if (!match) {
        const res = await window.aerie.runner.listAllRuns()
        if (res.ok) {
          setRuns(res.value)
          match = res.value.find((r) => r.id === externalRunId)
        }
      }
      if (match) setSelected(match)
      onConsumed?.()
    })()
  }, [externalRunId, runs, loaded, onConsumed])

  // Safety net: while any run is still active, re-poll the list so a status that
  // settled before this panel mounted (or any missed event) still converges.
  const hasActive = runs.some((r) => r.status === 'queued' || r.status === 'running')
  useEffect(() => {
    if (!hasActive) return
    const id = setInterval(() => void reload(), 3000)
    return () => clearInterval(id)
  }, [hasActive, reload])

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
      <div className="panel__head">
        <h2 className="panel__title">Run history</h2>
        <button
          className="btn btn--ghost"
          onClick={() => void refresh()}
          disabled={refreshing}
          title="Refresh run statuses"
        >
          {refreshing ? 'Refreshing…' : hasActive ? 'Refresh · live' : 'Refresh'}
        </button>
      </div>
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
