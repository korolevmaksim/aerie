import { useEffect, useRef, useState } from 'react'
import type { PostKind } from '@shared/types'
import { useFocusTrap } from '../lib/useFocusTrap'

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
  const modalRef = useRef<HTMLDivElement>(null)
  // Trap Tab focus within the dialog and restore focus to the opener on close.
  useFocusTrap(modalRef)
  const canPost = body.trim().length > 0 && (kind !== 'issue' || title.trim().length > 0)

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

  // Escape cancels (unless a post is in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onCancel}>
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
          <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
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
