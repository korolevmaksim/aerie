import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PostKind,
  ReviewMemoryDecision,
  RunFinding,
  RunLocalStatus,
  RunRecord,
  RunStatus
} from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import { runOutputToMarkdown, runRefLabel } from '../lib/runConsole'
import PostConfirmModal from './PostConfirmModal'

const MAX_DISPLAY = 256 * 1024
const MAX_BODY = 60000

function isTerminal(s: RunStatus): boolean {
  return s === 'done' || s === 'error' || s === 'killed'
}

function localStatusLabel(status: RunLocalStatus): string {
  if (status === 'handled') return 'Handled locally'
  if (status === 'verified') return 'Verified locally'
  return 'Open'
}

const QUICK_MEMORY_DECISIONS: ReadonlyArray<{ decision: ReviewMemoryDecision; label: string }> = [
  { decision: 'accepted', label: 'Accept' },
  { decision: 'fixed', label: 'Fixed' },
  { decision: 'false_positive', label: 'False positive' },
  { decision: 'dismissed', label: 'Dismiss' }
]

function decisionLabel(decision: ReviewMemoryDecision): string {
  switch (decision) {
    case 'accepted':
      return 'accepted'
    case 'fixed':
      return 'fixed'
    case 'false_positive':
      return 'false positive'
    case 'accepted_risk':
      return 'accepted risk'
    case 'duplicate':
      return 'duplicate'
    case 'dismissed':
      return 'dismissed'
    case 'needs_follow_up':
      return 'needs follow-up'
  }
}

function decisionRequiresNote(decision: ReviewMemoryDecision): boolean {
  return (
    decision === 'false_positive' ||
    decision === 'accepted_risk' ||
    decision === 'duplicate' ||
    decision === 'dismissed'
  )
}

function memoryLabel(finding: RunFinding): string | null {
  const memory = finding.memory
  if (!memory) return null
  const parts = [`memory: ${decisionLabel(memory.annotation.decision)}`]
  if (memory.reopened) parts.push('reopened')
  if (memory.matchedBy === 'context_hash') parts.push('via context')
  return parts.join(' · ')
}

/**
 * Displays one run: live (or recorded) console transcript, status, Kill (while
 * running), and confirm-gated posting (when finished). Shared by the commit/PR
 * panel and the History view — so progress and logs are visible from both, for
 * running and finished runs alike.
 */
