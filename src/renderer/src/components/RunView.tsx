import { useCallback, useEffect, useRef, useState } from 'react'
import type { PostKind, RunRecord, RunStatus } from '@shared/types'
import PostConfirmModal from './PostConfirmModal'

const MAX_DISPLAY = 256 * 1024
const MAX_BODY = 60000

function isTerminal(s: RunStatus): boolean {
  return s === 'done' || s === 'error' || s === 'killed'
}

/**
 * Displays one run: live (or recorded) console transcript, status, Kill (while
 * running), and confirm-gated posting (when finished). Shared by the commit/PR
 * panel and the History view — so progress and logs are visible from both, for
 * running and finished runs alike.
 */
function RunView({
  run,
  onStatusChange
}: {
  run: RunRecord
  onStatusChange?: (status: RunStatus) => void
}): React.JSX.Element {
  const [output, setOutput] = useState('')
  const [status, setStatus] = useState<RunStatus>(run.status)
  const [cleanOutput, setCleanOutput] = useState('')
  const [postModal, setPostModal] = useState<{ kind: PostKind; targetLabel: string } | null>(null)
  const [posting, setPosting] = useState(false)
  const [postedUrl, setPostedUrl] = useState<string | null>(run.postedUrl)
  const [postError, setPostError] = useState<string | null>(null)
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

  const capped =
    cleanOutput.length > MAX_BODY
      ? `${cleanOutput.slice(0, MAX_BODY)}\n\n[aerie] output truncated for posting]`
      : cleanOutput
  const reviewBody = `${capped.trim()}\n\n---\n_Posted via Aerie · agent \`${run.agentId}\`_`
  const issueTitle = `Aerie review: ${
    run.refType === 'pr'
      ? `PR #${run.refId}`
      : run.refType === 'working-tree'
        ? `working tree (${run.headSha.slice(0, 8)})`
        : `commit ${run.headSha.slice(0, 8)}`
  }`
  const canPost = isTerminal(status) && cleanOutput.trim().length > 0
  // The runner (M-Q) flags an empty/truncated/transcript-leaked LLM review in the
  // transcript; surface that verdict here so the user reviews before posting. Reading
  // the marker keeps a single source of truth (the main-process assessment).
  // Anchored to line start (the runner emits it on its own line) so a review whose
  // own prose happens to quote the marker can't false-trigger the banner.
  const lowQualityMatch = output.match(/^\[aerie\] ⚠ low-quality review:\s*(.+)$/m)
  const lowQualityNote = lowQualityMatch ? lowQualityMatch[1].trim() : null

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

  return (
    <div className="runview">
      <div className="runview__bar">
        <span className={`chip run__status run__status--${status}`}>{status}</span>
        {active && (
          <button className="btn btn--danger" onClick={onKill}>
            Kill
          </button>
        )}
      </div>

      <pre className="run__console" ref={consoleRef}>
        {output || (active ? '…' : 'No output recorded.')}
      </pre>

      {isTerminal(status) && lowQualityNote && (
        <p className="run__warn" role="alert">
          ⚠ This review looks low-quality: {lowQualityNote} Check it before posting.
        </p>
      )}

      {canPost && (
        <div className="run__post">
          {/* A working-tree review is of uncommitted LOCAL changes — there is no commit
              or PR on GitHub to comment on, so only "Create issue" applies. */}
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
