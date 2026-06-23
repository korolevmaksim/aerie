import { useCallback, useEffect, useRef, useState } from 'react'
import type { PostKind } from '@shared/types'
import { useFocusTrap } from '../lib/useFocusTrap'
import { useConfirm } from '../lib/useConfirm'

/**
 * The mandatory in-app confirmation before any GitHub write (SPEC §4). Shows the
 * exact target and the editable body; nothing is posted unless the user clicks
 * Post here.
 */
function PostConfirmModal({
  kind,
  targetLabel,
  initialBody,
  initialTitle,
  mentionLogin,
  busy,
  error,
  onCancel,
  onConfirm
}: {
  kind: PostKind
  targetLabel: string
  initialBody: string
  initialTitle?: string
  /** When set, offer a checkbox that prepends @login to notify the author. */
  mentionLogin?: string | null
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (body: string, title: string) => void
}): React.JSX.Element {
  const [body, setBody] = useState(initialBody)
  const [title, setTitle] = useState(initialTitle ?? '')
  const [tagged, setTagged] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  // Trap Tab focus within the dialog and restore focus to the opener on close.
  useFocusTrap(modalRef)
  const confirm = useConfirm()
  const canPost = body.trim().length > 0 && (kind !== 'issue' || title.trim().length > 0)
  const dirty = body !== initialBody || title !== (initialTitle ?? '') || tagged

  // Toggling the tag inserts/removes a leading "@login " so the user always sees
  // (and can still edit) the exact body that will be posted.
  const mentionPrefix = mentionLogin ? `@${mentionLogin} ` : ''
  const onToggleTag = (checked: boolean): void => {
    setTagged(checked)
    setBody((b) => {
      const stripped = b.startsWith(mentionPrefix) ? b.slice(mentionPrefix.length) : b
      return checked ? mentionPrefix + stripped : stripped
    })
  }

  const requestCancel = useCallback(async (): Promise<void> => {
    if (busy || confirming) return
    if (dirty) {
      setConfirming(true)
      const ok = await confirm({
        title: 'Discard post draft?',
        message: 'You have edited this post draft. Closing now will discard those unsaved changes.',
        confirmLabel: 'Discard draft',
        danger: true
      })
      setConfirming(false)
      if (!ok) return
    }
    onCancel()
  }, [busy, confirming, confirm, dirty, onCancel])

  // Escape cancels through the same discard guard (unless a post is in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy && !confirming) {
        e.preventDefault()
        void requestCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, confirming, requestCancel])

  return (
    <div className="modal-overlay">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm post to GitHub"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal__title">Confirm post to GitHub</h3>
        <p className="modal__target">
          This will post to <strong>{targetLabel}</strong> on GitHub. This is a public write and
          cannot be undone from Aerie.
        </p>
        {kind === 'issue' && (
          <input
            className="field"
            type="text"
            placeholder="Issue title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
          />
        )}
        {mentionLogin && (
          <label className="modal__tag">
            <input
              type="checkbox"
              checked={tagged}
              onChange={(e) => onToggleTag(e.target.checked)}
              disabled={busy}
            />
            Tag the author <code>@{mentionLogin}</code> (notifies them on GitHub)
          </label>
        )}
        <textarea
          className="field modal__body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          disabled={busy}
          autoFocus
        />
        {error && <p className="alert">{error}</p>}
        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={() => void requestCancel()} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={() => onConfirm(body, title)}
            disabled={busy || !canPost}
          >
            {busy ? 'Posting…' : 'Post to GitHub'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default PostConfirmModal
