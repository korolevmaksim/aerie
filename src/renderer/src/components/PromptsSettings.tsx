import { useEffect, useState } from 'react'
import type { Prompt } from '@shared/types'
import { useConfirm } from '../lib/useConfirm'

/**
 * Manage editable review prompts — the INSTRUCTION half of the prompt fed to the
 * agent. Aerie always prepends the machine context (repo/sha/worktree + diff
 * paths), so a prompt here only needs to describe what kind of review to do. The
 * chosen prompt is picked per-run on the review screen.
 */
function PromptsSettings(): React.JSX.Element {
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [editingId, setEditingId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [baseline, setBaseline] = useState<{ id: number | null; name: string; body: string }>({
    id: null,
    name: '',
    body: ''
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = useConfirm()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.prompts.list()
      if (!cancelled && res.ok) setPrompts(res.value)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const formIsDirty = (): boolean =>
    name !== baseline.name || body !== baseline.body || editingId !== baseline.id

  const clearForm = (): void => {
    setEditingId(null)
    setName('')
    setBody('')
    setBaseline({ id: null, name: '', body: '' })
    setError(null)
  }

  const confirmDiscardForm = async (): Promise<boolean> => {
    if (!formIsDirty()) return true
    return confirm({
      title: 'Discard prompt draft?',
      message:
        'You have unsaved review-prompt changes. Closing now will discard the draft you entered.',
      confirmLabel: 'Discard draft',
      danger: true
    })
  }

  const requestResetForm = async (): Promise<void> => {
    if (!(await confirmDiscardForm())) return
    clearForm()
  }

  const onEdit = async (p: Prompt): Promise<void> => {
    if (!(await confirmDiscardForm())) return
    setEditingId(p.id)
    setName(p.name)
    setBody(p.body)
    setBaseline({ id: p.id, name: p.name, body: p.body })
    setError(null)
  }

  const onSave = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await window.aerie.prompts.save({
        id: editingId ?? undefined,
        name: name.trim(),
        body: body.trim()
      })
      if (res.ok) {
        setPrompts(res.value)
        clearForm()
      } else {
        setError(res.error)
      }
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (id: number): Promise<void> => {
    const ok = await confirm({
      title: 'Delete prompt',
      message: 'Delete this review prompt? This cannot be undone from Aerie.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    const res = await window.aerie.prompts.delete(id)
    if (res.ok) {
      setPrompts(res.value)
      if (editingId === id) clearForm()
    } else {
      setError(res.error)
    }
  }

  return (
    <div className="presets">
      <h3 className="subhead">Review prompts</h3>
      <p className="muted">
        Edit the default or add focused prompts (security, performance, tests…), then pick one on
        the run screen. The repository, commit, working-copy and diff paths are added automatically.
      </p>

      <form className="preset-form preset-form--stack" onSubmit={onSave}>
        <input
          className="field"
          type="text"
          placeholder="Prompt name (e.g. Security focus)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
        <textarea
          className="field modal__body"
          placeholder="Review the diff for…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          disabled={busy}
        />
        <div className="preset-form__actions">
          <button
            className="btn btn--primary"
            type="submit"
            disabled={busy || !name.trim() || !body.trim()}
          >
            {editingId ? 'Save changes' : 'Add prompt'}
          </button>
          {(editingId !== null || formIsDirty()) && (
            <button
              className="btn btn--ghost"
              type="button"
              onClick={() => void requestResetForm()}
              disabled={busy}
            >
              Cancel
            </button>
          )}
        </div>
      </form>
      {error && <p className="alert">{error}</p>}

      {prompts.length === 0 ? (
        <p className="empty">No prompts yet.</p>
      ) : (
        <ul className="prompt-list">
          {prompts.map((p) => (
            <li key={p.id} className="prompt-item">
              <div className="prompt-item__head">
                <span className="prompt-item__name" title={p.name}>
                  {p.name}
                </span>
                <div className="prompt-item__actions">
                  <button className="btn btn--ghost" onClick={() => void onEdit(p)}>
                    Edit
                  </button>
                  <button className="btn btn--danger" onClick={() => void onDelete(p.id)}>
                    Delete
                  </button>
                </div>
              </div>
              <p className="prompt-item__body">{p.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default PromptsSettings
