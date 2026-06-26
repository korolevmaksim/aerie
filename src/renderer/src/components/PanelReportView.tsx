import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PostKind, RunGroupHistoryItem, RunGroupReport, RunLocalStatus } from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import { runRefLabel } from '../lib/runConsole'
import PostConfirmModal from './PostConfirmModal'
import RunView from './RunView'

function isTerminal(status: string): boolean {
  return status === 'done' || status === 'error' || status === 'killed'
}

function localStatusLabel(status: RunLocalStatus): string {
  if (status === 'handled') return 'Handled locally'
  if (status === 'verified') return 'Verified locally'
  return 'Open'
}

function PanelReportView({
  group,
  onGroupUpdate
}: {
  group: RunGroupHistoryItem
  onGroupUpdate?: (group: RunGroupHistoryItem) => void
}): React.JSX.Element {
  const [consensusMin, setConsensusMin] = useState(Math.min(2, Math.max(1, group.agentIds.length)))
  const [report, setReport] = useState<RunGroupReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [settingLocalStatus, setSettingLocalStatus] = useState(false)
  const [postModal, setPostModal] = useState<{ kind: PostKind; targetLabel: string } | null>(null)
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.aerie.runner.groupReport(group.id, consensusMin)
      if (res.ok) {
        setReport(res.value)
        onGroupUpdate?.(res.value.group)
      } else {
        setError(res.error)
      }
    } finally {
      setLoading(false)
    }
  }, [consensusMin, group.id, onGroupUpdate])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void load()
    })
    return () => {
      active = false
    }
  }, [load])

  useEffect(() => {
    return window.aerie.runner.onStatus((payload) => {
      const current = report?.group ?? group
      if (current.runIds.includes(payload.runId)) void load()
    })
  }, [group, load, report])

  useEffect(() => {
    const current = report?.group ?? group
    if (current.status !== 'queued' && current.status !== 'running') return
    const id = setInterval(() => void load(), 3000)
    return () => clearInterval(id)
  }, [group, load, report])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(null), 2000)
    return () => clearTimeout(id)
  }, [copied])

  const current = report?.group ?? group
  const refLabel = runRefLabel(current)
  const maxConsensus = Math.max(1, current.agentIds.length)
  const finished = isTerminal(current.status)
  const canPost = current.status === 'done' && report?.markdown.trim()
  const issueTitle = `Aerie panel review: ${refLabel}`
  const childCounts = useMemo(() => {
    const counts = { done: 0, error: 0, killed: 0, running: 0, queued: 0 }
    for (const run of report?.runs ?? []) counts[run.status] += 1
    return counts
  }, [report])

  const copy = useCallback(async (): Promise<void> => {
    if (!report?.markdown.trim()) return
    try {
      await navigator.clipboard.writeText(report.markdown)
      setCopied('Copied consolidated report')
    } catch {
      setCopied('Copy failed — clipboard unavailable.')
    }
  }, [report])

  const updateLocalStatus = useCallback(
    async (next: RunLocalStatus): Promise<void> => {
      setSettingLocalStatus(true)
      setError(null)
      try {
        const res = await window.aerie.runner.setGroupLocalStatus(current.id, next)
        if (res.ok) {
          setReport(res.value)
          onGroupUpdate?.(res.value.group)
        } else {
          setError(res.error)
        }
      } finally {
        setSettingLocalStatus(false)
      }
    },
    [current.id, onGroupUpdate]
  )

  const onConfirmPost = async (body: string, title: string): Promise<void> => {
    if (!postModal) return
    setPosting(true)
    setPostError(null)
    try {
      const res = await window.aerie.runner.postGroup({
        groupId: current.id,
        repoId: current.repoId,
        kind: postModal.kind,
        body,
        sha: postModal.kind === 'commitComment' ? current.headSha : undefined,
        prNumber: postModal.kind === 'prComment' ? Number(current.refId) : undefined,
        title: postModal.kind === 'issue' ? title : undefined
      })
      if (res.ok) {
        setPostModal(null)
        await load()
      } else {
        setPostError(res.error)
      }
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className="panel-report">
      <div className="panel-report__bar">
        <span
          className={`chip run__status run__status--${current.status}`}
          role="status"
          aria-label={`Panel review status: ${current.status}`}
        >
          {current.status}
        </span>
        <span className="chip">panel · {current.agentIds.length} agents</span>
        <span className="muted">
          {refLabel} · started {formatRelativeTime(current.startedAt)}
        </span>
        <span className="panel-report__spacer" />
        <span className="muted" role="status">
          {copied ?? ''}
        </span>
        <button className="btn btn--ghost" onClick={() => void copy()} disabled={!report}>
          Copy report
        </button>
      </div>

      <div className="panel-report__summary" aria-busy={loading}>
        <div>
          <span className="muted">Completed</span>
          <strong>{childCounts.done}</strong>
        </div>
        <div>
          <span className="muted">Failed</span>
          <strong>{childCounts.error + childCounts.killed}</strong>
        </div>
        <div>
          <span className="muted">Active</span>
          <strong>{childCounts.running + childCounts.queued}</strong>
        </div>
        <div>
          <span className="muted">Findings</span>
          <strong>{report?.totalFindings ?? 0}</strong>
        </div>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <div className="panel-report__controls">
        <label className="run__consensus-min">
          Consensus agreed by ≥
          <select
            className="field"
            value={consensusMin}
            onChange={(e) => setConsensusMin(Number(e.target.value))}
            disabled={loading}
          >
            {Array.from({ length: maxConsensus }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          agents
        </label>
        <button className="btn btn--ghost" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh report'}
        </button>
      </div>

      {!report && loading && <p className="empty">Loading report…</p>}

      {report && (
        <>
          <section className="panel-report__section">
            <h3>Consensus findings</h3>
            {report.consensusFindings.length === 0 ? (
              <p className="empty">No finding reached the current consensus threshold.</p>
            ) : (
              <ul className="run__findings-list">
                {report.consensusFindings.map((finding, index) => (
                  <li key={index} className="run__finding">
                    <span className="chip">{finding.agreement}×</span>
                    <span className={`chip sev sev--${finding.severity}`}>{finding.severity}</span>
                    <code className="run__finding-loc">
                      {finding.file}
                      {finding.line != null ? `:${finding.line}` : ''}
                    </code>
                    <span className="run__finding-msg">{finding.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel-report__section">
            <h3>Single-source findings</h3>
            {report.singleSourceFindings.length === 0 ? (
              <p className="empty">No additional structured findings.</p>
            ) : (
              <ul className="run__findings-list">
                {report.singleSourceFindings.map((finding, index) => (
                  <li key={index} className="run__finding">
                    <span className="chip">{finding.agreement}×</span>
                    <span className={`chip sev sev--${finding.severity}`}>{finding.severity}</span>
                    <code className="run__finding-loc">
                      {finding.file}
                      {finding.line != null ? `:${finding.line}` : ''}
                    </code>
                    <span className="run__finding-msg">{finding.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {finished && (
            <div className="run__local">
              {current.localStatus === 'open' ? (
                <span className="muted">No local disposition yet.</span>
              ) : (
                <span className="muted">
                  {localStatusLabel(current.localStatus)}
                  {current.localStatusAt ? ` ${formatRelativeTime(current.localStatusAt)}` : ''}
                </span>
              )}
              <button
                className="btn btn--ghost"
                onClick={() => void updateLocalStatus('handled')}
                disabled={settingLocalStatus || current.localStatus === 'handled'}
              >
                Mark handled
              </button>
              {current.status === 'done' && (
                <button
                  className="btn btn--ghost"
                  onClick={() => void updateLocalStatus('verified')}
                  disabled={settingLocalStatus || current.localStatus === 'verified'}
                >
                  Mark verified
                </button>
              )}
              {current.localStatus !== 'open' && (
                <button
                  className="btn btn--ghost"
                  onClick={() => void updateLocalStatus('open')}
                  disabled={settingLocalStatus}
                >
                  Reopen
                </button>
              )}
            </div>
          )}

          {canPost && (
            <div className="run__post">
              {current.refType === 'commit' && (
                <button
                  className="btn btn--ghost"
                  onClick={() =>
                    setPostModal({
                      kind: 'commitComment',
                      targetLabel: `commit ${current.headSha.slice(0, 8)}`
                    })
                  }
                >
                  Post consolidated commit comment
                </button>
              )}
              {current.refType === 'pr' && (
                <button
                  className="btn btn--ghost"
                  onClick={() =>
                    setPostModal({ kind: 'prComment', targetLabel: `PR #${current.refId}` })
                  }
                >
                  Post consolidated PR comment
                </button>
              )}
              <button
                className="btn btn--ghost"
                onClick={() => setPostModal({ kind: 'issue', targetLabel: 'a new issue' })}
              >
                Create issue
              </button>
              {current.postedUrl && (
                <a className="link" href={current.postedUrl} target="_blank" rel="noreferrer">
                  posted ↗
                </a>
              )}
            </div>
          )}

          <section className="panel-report__section">
            <h3>Agent reports</h3>
            <div className="panel-report__agents">
              {report.runs.map((run) => (
                <details key={run.id} className="panel-report__agent">
                  <summary>
                    <span>{run.agentId}</span>
                    <span className={`chip run__status run__status--${run.status}`}>
                      {run.status}
                    </span>
                  </summary>
                  <RunView run={run} onRunUpdate={() => void load()} />
                </details>
              ))}
            </div>
          </section>
        </>
      )}

      {postModal && report && (
        <PostConfirmModal
          kind={postModal.kind}
          targetLabel={postModal.targetLabel}
          initialBody={report.markdown}
          initialTitle={postModal.kind === 'issue' ? issueTitle : undefined}
          mentionLogin={postModal.kind === 'issue' ? null : current.authorLogin}
          busy={posting}
          error={postError}
          onCancel={() => {
            setPostModal(null)
            setPostError(null)
          }}
          onConfirm={onConfirmPost}
        />
      )}
    </div>
  )
}

export default PanelReportView
