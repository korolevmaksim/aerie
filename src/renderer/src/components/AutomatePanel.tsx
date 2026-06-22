import { useCallback, useEffect, useState } from 'react'
import type { PipelineRunChange, PipelineWithRuns } from '@shared/types'
import {
  applyLiveChange,
  describeOutcome,
  displayRunStatus,
  statusLabel,
  statusTone
} from '../lib/automate'

/**
 * The Automate view (ROADMAP M13): lists the configured pipelines with their current run
 * status (live via `pipelines.onStatus`), an enable toggle, and Run-now / Dry-run actions.
 * Pipeline config is created/edited through the editor (next slice). All mutations go through
 * the already-gated `aerie.pipelines.*` IPC — this view holds no privileged logic.
 */
function PipelineRow({
  item,
  live,
  busy,
  message,
  onToggle,
  onRun
}: {
  item: PipelineWithRuns
  live: PipelineRunChange | undefined
  busy: boolean
  message: string | undefined
  onToggle: (id: number, enabled: boolean) => void
  onRun: (id: number, dryRun: boolean) => void
}): React.JSX.Element {
  const { pipeline, repoFullName } = item
  const view = displayRunStatus(item, live)
  return (
    <li className="pipeline">
      <div className="pipeline__head">
        <span className="pipeline__name">{pipeline.name}</span>
        <code className="pipeline__repo">{repoFullName ?? `repo #${pipeline.repoId}`}</code>
        <span className="pipeline__trigger badge">{pipeline.trigger}</span>
        <span className={`status-pill status-pill--${statusTone(view.status)}`} aria-live="polite">
          {statusLabel(view.status)}
          {view.posted ? ' · posted' : ''}
        </span>
      </div>
      <div className="pipeline__actions">
        <button
          className="btn btn--ghost"
          aria-pressed={pipeline.enabled}
          onClick={() => onToggle(pipeline.id, !pipeline.enabled)}
        >
          {pipeline.enabled ? 'Enabled' : 'Disabled'}
        </button>
        <button className="btn" disabled={busy} onClick={() => onRun(pipeline.id, false)}>
          Run now
        </button>
        <button className="btn btn--ghost" disabled={busy} onClick={() => onRun(pipeline.id, true)}>
          Dry run
        </button>
      </div>
      {message && (
        <p className="pipeline__msg muted" aria-live="polite">
          {message}
        </p>
      )}
    </li>
  )
}

function AutomatePanel({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  const [items, setItems] = useState<PipelineWithRuns[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<Record<number, PipelineRunChange>>({})
  const [busyId, setBusyId] = useState<number | null>(null)
  const [messages, setMessages] = useState<Record<number, string>>({})

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
      if (res.ok) void load()
      else setError(res.error)
    },
    [load]
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
      if (res.ok) void load()
    },
    [load]
  )

  return (
    <section className="panel" aria-labelledby="automate-heading">
      <div className="panel__head">
        <h2 id="automate-heading">Automate</h2>
        <button className="btn" onClick={onCreate}>
          New pipeline
        </button>
      </div>
      <p className="muted">
        Pipelines watch a repo and run your agents on a new commit, then notify, stage, or (only
        when you opt in) post the review. They run locally on a poll — never a webhook.
      </p>

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
          <button className="btn" onClick={onCreate}>
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
            />
          ))}
        </ul>
      )}
    </section>
  )
}

export default AutomatePanel
