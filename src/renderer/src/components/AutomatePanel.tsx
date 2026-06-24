import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgentInfo,
  Pipeline,
  PipelineRunChange,
  PipelineWithRuns,
  PollerStatus
} from '@shared/types'
import {
  applyLiveChange,
  describePipelineAction,
  describePipelineCadence,
  describePipelineTarget,
  describeOutcome,
  displayRunStatus,
  formatRunLine,
  statusLabel,
  statusTone
} from '../lib/automate'
import { formatRelativeTime } from '../lib/format'
import { formatPollerStatus } from '../lib/pollerStatus'
import PipelineEditor, { type RepoOption } from './PipelineEditor'

/**
 * The Automate view (ROADMAP M13): lists the configured pipelines with their current run
 * status (live via `pipelines.onStatus`), an enable toggle, Run-now / Dry-run actions, and
 * a create/edit editor. All mutations go through the already-gated `aerie.pipelines.*` IPC —
 * this view holds no privileged logic.
 */
function PipelineRow({
  item,
  live,
  busy,
  message,
  onToggle,
  onRun,
  onEdit,
  onOpenRunGroup
}: {
  item: PipelineWithRuns
  live: PipelineRunChange | undefined
  busy: boolean
  message: string | undefined
  onToggle: (id: number, enabled: boolean) => void
  onRun: (id: number, dryRun: boolean) => void
  onEdit: (item: PipelineWithRuns) => void
  onOpenRunGroup: (groupId: number) => void
}): React.JSX.Element {
  const { pipeline, repoFullName } = item
  const view = displayRunStatus(item, live)
  const latestRun = item.runs[0]
  return (
    <li className="pipeline">
      <div className="pipeline__head">
        <div className="pipeline__identity">
          <span className="pipeline__name">{pipeline.name}</span>
          <code className="pipeline__repo">{repoFullName ?? `repo #${pipeline.repoId}`}</code>
        </div>
        <div className="pipeline__state" aria-live="polite">
          <span className="pipeline__state-label">Last run</span>
          <span className={`status-pill status-pill--${statusTone(view.status)}`}>
            {statusLabel(view.status)}
            {view.posted ? ' · posted' : ''}
          </span>
          {latestRun && (
            <span className="pipeline__state-time muted">
              {formatRelativeTime(latestRun.startedAt)}
            </span>
          )}
        </div>
      </div>
      <div className="pipeline__meta" aria-label="Pipeline schedule and action">
        <span className="badge">{pipeline.trigger}</span>
        <span className="badge">{describePipelineCadence(pipeline)}</span>
        <span className="badge">{describePipelineTarget(pipeline)}</span>
        <span className="badge">{describePipelineAction(pipeline.action)}</span>
      </div>
      <div className="pipeline__actions">
        <label className="switch-control">
          <input
            type="checkbox"
            role="switch"
            checked={pipeline.enabled}
            disabled={busy}
            onChange={(e) => onToggle(pipeline.id, e.currentTarget.checked)}
          />
          <span className="switch-control__track" aria-hidden="true">
            <span className="switch-control__thumb" />
          </span>
          <span className="switch-control__text">{pipeline.enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
        <button className="btn" disabled={busy} onClick={() => onRun(pipeline.id, false)}>
          Run now
        </button>
        <button className="btn btn--ghost" disabled={busy} onClick={() => onRun(pipeline.id, true)}>
          Dry run
        </button>
        <button className="btn btn--ghost" onClick={() => onEdit(item)}>
          Edit
        </button>
      </div>
      {message && (
        <p className="pipeline__msg muted" aria-live="polite">
          {message}
        </p>
      )}
      {item.runs.length > 0 && (
        <details className="pipeline__runs">
          <summary>
            Recent runs ({item.runs.length}
            {item.runs.length >= 20 ? '+' : ''})
          </summary>
          <ul className="run-list">
            {item.runs.map((r) => (
              <li key={r.id} className="run-line">
                <span className={`status-pill status-pill--${statusTone(r.status)}`}>
                  {statusLabel(r.status)}
                </span>
                <span className="muted run-line__detail">{formatRunLine(r)}</span>
                {r.runGroupId !== null && (
                  <button
                    type="button"
                    className="link link--button run-line__report"
                    onClick={() => onOpenRunGroup(r.runGroupId!)}
                  >
                    Open report
                  </button>
                )}
                <span className="muted run-line__time">{formatRelativeTime(r.startedAt)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  )
}

function AutomatePanel({
  accountId,
  onOpenRunGroup
}: {
  accountId: number | null
  onOpenRunGroup?: (groupId: number) => void
}): React.JSX.Element {
  const [items, setItems] = useState<PipelineWithRuns[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<Record<number, PipelineRunChange>>({})
  const [busyId, setBusyId] = useState<number | null>(null)
  const [messages, setMessages] = useState<Record<number, string>>({})
  // Picker data for the editor + the editor's open state (`undefined` = closed).
  const [repos, setRepos] = useState<RepoOption[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [editing, setEditing] = useState<Pipeline | null | undefined>(undefined)
  // Poller liveness (M14): re-fetched periodically so the relative "next check in …" stays fresh.
  const [poller, setPoller] = useState<PollerStatus | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const pollerTone =
    poller && poller.running && poller.enabledPipelineCount > 0 && poller.activeWatchCount > 0
      ? 'on'
      : poller && poller.running
        ? 'idle'
        : 'off'

  const loadPoller = useCallback(async (): Promise<void> => {
    const res = await window.aerie.pipelines.pollerStatus()
    if (res.ok) setPoller(res.value)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    const res = await window.aerie.pipelines.list()
    if (res.ok) setItems(res.value)
    else setError(res.error)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.pipelines.list()
      if (cancelled) return
      if (res.ok) setItems(res.value)
      else setError(res.error)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Poll the poller's own liveness on a slow cadence (and re-stamp `now`) so the status line's
  // relative times stay current without a per-second timer.
  useEffect(() => {
    let cancelled = false
    const fetchPoller = async (): Promise<void> => {
      const res = await window.aerie.pipelines.pollerStatus()
      if (!cancelled && res.ok) setPoller(res.value)
    }
    void fetchPoller()
    const id = setInterval(() => {
      setNow(Date.now())
      void fetchPoller()
    }, 15_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // Picker data for the editor: the selected account's repos + the installed agents.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [repoRes, agentRes] = await Promise.all([
        accountId !== null ? window.aerie.repos.list(accountId) : Promise.resolve(null),
        window.aerie.runner.listAgents()
      ])
      if (cancelled) return
      if (repoRes && repoRes.ok) {
        setRepos(repoRes.value.repos.map((r) => ({ id: r.id, fullName: r.fullName })))
      }
      if (agentRes.ok) setAgents(agentRes.value)
    })()
    return () => {
      cancelled = true
    }
  }, [accountId])

  // Live status pushes (insert / status / posted) — merge into the per-pipeline map.
  useEffect(() => {
    return window.aerie.pipelines.onStatus((change) => {
      setLive((prev) => applyLiveChange(prev, change))
    })
  }, [])

  const toggle = useCallback(
    async (id: number, enabled: boolean): Promise<void> => {
      setError(null)
      const res = await window.aerie.pipelines.setEnabled(id, enabled)
      if (res.ok) {
        void load()
        void loadPoller()
      } else setError(res.error)
    },
    [load, loadPoller]
  )

  const run = useCallback(
    async (id: number, dryRun: boolean): Promise<void> => {
      setBusyId(id)
      setMessages((m) => ({ ...m, [id]: dryRun ? 'Dry running…' : 'Running…' }))
      const res = dryRun
        ? await window.aerie.pipelines.dryRun(id)
        : await window.aerie.pipelines.runNow(id)
      setBusyId(null)
      setMessages((m) => ({ ...m, [id]: res.ok ? describeOutcome(res.value, dryRun) : res.error }))
      if (res.ok) {
        void load()
        void loadPoller()
      }
    },
    [load, loadPoller]
  )

  // The repo picker shows the selected account's repos; when editing a pipeline whose repo
  // belongs to another account (or an unselected one), include it so the saved repo isn't
  // silently dropped on re-save (its name comes from the listed item).
  const editorRepos = useMemo<RepoOption[]>(() => {
    if (editing && !repos.some((r) => r.id === editing.repoId)) {
      const it = items?.find((i) => i.pipeline.id === editing.id)
      return [
        ...repos,
        { id: editing.repoId, fullName: it?.repoFullName ?? `repo #${editing.repoId}` }
      ]
    }
    return repos
  }, [editing, repos, items])

  const onEdit = useCallback((item: PipelineWithRuns): void => {
    // The editor only handles agent steps; tool-bearing pipelines aren't editable here yet.
    if (item.pipeline.steps.some((s) => s.kind !== 'agent')) {
      setError("This pipeline has tool steps and can't be edited here yet.")
      return
    }
    setError(null)
    setEditing(item.pipeline)
  }, [])

  return (
    <section className="panel" aria-labelledby="automate-heading">
      <div className="panel__head">
        <h2 id="automate-heading">Automate</h2>
        <button
          className="btn"
          onClick={() => {
            setError(null)
            setEditing(null)
          }}
        >
          New pipeline
        </button>
      </div>
      <p className="muted">
        Pipelines watch a repo and run your agents on a new default-branch head, then notify, stage,
        or (only when you opt in) post the review. They run locally on a poll — never a webhook.
      </p>

      {poller && items && items.length > 0 && (
        // Ambient liveness — deliberately NOT an aria-live region: the relative countdown
        // re-renders every 15s and would otherwise spam a screen reader with no actionable change.
        <p className="poller-status">
          <span className={`poller-dot poller-dot--${pollerTone}`} aria-hidden="true" />
          {formatPollerStatus(poller, now)}
        </p>
      )}

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {items === null ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <div className="empty">
          <p>No pipelines yet.</p>
          <button
            className="btn"
            onClick={() => {
              setError(null)
              setEditing(null)
            }}
          >
            Create your first pipeline
          </button>
        </div>
      ) : (
        <ul className="pipeline-list">
          {items.map((item) => (
            <PipelineRow
              key={item.pipeline.id}
              item={item}
              live={live[item.pipeline.id]}
              busy={busyId === item.pipeline.id}
              message={messages[item.pipeline.id]}
              onToggle={toggle}
              onRun={run}
              onEdit={onEdit}
              onOpenRunGroup={onOpenRunGroup ?? (() => {})}
            />
          ))}
        </ul>
      )}

      {editing !== undefined && (
        <PipelineEditor
          editing={editing}
          repos={editorRepos}
          agents={agents}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            void load()
            void loadPoller()
          }}
        />
      )}
    </section>
  )
}

export default AutomatePanel
