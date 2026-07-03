import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  RepoSummary,
  ReviewMemoryAnnotation,
  ReviewMemoryDecision,
  ReviewMemoryEvent,
  ReviewMemoryScopeKind
} from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import ReviewMemoryEvents from './ReviewMemoryEvents'
import ReviewMemoryPortability from './ReviewMemoryPortability'

const DECISIONS: readonly ReviewMemoryDecision[] = [
  'accepted',
  'fixed',
  'false_positive',
  'accepted_risk',
  'duplicate',
  'dismissed',
  'needs_follow_up'
]

const SUPPRESSING_DECISIONS = new Set<ReviewMemoryDecision>([
  'false_positive',
  'accepted_risk',
  'duplicate',
  'dismissed'
])

type DecisionFilter = ReviewMemoryDecision | 'all'
type ScopeFilter = ReviewMemoryScopeKind | 'all'

interface Draft {
  decision: ReviewMemoryDecision
  note: string
}

function decisionLabel(decision: ReviewMemoryDecision | null): string {
  if (!decision) return 'none'
  if (decision === 'false_positive') return 'false positive'
  if (decision === 'accepted_risk') return 'accepted risk'
  if (decision === 'needs_follow_up') return 'needs follow-up'
  return decision
}

function stableShort(stableId: string): string {
  const parts = stableId.split(':')
  const tail = parts.at(-1) ?? stableId
  return tail.length > 12 ? tail.slice(0, 12) : tail
}

function requiresNote(decision: ReviewMemoryDecision): boolean {
  return SUPPRESSING_DECISIONS.has(decision)
}

function draftOf(annotation: ReviewMemoryAnnotation): Draft {
  return { decision: annotation.decision, note: annotation.note }
}

function isChanged(annotation: ReviewMemoryAnnotation, draft: Draft | undefined): boolean {
  return Boolean(
    draft &&
    (draft.decision !== annotation.decision || draft.note.trim() !== annotation.note.trim())
  )
}

