import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentInfo,
  PipelineWithRuns,
  PollerStatus,
  RepoSummary,
  ReviewHistoryItem
} from '@shared/types'
import {
  cockpitSummary,
  isActiveRun,
  needsHumanAttention,
  newestRuns,
  runAttentionLabel
} from '../lib/cockpit'
import { formatRelativeTime } from '../lib/format'
import { formatPollerStatus } from '../lib/pollerStatus'
import { runRefLabel } from '../lib/runConsole'

type ViewTarget = 'repos' | 'history' | 'tools' | 'automate' | 'accounts' | 'settings'

function loadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  if (typeof error === 'string' && error.trim().length > 0) return error
  return 'Failed to load cockpit data.'
}

function RunRow({
  run,
  onOpenRun
}: {
  run: ReviewHistoryItem
  onOpenRun: (run: ReviewHistoryItem) => void
}): React.JSX.Element {
  const agentLabel = run.kind === 'group' ? `panel · ${run.agentIds.length} agents` : run.agentId
  return (
    <li>
      <button type="button" className="cockpit-run-row" onClick={() => onOpenRun(run)}>
        <span className={`chip run__status run__status--${run.status}`}>{run.status}</span>
        <span className="cockpit-run-row__target">
          <strong>{run.repoFullName}</strong>
          <span className="cockpit-run-row__meta">
            <span className="cockpit-run-row__agent">{agentLabel}</span>
            <span aria-hidden="true">·</span>
            <span className="cockpit-run-row__ref">{runRefLabel(run)}</span>
          </span>
        </span>
        <span className="cockpit-run-row__result">{runAttentionLabel(run)}</span>
        <span className="cockpit-run-row__time">{formatRelativeTime(run.startedAt)}</span>
      </button>
    </li>
  )
}

function RepoShortcut({
  repo,
  onOpenRepo
}: {
  repo: RepoSummary
  onOpenRepo: (repo: RepoSummary) => void
}): React.JSX.Element {
  return (
    <button type="button" className="cockpit-repo" onClick={() => onOpenRepo(repo)}>
      <span>
        <strong>{repo.fullName}</strong>
        <span className="muted">
          {repo.defaultBranch ?? 'default branch'} · pushed {formatRelativeTime(repo.pushedAt)}
        </span>
      </span>
      <span className={`badge badge--${repo.isPrivate ? 'private' : 'public'}`}>
        {repo.isPrivate ? 'private' : 'public'}
      </span>
    </button>
  )
}

function Metric({
  label,
  value,
  tone = 'neutral',
  loading = false
}: {
  label: string
  value: number | string
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
  loading?: boolean
}): React.JSX.Element {
  return (
    <div
      className={`cockpit-metric cockpit-metric--${tone}${loading ? ' cockpit-metric--loading' : ''}`}
    >
      <span className={`cockpit-metric__value${loading ? ' loading-skeleton' : ''}`}>{value}</span>
      <span className="cockpit-metric__label">{label}</span>
    </div>
  )
}

