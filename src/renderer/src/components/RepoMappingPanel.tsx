import { useEffect, useState } from 'react'
import type { RepoMapping } from '@shared/types'

function RepoMappingPanel({ repoId }: { repoId: number }): React.JSX.Element {
  const [mapping, setMapping] = useState<RepoMapping | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.mapping.get(repoId)
      if (cancelled) return
      if (res.ok) setMapping(res.value)
      else setError(res.error)
    })()
    return () => {
      cancelled = true
    }
  }, [repoId])

  const apply = async (op: () => Promise<{ ok: boolean }>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = (await op()) as { ok: true; value: RepoMapping } | { ok: false; error: string }
      if (res.ok) setMapping(res.value)
      else setError(res.error)
    } finally {
      setBusy(false)
    }
  }

  if (!mapping) {
    return <div className="mapping">{error ? <p className="alert">{error}</p> : 'Loading…'}</div>
  }

  return (
    <div className="mapping">
      <div className="mapping__row">
        <span className="mapping__key">Remote</span>
        <code className="mapping__val">{mapping.remoteUrl ?? '—'}</code>
      </div>
      <div className="mapping__row">
        <span className="mapping__key">App clone</span>
        <code className="mapping__val">
          {mapping.appClonePath ?? 'not cloned yet (created on first prepare)'}
        </code>
      </div>
      <div className="mapping__row">
        <span className="mapping__key">Your local clone</span>
        <code className="mapping__val">{mapping.userLocalPath ?? '— not set —'}</code>
        <button
          className="btn btn--ghost"
          disabled={busy}
          onClick={() => apply(() => window.aerie.mapping.pickLocal(repoId))}
        >
          Set…
        </button>
        {mapping.userLocalPath && (
          <button
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => apply(() => window.aerie.mapping.clearLocal(repoId))}
          >
            Clear
          </button>
        )}
      </div>
      <label className="mapping__toggle">
        <input
          type="checkbox"
          checked={mapping.useLocalWorktree}
          disabled={busy || !mapping.userLocalPath}
          onChange={(e) => apply(() => window.aerie.mapping.setUseLocal(repoId, e.target.checked))}
        />
        Run agents off my local clone (read-only worktree) — default OFF
      </label>
      {error && <p className="alert">{error}</p>}
    </div>
  )
}

export default RepoMappingPanel