function ReviewMemorySettings({ accountId }: { accountId: number | null }): React.JSX.Element {
  const [repos, setRepos] = useState<RepoSummary[]>([])
  const [repoId, setRepoId] = useState<number | null>(null)
  const [annotations, setAnnotations] = useState<ReviewMemoryAnnotation[]>([])
  const [events, setEvents] = useState<ReviewMemoryEvent[]>([])
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const [search, setSearch] = useState('')
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>('all')
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all')
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (accountId === null) {
      queueMicrotask(() => {
        if (cancelled) return
        setRepos([])
        setRepoId(null)
      })
      return () => {
        cancelled = true
      }
    }
    void (async () => {
      const res = await window.aerie.repos.list(accountId)
      if (cancelled) return
      if (res.ok) {
        setRepos(res.value.repos)
        setRepoId(res.value.repos[0]?.id ?? null)
      } else {
        setError(res.error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accountId])

  const loadMemory = useCallback(async (selectedRepoId: number): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [memoryRes, eventsRes] = await Promise.all([
        window.aerie.reviewMemory.listRepo(selectedRepoId),
        window.aerie.reviewMemory.listRepoEvents(selectedRepoId)
      ])
      if (memoryRes.ok) {
        setAnnotations(memoryRes.value)
        setSelectedIds(new Set())
        setDrafts(
          Object.fromEntries(
            memoryRes.value.map((annotation) => [annotation.id, draftOf(annotation)])
          )
        )
      } else {
        setError(memoryRes.error)
      }
      if (eventsRes.ok) setEvents(eventsRes.value)
      else setError(eventsRes.error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (repoId === null) {
      queueMicrotask(() => {
        setAnnotations([])
        setEvents([])
        setDrafts({})
        setSelectedIds(new Set())
      })
      return
    }
    queueMicrotask(() => void loadMemory(repoId))
  }, [loadMemory, repoId])

  const filteredAnnotations = useMemo(() => {
    const q = search.trim().toLowerCase()
    return annotations.filter((annotation) => {
      if (decisionFilter !== 'all' && annotation.decision !== decisionFilter) return false
      if (scopeFilter !== 'all' && annotation.scopeKind !== scopeFilter) return false
      if (!q) return true
      const haystack = [
        annotation.stableId,
        annotation.contextHash ?? '',
        annotation.decision,
        annotation.note,
        annotation.scopeKind,
        annotation.sourceFindingId?.toString() ?? '',
        annotation.sourceRunId?.toString() ?? ''
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [annotations, decisionFilter, scopeFilter, search])
  const visibleIds = useMemo(
    () => new Set(filteredAnnotations.map((annotation) => annotation.id)),
    [filteredAnnotations]
  )
  const selectedVisibleCount = filteredAnnotations.filter((annotation) =>
    selectedIds.has(annotation.id)
  ).length

  const saveAnnotation = async (annotation: ReviewMemoryAnnotation): Promise<void> => {
    const draft = drafts[annotation.id]
    if (!draft) return
    if (requiresNote(draft.decision) && draft.note.trim().length === 0) {
      setError('Suppressing decisions require a note.')
      return
    }
    setBusyId(annotation.id)
    setError(null)
    try {
      const res = await window.aerie.reviewMemory.updateAnnotation({
        annotationId: annotation.id,
        decision: draft.decision,
        note: draft.note
      })
      if (res.ok && repoId !== null) await loadMemory(repoId)
      else if (!res.ok) setError(res.error)
    } finally {
      setBusyId(null)
    }
  }

  const archiveAnnotation = async (annotation: ReviewMemoryAnnotation): Promise<void> => {
    setBusyId(annotation.id)
    setError(null)
    try {
      const res = await window.aerie.reviewMemory.clearAnnotation({ annotationId: annotation.id })
      if (res.ok && repoId !== null) await loadMemory(repoId)
      else if (!res.ok) setError(res.error)
    } finally {
      setBusyId(null)
    }
  }

  const archiveSelectedAnnotations = async (): Promise<void> => {
    if (repoId === null) return
    const ids = filteredAnnotations
      .map((annotation) => annotation.id)
      .filter((id) => selectedIds.has(id))
    if (ids.length === 0) return
    setBulkBusy(true)
    setError(null)
    try {
      for (const id of ids) {
        const res = await window.aerie.reviewMemory.clearAnnotation({ annotationId: id })
        if (!res.ok) {
          setError(res.error)
          break
        }
      }
      await loadMemory(repoId)
    } finally {
      setBulkBusy(false)
    }
  }

  const selectedRepoName = repos.find((repo) => repo.id === repoId)?.fullName ?? 'repository'

  return (
    <>
      <h3 className="subhead">Review memory</h3>
      <div className="review-memory">
        {accountId === null ? (
          <p className="empty">Add an account to manage review memory.</p>
        ) : repos.length === 0 ? (
          <p className="empty">No repositories loaded for this account yet.</p>
        ) : (
          <>
            <div className="review-memory__toolbar">
              <select
                className="field review-memory__repo"
                value={repoId ?? ''}
                onChange={(event) => setRepoId(Number(event.target.value))}
                disabled={loading}
                aria-label="Repository"
              >
                {repos.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.fullName}
                  </option>
                ))}
              </select>
              <input
                className="field field--grow"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search decisions, notes, stable/context ids"
              />
              <select
                className="field"
                value={decisionFilter}
                onChange={(event) => setDecisionFilter(event.target.value as DecisionFilter)}
                aria-label="Decision filter"
              >
                <option value="all">All decisions</option>
                {DECISIONS.map((decision) => (
                  <option key={decision} value={decision}>
                    {decisionLabel(decision)}
                  </option>
                ))}
              </select>
              <select
                className="field"
                value={scopeFilter}
                onChange={(event) => setScopeFilter(event.target.value as ScopeFilter)}
                aria-label="Scope filter"
              >
                <option value="all">All scopes</option>
                <option value="repo">Repo</option>
                <option value="global">Global</option>
              </select>
              <button
                className="btn btn--ghost"
                onClick={() => repoId !== null && void loadMemory(repoId)}
                disabled={loading || repoId === null}
              >
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {error && (
              <p className="alert" role="alert">
                {error}
              </p>
            )}

            <div className="review-memory__meta">
              <span className="muted">{selectedRepoName}</span>
              <span className="chip">{filteredAnnotations.length} shown</span>
              <span className="chip">{annotations.length} active</span>
              <span className="chip">{events.length} recent events</span>
              <span className="chip">{selectedVisibleCount} selected</span>
              <button
                className="btn btn--ghost"
                disabled={filteredAnnotations.length === 0 || bulkBusy}
                onClick={() => setSelectedIds(new Set(visibleIds))}
              >
                Select shown
              </button>
              <button
                className="btn btn--ghost"
                disabled={selectedIds.size === 0 || bulkBusy}
                onClick={() => setSelectedIds(new Set())}
              >
                Clear selection
              </button>
              <button
                className="btn btn--danger"
                disabled={selectedVisibleCount === 0 || bulkBusy}
                onClick={() => void archiveSelectedAnnotations()}
              >
                {bulkBusy ? 'Archiving…' : 'Archive selected'}
              </button>
            </div>

            {filteredAnnotations.length === 0 ? (
              <p className="empty">No review-memory decisions match these filters.</p>
            ) : (
              <ul className="review-memory__list">
                {filteredAnnotations.map((annotation) => {
                  const draft = drafts[annotation.id]
                  const changed = isChanged(annotation, draft)
                  const missingNote = Boolean(
                    draft && requiresNote(draft.decision) && draft.note.trim().length === 0
                  )
                  return (
                    <li key={annotation.id} className="review-memory__item">
                      <div className="review-memory__item-head">
                        <label className="review-memory__select">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(annotation.id)}
                            disabled={bulkBusy}
                            onChange={(event) =>
                              setSelectedIds((prev) => {
                                const next = new Set(prev)
                                if (event.target.checked) next.add(annotation.id)
                                else next.delete(annotation.id)
                                return next
                              })
                            }
                          />
                          <span className="sr-only">Select memory decision</span>
                        </label>
                        <span className="chip">{annotation.scopeKind}</span>
                        <span
                          className={`chip run__memory-chip${SUPPRESSING_DECISIONS.has(annotation.decision) ? ' run__memory-chip--suppressed' : ''}`}
                        >
                          {decisionLabel(annotation.decision)}
                        </span>
                        <code title={annotation.stableId}>
                          stable {stableShort(annotation.stableId)}
                        </code>
                        {annotation.contextHash && (
                          <code title={annotation.contextHash}>
                            context {stableShort(annotation.contextHash)}
                          </code>
                        )}
                        <span className="muted">
                          updated {formatRelativeTime(annotation.updatedAt)}
                        </span>
                      </div>
                      <div className="review-memory__edit">
                        <select
                          className="field"
                          value={draft?.decision ?? annotation.decision}
                          disabled={busyId === annotation.id}
                          onChange={(event) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [annotation.id]: {
                                ...(prev[annotation.id] ?? draftOf(annotation)),
                                decision: event.target.value as ReviewMemoryDecision
                              }
                            }))
                          }
                          aria-label="Decision"
                        >
                          {DECISIONS.map((decision) => (
                            <option key={decision} value={decision}>
                              {decisionLabel(decision)}
                            </option>
                          ))}
                        </select>
                        <input
                          className="field field--grow"
                          value={draft?.note ?? annotation.note}
                          disabled={busyId === annotation.id}
                          placeholder="Decision note"
                          onChange={(event) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [annotation.id]: {
                                ...(prev[annotation.id] ?? draftOf(annotation)),
                                note: event.target.value
                              }
                            }))
                          }
                        />
                        <button
                          className="btn btn--ghost"
                          disabled={!changed || missingNote || busyId === annotation.id}
                          onClick={() => void saveAnnotation(annotation)}
                        >
                          Save
                        </button>
                        <button
                          className="btn btn--ghost"
                          disabled={!changed || busyId === annotation.id}
                          onClick={() =>
                            setDrafts((prev) => ({ ...prev, [annotation.id]: draftOf(annotation) }))
                          }
                        >
                          Reset
                        </button>
                        <button
                          className="btn btn--danger"
                          disabled={busyId === annotation.id}
                          onClick={() => void archiveAnnotation(annotation)}
                        >
                          Archive
                        </button>
                      </div>
                      <div className="review-memory__source">
                        {annotation.sourceRunId !== null && (
                          <span>run #{annotation.sourceRunId}</span>
                        )}
                        {annotation.sourceFindingId !== null && (
                          <span>finding #{annotation.sourceFindingId}</span>
                        )}
                        {missingNote && <span className="review-memory__error">note required</span>}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            <ReviewMemoryPortability
              repoId={repoId}
              disabled={loading}
              onImported={() => (repoId === null ? Promise.resolve() : loadMemory(repoId))}
            />

            <ReviewMemoryEvents events={events} />
          </>
        )}
      </div>
    </>
  )
}

export default ReviewMemorySettings
