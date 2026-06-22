import { useEffect, useState } from 'react'
import type { RepoMapping, WorkingTreeMode } from '@shared/types'
import RunPanel from './RunPanel'

/**
 * Review the UNCOMMITTED changes in the user's mapped local clone — a pre-PR
 * review with zero GitHub calls (M7). Hard-requires a mapped local clone (the
 * changes exist only there); if none is set, points the user to the Mapping tab.
 * The user picks which diff to review: all uncommitted tracked changes
 * (`git diff HEAD`) or only what is staged (`git diff --staged`).
 */
function WorkingTreeView({
  accountId,
  repoId,
  onOpenMapping
}: {
  accountId: number
  repoId: number
  onOpenMapping: () => void
}): React.JSX.Element {
  const [mapping, setMapping] = useState<RepoMapping | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [mode, setMode] = useState<WorkingTreeMode>('working-tree')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.mapping.get(repoId)
      if (cancelled) return
      if (res.ok) setMapping(res.value)
      setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [repoId])

  if (!loaded) return <p className="empty">Loading…</p>

  if (!mapping?.userLocalPath) {
    return (
      <div className="worktree">
        <p className="empty">
          Working-tree review reads the uncommitted changes in your own local clone.
        </p>
        <p className="hint">
          Set <strong>Your local clone</strong> in the{' '}
          <button className="link link--button" onClick={onOpenMapping}>
            Mapping
          </button>{' '}
          tab to enable it. Aerie only runs read-only <code>git diff</code> there — it never
          modifies your working copy and makes no GitHub calls.
        </p>
      </div>
    )
  }

  return (
    <div className="worktree">
      <p className="hint">
        Reviewing uncommitted changes in <code>{mapping.userLocalPath}</code> — read-only, no GitHub
        calls.
      </p>
      <div className="worktree__modes" role="radiogroup" aria-label="Which changes to review">
        <label className="worktree__mode">
          <input
            type="radio"
            name="wt-mode"
            checked={mode === 'working-tree'}
            onChange={() => setMode('working-tree')}
          />
          All uncommitted changes
          <span className="muted"> (git diff HEAD)</span>
        </label>
        <label className="worktree__mode">
          <input
            type="radio"
            name="wt-mode"
            checked={mode === 'staged'}
            onChange={() => setMode('staged')}
          />
          Staged only
          <span className="muted"> (git diff --staged)</span>
        </label>
      </div>
      {/* key on mode so switching modes rehydrates the matching run, if any. */}
      <RunPanel
        key={mode}
        accountId={accountId}
        repoId={repoId}
        refType="working-tree"
        refId={mode}
      />
    </div>
  )
}

export default WorkingTreeView