function MissionControlPanel({
  accountId,
  onNavigate,
  onOpenRepo,
  onOpenRun
}: {
  accountId: number
  onNavigate: (view: ViewTarget) => void
  onOpenRepo: (repo: RepoSummary) => void
  onOpenRun: (run: ReviewHistoryItem) => void
}): React.JSX.Element {
  const [repos, setRepos] = useState<RepoSummary[]>([])
  const [runs, setRuns] = useState<ReviewHistoryItem[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [pipelines, setPipelines] = useState<PipelineWithRuns[]>([])
  const [poller, setPoller] = useState<PollerStatus | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [loadedFor, setLoadedFor] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeAccountIdRef = useRef(accountId)
  const mountedRef = useRef(true)
  const loadIdRef = useRef(0)
  const loadedForRef = useRef<number | null>(null)
  const loading = loadedFor !== accountId

  useLayoutEffect(() => {
    activeAccountIdRef.current = accountId
  }, [accountId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    loadedForRef.current = loadedFor
  }, [loadedFor])

  const load = useCallback(
    async (isCancelled: () => boolean = () => false): Promise<void> => {
      const loadAccountId = accountId
      const loadId = loadIdRef.current + 1
      loadIdRef.current = loadId
      const canApply = (): boolean =>
        mountedRef.current &&
        !isCancelled() &&
        activeAccountIdRef.current === loadAccountId &&
        loadIdRef.current === loadId

      try {
        const [repoRes, runRes, agentRes, pipelineRes, pollerRes] = await Promise.all([
          window.aerie.repos.list(loadAccountId),
          window.aerie.runner.listAllRuns(),
          window.aerie.runner.listAgents(),
          window.aerie.pipelines.list(),
          window.aerie.pipelines.pollerStatus()
        ])
        if (!canApply()) return

        const alreadyLoaded = loadedForRef.current === loadAccountId
        const errors: string[] = []
        if (repoRes.ok) setRepos(repoRes.value.repos)
        else {
          errors.push(repoRes.error)
          if (!alreadyLoaded) setRepos([])
        }
        if (runRes.ok) setRuns(runRes.value.filter((run) => run.accountId === loadAccountId))
        else {
          errors.push(runRes.error)
          if (!alreadyLoaded) setRuns([])
        }
        if (agentRes.ok) setAgents(agentRes.value)
        else {
          errors.push(agentRes.error)
          if (!alreadyLoaded) setAgents([])
        }
        if (pipelineRes.ok) setPipelines(pipelineRes.value)
        else {
          errors.push(pipelineRes.error)
          if (!alreadyLoaded) setPipelines([])
        }
        if (pollerRes.ok) setPoller(pollerRes.value)
        else {
          errors.push(pollerRes.error)
          if (!alreadyLoaded) setPoller(null)
        }

        setError(errors[0] ?? null)
        loadedForRef.current = loadAccountId
        setLoadedFor(loadAccountId)
      } catch (err) {
        if (!canApply()) return

        if (loadedForRef.current !== loadAccountId) {
          setRepos([])
          setRuns([])
          setAgents([])
          setPipelines([])
          setPoller(null)
        }
        setError(loadErrorMessage(err))
        loadedForRef.current = loadAccountId
        setLoadedFor(loadAccountId)
      }
    },
    [accountId]
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await load(() => cancelled)
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  useEffect(() => {
    return window.aerie.runner.onStatus((payload) => {
      setRuns((prev) =>
        prev.map((run) =>
          run.kind === 'run' && run.id === payload.runId
            ? {
                ...run,
                status: payload.status,
                exitCode: payload.exitCode ?? run.exitCode,
                outputPath: payload.outputPath ?? run.outputPath
              }
            : run
        )
      )
    })
  }, [])

  const sortedRuns = useMemo(() => newestRuns(runs), [runs])
  const activeRuns = useMemo(() => sortedRuns.filter(isActiveRun), [sortedRuns])
  const attentionRuns = useMemo(
    () => sortedRuns.filter((run) => needsHumanAttention(run)),
    [sortedRuns]
  )
  const summary = useMemo(() => cockpitSummary(runs), [runs])
  const installedAgents = agents.filter((agent) => agent.available)
  const waitingForApproval = agents.filter((agent) => agent.needsConsent && agent.available)
  const enabledPipelines = pipelines.filter((item) => item.pipeline.enabled)
  const repoShortcuts = useMemo(() => {
    const sorted = [...repos].sort((a, b) => {
      if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1
      return Date.parse(b.pushedAt ?? '') - Date.parse(a.pushedAt ?? '')
    })
    return sorted.slice(0, 5)
  }, [repos])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await load()
      if (mountedRef.current && activeAccountIdRef.current === accountId) setNow(Date.now())
    } finally {
      if (mountedRef.current) setRefreshing(false)
    }
  }

  useEffect(() => {
    if (activeRuns.length === 0) return
    const id = setInterval(() => void load(), 3000)
    return () => clearInterval(id)
  }, [activeRuns.length, load])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  return (
    <section className="panel panel--wide cockpit" aria-labelledby="cockpit-heading">
      <div className="cockpit__hero">
        <div>
          <h1 id="cockpit-heading">Review cockpit</h1>
          <p className="cockpit__lede">
            Account-scoped run queue, review targets, agent readiness, and automation health.
          </p>
        </div>
        <div className="cockpit__hero-actions">
          <button className="btn btn--primary" onClick={() => onNavigate('repos')}>
            Choose target
          </button>
          <button className="btn btn--ghost" onClick={() => onNavigate('history')}>
            Open history
          </button>
          <button className="btn btn--ghost" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <p className="alert">{error}</p>}

      <div className="cockpit__metrics" aria-busy={loading}>
        {loading && <span className="sr-only">Loading cockpit metrics…</span>}
        {loading ? (
          <>
            <Metric label="running" value="—" loading />
            <Metric label="needs review" value="—" loading />
            <Metric label="ready to post" value="—" loading />
            <Metric label="handled" value="—" loading />
            <Metric label="completed" value="—" loading />
            <Metric label="posted" value="—" loading />
          </>
        ) : (
          <>
            <Metric
              label="running"
              value={summary.active}
              tone={summary.active > 0 ? 'warn' : 'neutral'}
            />
            <Metric
              label="needs review"
              value={summary.attention}
              tone={summary.attention > 0 ? 'bad' : 'good'}
            />
            <Metric label="ready to post" value={summary.readyToPost} tone="warn" />
            <Metric label="handled" value={summary.handled} tone="neutral" />
            <Metric label="completed" value={summary.completed} tone="good" />
            <Metric label="posted" value={summary.posted} tone="neutral" />
          </>
        )}
      </div>

      <div className="cockpit__grid">
        <div className="cockpit__main">
          <section className="cockpit-section" aria-busy={loading}>
            <div className="cockpit-section__head">
              <div>
                <h2>Attention queue</h2>
                <p className="muted">Ready-to-post reviews, failed runs, and stopped runs.</p>
              </div>
              <button className="btn btn--ghost" onClick={() => onNavigate('history')}>
                View all
              </button>
            </div>
            {loading ? (
              <p className="empty">Loading run history...</p>
            ) : attentionRuns.length === 0 ? (
              <p className="empty">No blocked or ready-to-post reviews for this account.</p>
            ) : (
              <ul className="cockpit-run-list">
                {attentionRuns.slice(0, 5).map((run) => (
                  <RunRow key={run.id} run={run} onOpenRun={onOpenRun} />
                ))}
              </ul>
            )}
          </section>

          <section className="cockpit-section" aria-busy={loading}>
            <div className="cockpit-section__head">
              <div>
                <h2>In progress</h2>
                <p className="muted">Queued and running agent work for the selected account.</p>
              </div>
              <button className="btn btn--ghost" onClick={() => onNavigate('history')}>
                Live logs
              </button>
            </div>
            {loading ? (
              <p className="empty">Loading active runs...</p>
            ) : activeRuns.length === 0 ? (
              <p className="empty">No agent runs are active right now.</p>
            ) : (
              <ul className="cockpit-run-list">
                {activeRuns.slice(0, 4).map((run) => (
                  <RunRow key={run.id} run={run} onOpenRun={onOpenRun} />
                ))}
              </ul>
            )}
          </section>

          <section className="cockpit-section" aria-busy={loading}>
            <div className="cockpit-section__head">
              <div>
                <h2>Review targets</h2>
                <p className="muted">Favorites first, then recently pushed repositories.</p>
              </div>
              <button className="btn btn--ghost" onClick={() => onNavigate('repos')}>
                Browse repos
              </button>
            </div>
            {loading ? (
              <p className="empty">Loading repositories...</p>
            ) : repoShortcuts.length === 0 ? (
              <p className="empty">No repositories loaded for this account yet.</p>
            ) : (
              <div className="cockpit-repos">
                {repoShortcuts.map((repo) => (
                  <RepoShortcut key={repo.id} repo={repo} onOpenRepo={onOpenRepo} />
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="cockpit__rail" aria-label="Readiness and automation" aria-busy={loading}>
          <section className="cockpit-rail-card">
            <div className="cockpit-rail-card__head">
              <h2>Agent readiness</h2>
              <span className={`status-pill status-pill--${loading ? 'muted' : 'ok'}`}>
                {loading ? '…' : `${installedAgents.length}/${agents.length || 0}`}
              </span>
            </div>
            {loading ? (
              <p className="muted">Loading agent readiness…</p>
            ) : (
              <p className="muted">
                {installedAgents.length} installed
                {waitingForApproval.length > 0
                  ? ` · ${waitingForApproval.length} waiting for approval`
                  : ' · all approved or built-in'}
              </p>
            )}
            <button
              className="btn btn--ghost cockpit-rail-card__action"
              onClick={() => onNavigate('tools')}
            >
              Manage agents
            </button>
          </section>

          <section className="cockpit-rail-card">
            <div className="cockpit-rail-card__head">
              <h2>Automation</h2>
              <span className="status-pill status-pill--muted">
                {loading ? '…' : `${enabledPipelines.length} enabled`}
              </span>
            </div>
            <p className="muted">
              {loading
                ? 'Loading automation status…'
                : poller
                  ? formatPollerStatus(poller, now)
                  : 'Poller status unavailable.'}
            </p>
            <button
              className="btn btn--ghost cockpit-rail-card__action"
              onClick={() => onNavigate('automate')}
            >
              Open automation
            </button>
          </section>

          <section className="cockpit-rail-card">
            <div className="cockpit-rail-card__head">
              <h2>Trust boundary</h2>
              <span className="status-pill status-pill--ok">local</span>
            </div>
            <ul className="cockpit-checks">
              <li>Tokens stay in the main process.</li>
              <li>Agents run on app-owned clones by default.</li>
              <li>GitHub writes require confirmation.</li>
            </ul>
          </section>

          <section className="cockpit-rail-card">
            <div className="cockpit-rail-card__head">
              <h2>Shortcuts</h2>
            </div>
            <div className="cockpit-shortcuts">
              <button className="btn btn--ghost" onClick={() => onNavigate('repos')}>
                Choose target
              </button>
              <button className="btn btn--ghost" onClick={() => onNavigate('history')}>
                Run history
              </button>
              <button className="btn btn--ghost" onClick={() => onNavigate('settings')}>
                Prompts and presets
              </button>
            </div>
          </section>
        </aside>
      </div>
    </section>
  )
}

export default MissionControlPanel
