import { useEffect, useState } from 'react'
import type { Prompt } from '@shared/types'

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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const resetForm = (): void => {
    setEditingId(null)
    setName('')
    setBody('')
    setError(null)
  }

  const onEdit = (p: Prompt): void => {
    setEditingId(p.id)
    setName(p.name)
    setBody(p.body)
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
        resetForm()
      } else {
        setError(res.error)
      }
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (id: number): Promise<void> => {
    const res = await window.aerie.prompts.delete(id)
    if (res.ok) {
      setPrompts(res.value)
      if (editingId === id) resetForm()
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
          {editingId && (
            <button className="btn btn--ghost" type="button" onClick={resetForm} disabled={busy}>
              Cancel
            </button>
          )}
        </div>
      </form>
      {error && <p className="alert">{error}</p>}

      {prompts.length === 0 ? (
        <p className="empty">No prompts yet.</p>
      ) : (
        <ul className="accounts">
          {prompts.map((p) => (
            <li key={p.id} className="account">
              <div className="account__main">
                <span className="account__login">{p.name}</span>
                <span className="account__label account__label--clamp">{p.body}</span>
              </div>
              <button className="btn btn--ghost" onClick={() => onEdit(p)}>
                Edit
              </button>
              <button className="btn btn--danger" onClick={() => onDelete(p.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default PromptsSettings