function RunView({
  run,
  onStatusChange,
  onRunUpdate,
  onRerun
}: {
  run: RunRecord
  onStatusChange?: (status: RunStatus) => void
  onRunUpdate?: (run: RunRecord) => void
  /** When provided, a finished run shows a "Re-run" action (re-launch same agent + target). */
  onRerun?: () => void
}): React.JSX.Element {
  const [output, setOutput] = useState('')
  const [status, setStatus] = useState<RunStatus>(run.status)
  const [cleanOutput, setCleanOutput] = useState('')
  const [findings, setFindings] = useState<RunFinding[]>([])
  const [postModal, setPostModal] = useState<{ kind: PostKind; targetLabel: string } | null>(null)
  const [posting, setPosting] = useState(false)
  const [postedUrl, setPostedUrl] = useState<string | null>(run.postedUrl)
  const [localStatus, setLocalStatus] = useState<RunLocalStatus>(run.localStatus)
  const [localStatusAt, setLocalStatusAt] = useState<string | null>(run.localStatusAt)
  const [settingLocalStatus, setSettingLocalStatus] = useState(false)
  const [localStatusError, setLocalStatusError] = useState<string | null>(null)
  const [postError, setPostError] = useState<string | null>(null)
  const [memoryDraft, setMemoryDraft] = useState<{
    findingId: number
    decision: ReviewMemoryDecision
    note: string
  } | null>(null)
  const [memoryBusyId, setMemoryBusyId] = useState<number | null>(null)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const runIdRef = useRef(run.id)
  const consoleRef = useRef<HTMLPreElement | null>(null)
  const pendingRef = useRef('')
  const flushScheduledRef = useRef(false)

  const flush = useCallback((): void => {
    flushScheduledRef.current = false
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = ''
    setOutput((prev) => {
      const next = prev + pending
      return next.length > MAX_DISPLAY ? next.slice(next.length - MAX_DISPLAY) : next
    })
  }, [])

  // Load the transcript (live buffer or recorded .log) + clean review on mount.
  // The parent keys this component by run.id, so a different run remounts fresh.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const t = await window.aerie.runner.transcript(run.id)
      if (!cancelled && t.ok) setOutput(t.value)
      if (isTerminal(run.status)) {
        const o = await window.aerie.runner.readOutput(run.id)
        if (!cancelled && o.ok) setCleanOutput(o.value)
        const f = await window.aerie.runner.findings(run.id)
        if (!cancelled && f.ok) setFindings(f.value)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live stream for the displayed run.
  useEffect(() => {
    const offOutput = window.aerie.runner.onOutput((p) => {
      if (p.runId !== runIdRef.current) return
      pendingRef.current += p.chunk
      if (!flushScheduledRef.current) {
        flushScheduledRef.current = true
        setTimeout(flush, 120)
      }
    })
    const offStatus = window.aerie.runner.onStatus((p) => {
      if (p.runId !== runIdRef.current) return
      flush()
      setStatus(p.status)
      onStatusChange?.(p.status)
      if (isTerminal(p.status)) {
        void window.aerie.runner.readOutput(p.runId).then((o) => o.ok && setCleanOutput(o.value))
        void window.aerie.runner.findings(p.runId).then((f) => f.ok && setFindings(f.value))
      }
    })
    return () => {
      offOutput()
      offStatus()
    }
  }, [flush, onStatusChange])

  useEffect(() => {
    const el = consoleRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output])

  const active = status === 'queued' || status === 'running'
  const onKill = async (): Promise<void> => {
    await window.aerie.runner.kill(run.id)
  }

  const reloadFindings = useCallback(async (): Promise<void> => {
    const res = await window.aerie.runner.findings(run.id)
    if (res.ok) setFindings(res.value)
    else setMemoryError(res.error)
  }, [run.id])

  const saveFindingDecision = useCallback(
    async (finding: RunFinding, decision: ReviewMemoryDecision, note = ''): Promise<void> => {
      setMemoryBusyId(finding.id)
      setMemoryError(null)
      try {
        const res = await window.aerie.reviewMemory.annotateFinding({
          findingId: finding.id,
          decision,
          scopeKind: 'repo',
          note
        })
        if (res.ok) {
          setMemoryDraft(null)
          await reloadFindings()
        } else {
          setMemoryError(res.error)
        }
      } finally {
        setMemoryBusyId(null)
      }
    },
    [reloadFindings]
  )

  const clearFindingDecision = useCallback(
    async (finding: RunFinding): Promise<void> => {
      const annotationId = finding.memory?.annotation.id
      if (!annotationId) return
      setMemoryBusyId(finding.id)
      setMemoryError(null)
      try {
        const res = await window.aerie.reviewMemory.clearAnnotation({ annotationId })
        if (res.ok) await reloadFindings()
        else setMemoryError(res.error)
      } finally {
        setMemoryBusyId(null)
      }
    },
    [reloadFindings]
  )

  // Copy the run's review (the clean captured output when present, else the live transcript) to
  // the clipboard. Client-side over text already on screen; the Markdown wrapper adds only a
  // target/agent/status header — never a token or local path.
  const copyText = cleanOutput.trim() || output.trim()
  const copy = useCallback(
    async (fmt: 'plain' | 'md'): Promise<void> => {
      const base = cleanOutput.trim() || output
      if (!base.trim()) return
      const text =
        fmt === 'md'
          ? runOutputToMarkdown({ agentId: run.agentId, refLabel: runRefLabel(run), status }, base)
          : base
      try {
        await navigator.clipboard.writeText(text)
        setCopied(fmt === 'md' ? 'Copied as Markdown' : 'Copied')
      } catch {
        setCopied('Copy failed — clipboard unavailable.')
      }
    },
    [cleanOutput, output, status, run]
  )

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(null), 2000)
    return () => clearTimeout(t)
  }, [copied])

  const capped =
    cleanOutput.length > MAX_BODY
      ? `${cleanOutput.slice(0, MAX_BODY)}\n\n[aerie] output truncated for posting]`
      : cleanOutput
  const reviewBody = `${capped.trim()}\n\n---\n_Posted via Aerie · agent \`${run.agentId}\`_`
  const issueTitle = `Aerie review: ${runRefLabel(run)}`
  const canPost = isTerminal(status) && cleanOutput.trim().length > 0
  const actionableFindings = findings.filter((finding) => !finding.memory?.suppresses)
  const suppressedFindings = findings.filter((finding) => finding.memory?.suppresses)
  const memoryPostWarning =
    suppressedFindings.length > 0
      ? `Review memory suppressed ${suppressedFindings.length} structured finding${suppressedFindings.length === 1 ? '' : 's'} locally. Check the draft for agent prose that still mentions suppressed items.`
      : null
  // The runner (M-Q) flags an empty/truncated/transcript-leaked LLM review in the
  // transcript; surface that verdict here so the user reviews before posting. Reading
  // the marker keeps a single source of truth (the main-process assessment).
  // Anchored to line start (the runner emits it on its own line) so a review whose
  // own prose happens to quote the marker can't false-trigger the banner.
  const lowQualityMatch = output.match(/^\[aerie\] ⚠ low-quality review:\s*(.+)$/m)
  const lowQualityNote = lowQualityMatch ? lowQualityMatch[1].trim() : null

  const updateLocalStatus = useCallback(
    async (next: RunLocalStatus): Promise<void> => {
      setSettingLocalStatus(true)
      setLocalStatusError(null)
      try {
        const res = await window.aerie.runner.setLocalStatus(run.id, next)
        if (res.ok) {
          setLocalStatus(res.value.localStatus)
          setLocalStatusAt(res.value.localStatusAt)
          onRunUpdate?.(res.value)
        } else {
          setLocalStatusError(res.error)
        }
      } finally {
        setSettingLocalStatus(false)
      }
    },
    [onRunUpdate, run.id]
  )

  const onConfirmPost = async (body: string, title: string): Promise<void> => {
    if (!postModal) return
    setPosting(true)
    setPostError(null)
    try {
      const res = await window.aerie.runner.post({
        runId: run.id,
        repoId: run.repoId,
        kind: postModal.kind,
        body,
        sha: postModal.kind === 'commitComment' ? run.headSha : undefined,
        prNumber: postModal.kind === 'prComment' ? Number(run.refId) : undefined,
        title: postModal.kind === 'issue' ? title : undefined
      })
      if (res.ok) {
        setPostedUrl(res.value.url)
        setPostModal(null)
      } else {
        setPostError(res.error)
      }
    } finally {
      setPosting(false)
    }
  }

  const renderFinding = (finding: RunFinding, index: number): React.JSX.Element => {
    const draft = memoryDraft?.findingId === finding.id ? memoryDraft : null
    const busy = memoryBusyId === finding.id
    const memory = finding.memory
    const memoryChipLabel = memoryLabel(finding)
    return (
      <li
        key={finding.id || index}
        className={`run__finding run__finding--managed${memory?.suppresses ? ' run__finding--suppressed' : ''}`}
      >
        <div className="run__finding-main">
          <span className={`chip sev sev--${finding.severity}`}>{finding.severity}</span>
          <code className="run__finding-loc">
            {finding.file}
            {finding.line != null ? `:${finding.line}` : ''}
          </code>
          <span className="run__finding-msg">{finding.message}</span>
          {memory && (
            <span
              className={`chip run__memory-chip${memory.suppresses ? ' run__memory-chip--suppressed' : ''}${memory.reopened ? ' run__memory-chip--reopened' : ''}`}
              title={memory.annotation.note || undefined}
            >
              {memoryChipLabel}
            </span>
          )}
        </div>
        <div className="run__finding-actions" aria-label="Review-memory actions">
          {QUICK_MEMORY_DECISIONS.map((item) => (
            <button
              key={item.decision}
              className="btn btn--ghost run__finding-action"
              disabled={busy || memory?.annotation.decision === item.decision}
              onClick={() => {
                if (decisionRequiresNote(item.decision)) {
                  setMemoryDraft({
                    findingId: finding.id,
                    decision: item.decision,
                    note: memory?.annotation.note ?? ''
                  })
                } else {
                  void saveFindingDecision(finding, item.decision)
                }
              }}
            >
              {item.label}
            </button>
          ))}
          {memory && (
            <button
              className="btn btn--ghost run__finding-action"
              disabled={busy}
              onClick={() => void clearFindingDecision(finding)}
            >
              Archive
            </button>
          )}
        </div>
        {draft && (
          <div className="run__memory-editor">
            <input
              className="field field--grow"
              value={draft.note}
              placeholder="Reason for suppressing this repeat finding"
              disabled={busy}
              onChange={(event) => setMemoryDraft({ ...draft, note: event.target.value })}
            />
            <button
              className="btn btn--primary"
              disabled={busy || (decisionRequiresNote(draft.decision) && draft.note.trim() === '')}
              onClick={() => void saveFindingDecision(finding, draft.decision, draft.note)}
            >
              Save
            </button>
            <button className="btn btn--ghost" disabled={busy} onClick={() => setMemoryDraft(null)}>
              Cancel
            </button>
          </div>
        )}
      </li>
    )
  }

  return (
    <div className="runview">
      <div className="runview__bar">
        {/* role="status" already implies aria-live="polite"; the label gives context. */}
        <span
          className={`chip run__status run__status--${status}`}
          role="status"
          aria-label={`Run status: ${status}`}
        >
          {status}
        </span>
        {active && (
          <button className="btn btn--danger" onClick={onKill}>
            Kill
          </button>
        )}
        {onRerun && isTerminal(status) && (
          <button
            className="btn btn--ghost"
            onClick={onRerun}
            title="Run the same agent on the same target again"
          >
            Re-run
          </button>
        )}
        {isTerminal(status) && localStatus !== 'open' && (
          <span
            className={`chip run__local-chip run__local-chip--${localStatus}`}
            title={
              localStatusAt
                ? `${localStatusLabel(localStatus)} ${formatRelativeTime(localStatusAt)}`
                : undefined
            }
          >
            {localStatusLabel(localStatus)}
          </span>
        )}
        {copyText.length > 0 && (
          <span className="runview__bar-actions">
            <span className="muted runview__copied" role="status">
              {copied ?? ''}
            </span>
            <button
              className="btn btn--ghost"
              onClick={() => void copy('plain')}
              title="Copy the review to the clipboard"
            >
              Copy
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => void copy('md')}
              title="Copy the review as Markdown (with a target/agent/status header)"
            >
              Copy MD
            </button>
          </span>
        )}
      </div>

      <pre className="run__console" ref={consoleRef}>
        {output || (active ? '…' : 'No output recorded.')}
      </pre>

      {findings.length > 0 && (
        <div className="run__findings">
          <h4 className="run__findings-head">
            {actionableFindings.length} actionable structured finding
            {actionableFindings.length === 1 ? '' : 's'}
            {suppressedFindings.length > 0 ? ` · ${suppressedFindings.length} suppressed` : ''}
          </h4>
          {memoryError && (
            <p className="run__memory-error" role="alert">
              {memoryError}
            </p>
          )}
          {actionableFindings.length > 0 ? (
            <ul className="run__findings-list">{actionableFindings.map(renderFinding)}</ul>
          ) : (
            <p className="empty">All structured findings are suppressed by review memory.</p>
          )}
          {suppressedFindings.length > 0 && (
            <details className="run__suppressed">
              <summary>Suppressed by review memory ({suppressedFindings.length})</summary>
              <ul className="run__findings-list">{suppressedFindings.map(renderFinding)}</ul>
            </details>
          )}
        </div>
      )}

      {isTerminal(status) && lowQualityNote && (
        <p className="run__warn" role="alert">
          ⚠ This review looks low-quality: {lowQualityNote} Check it before posting.
        </p>
      )}

      {isTerminal(status) && (
        <div className="run__local">
          {localStatus === 'open' ? (
            <span className="muted">No local disposition yet.</span>
          ) : (
            <span className="muted">
              {localStatusLabel(localStatus)}
              {localStatusAt ? ` ${formatRelativeTime(localStatusAt)}` : ''}
            </span>
          )}
          <button
            className="btn btn--ghost"
            onClick={() => void updateLocalStatus('handled')}
            disabled={settingLocalStatus || localStatus === 'handled'}
          >
            Mark handled
          </button>
          {status === 'done' && (
            <button
              className="btn btn--ghost"
              onClick={() => void updateLocalStatus('verified')}
              disabled={settingLocalStatus || localStatus === 'verified'}
            >
              Mark verified
            </button>
          )}
          {localStatus !== 'open' && (
            <button
              className="btn btn--ghost"
              onClick={() => void updateLocalStatus('open')}
              disabled={settingLocalStatus}
            >
              Reopen
            </button>
          )}
          {localStatusError && (
            <span className="run__local-error" role="alert">
              {localStatusError}
            </span>
          )}
        </div>
      )}

      {canPost && (
        <div className="run__post">
          {/* Working-tree and project reviews have no single GitHub commit/PR thread target. */}
          {run.refType === 'commit' && (
            <button
              className="btn btn--ghost"
              onClick={() =>
                setPostModal({
                  kind: 'commitComment',
                  targetLabel: `commit ${run.headSha.slice(0, 8)}`
                })
              }
            >
              Post as commit comment
            </button>
          )}
          {run.refType === 'pr' && (
            <button
              className="btn btn--ghost"
              onClick={() => setPostModal({ kind: 'prComment', targetLabel: `PR #${run.refId}` })}
            >
              Post as PR comment
            </button>
          )}
          <button
            className="btn btn--ghost"
            onClick={() => setPostModal({ kind: 'issue', targetLabel: 'a new issue' })}
          >
            Create issue
          </button>
          {postedUrl && (
            <a className="link" href={postedUrl} target="_blank" rel="noreferrer">
              ✓ posted ↗
            </a>
          )}
        </div>
      )}

      {postModal && (
        <PostConfirmModal
          kind={postModal.kind}
          targetLabel={postModal.targetLabel}
          initialBody={reviewBody}
          initialTitle={postModal.kind === 'issue' ? issueTitle : undefined}
          warning={memoryPostWarning}
          mentionLogin={postModal.kind === 'issue' ? null : run.authorLogin}
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

export default RunView
