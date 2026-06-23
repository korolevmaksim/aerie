import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RunHistoryItem } from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import { filterRuns } from '../lib/runFilter'
import RunView from './RunView'

function HistoryPanel({
  accountId = null,
  externalRunId = null,
  onConsumed
}: {
  /** Scope the list to this account; runs from other accounts are hidden. */
  accountId?: number | null
  /** A run the tray asked to open; selected automatically when present. */
  externalRunId?: number | null
  /** Called once the external run id has been handled (found or not). */
  onConsumed?: () => void
} = {}): React.JSX.Element {
  const [runs, setRuns] = useState<RunHistoryItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState<RunHistoryItem | null>(null)
  // Repo sub-filter: a repo id, or 'all'. Options are built from the runs that
  // actually exist for this account (never the full repo list).
  const [repoFilter, setRepoFilter] = useState<number | 'all'>('all')
  // Free-text search over the already-loaded runs (repo/agent/sha/PR/status/author).
  const [query, setQuery] = useState('')
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
  // Note: this matches against the FULL run list, so a tray run from another
  // account still opens even though the visible list is scoped to one account.
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

  // Runs for the active account only — the spine the visible list and the repo
  // dropdown are both built from.
  const accountRuns = useMemo(
    () => (accountId == null ? [] : runs.filter((r) => r.accountId === accountId)),
    [runs, accountId]
  )

  // Repos that have at least one run for this account, sorted by name so a
  // specific repo is easy to find in the dropdown (the run list itself stays
  // newest-first; this only orders the filter options).
  const repoOptions = useMemo(() => {
    const seen = new Map<number, string>()
    for (const r of accountRuns) if (!seen.has(r.repoId)) seen.set(r.repoId, r.repoFullName)
    return [...seen]
      .map(([repoId, repoFullName]) => ({ repoId, repoFullName }))
      .sort((a, b) => a.repoFullName.localeCompare(b.repoFullName))
  }, [accountRuns])

  // Guard against a stale selection (e.g. a repo whose runs vanished): fall back
  // to "all" rather than silently showing an empty list.
  const effectiveRepoFilter =
    repoFilter !== 'all' && repoOptions.some((o) => o.repoId === repoFilter) ? repoFilter : 'all'

  // account → repo dropdown → free-text query. Both filters are pure + client-side.
  const repoFiltered = useMemo(
    () =>
      effectiveRepoFilter === 'all'
        ? accountRuns
        : accountRuns.filter((r) => r.repoId === effectiveRepoFilter),
    [accountRuns, effectiveRepoFilter]
  )
  const visibleRuns = useMemo(() => filterRuns(repoFiltered, query), [repoFiltered, query])

  // Safety net: while any run for THIS account is still active, re-poll the list
  // so a status that settled before this panel mounted (or any missed event)
  // still converges.
  const hasActive = accountRuns.some((r) => r.status === 'queued' || r.status === 'running')
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
        <div className="panel__head-actions">
          {accountRuns.length > 0 && (
            <input
              type="search"
              className="field history-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search runs…"
              aria-label="Search run history by repo, agent, SHA, PR, status, or author"
            />
          )}
          {repoOptions.length > 0 && (
            <select
              className="field history-repo-filter"
              value={effectiveRepoFilter === 'all' ? 'all' : String(effectiveRepoFilter)}
              onChange={(e) => {
                const v = e.target.value
                setRepoFilter(v === 'all' ? 'all' : Number(v))
              }}
              title="Filter by repository"
              aria-label="Filter run history by repository"
            >
              <option value="all">All repositories</option>
              {repoOptions.map((o) => (
                <option key={o.repoId} value={String(o.repoId)}>
                  {o.repoFullName}
                </option>
              ))}
            </select>
          )}
          <button
            className="btn btn--ghost"
            onClick={() => void refresh()}
            disabled={refreshing}
            title="Refresh run statuses"
          >
            {refreshing ? 'Refreshing…' : hasActive ? 'Refresh · live' : 'Refresh'}
          </button>
        </div>
      </div>
      {!loaded ? (
        <p className="empty">Loading…</p>
      ) : accountRuns.length === 0 ? (
        <p className="empty">
          No runs yet for this account. Use “Review with agent” on a commit or PR.
        </p>
      ) : visibleRuns.length === 0 ? (
        <p className="empty">
          {query.trim()
            ? `No runs match “${query.trim()}”.`
            : 'No runs for the selected repository.'}
        </p>
      ) : (
        <ul className="commits">
          {visibleRuns.map((r) => (
            // The row stays a listitem; the open action is a real <button> (keyboard-operable,
            // its text content is the accessible name) and the optional "posted" link is a
            // SIBLING control — never nested inside the button (no interactive-in-interactive).
            <li key={r.id} className="history-row">
              <button type="button" className="history-row__open" onClick={() => setSelected(r)}>
                <span className={`chip run__status run__status--${r.status}`}>{r.status}</span>
                <span className="commit-row__msg">{r.repoFullName}</span>
                <code className="sha">
                  {r.refType === 'pr' ? `PR #${r.refId}` : r.headSha.slice(0, 8)}
                </code>
                <span className="muted">{r.agentId}</span>
                <span className="muted">{formatRelativeTime(r.startedAt)}</span>
              </button>
              {r.postedUrl && (
                <a
                  className="link history-row__posted"
                  href={r.postedUrl}
                  target="_blank"
                  rel="noreferrer"
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
