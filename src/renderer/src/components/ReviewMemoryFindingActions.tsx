import { useState } from 'react'
import type { ReviewMemoryDecision, RunFinding } from '@shared/types'

const QUICK_MEMORY_DECISIONS: ReadonlyArray<{ decision: ReviewMemoryDecision; label: string }> = [
  { decision: 'accepted', label: 'Accept' },
  { decision: 'fixed', label: 'Fixed' },
  { decision: 'false_positive', label: 'False positive' },
  { decision: 'dismissed', label: 'Dismiss' }
]

function decisionRequiresNote(decision: ReviewMemoryDecision): boolean {
  return (
    decision === 'false_positive' ||
    decision === 'accepted_risk' ||
    decision === 'duplicate' ||
    decision === 'dismissed'
  )
}

function ReviewMemoryFindingActions({
  finding,
  onChanged
}: {
  finding: RunFinding
  onChanged: () => Promise<void> | void
}): React.JSX.Element {
  const [draft, setDraft] = useState<{ decision: ReviewMemoryDecision; note: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const memory = finding.memory

  const saveDecision = async (decision: ReviewMemoryDecision, note = ''): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await window.aerie.reviewMemory.annotateFinding({
        findingId: finding.id,
        decision,
        scopeKind: 'repo',
        note
      })
      if (res.ok) {
        setDraft(null)
        await onChanged()
      } else {
        setError(res.error)
      }
    } finally {
      setBusy(false)
    }
  }

  const archiveDecision = async (): Promise<void> => {
    const annotationId = memory?.annotation.id
    if (!annotationId) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.aerie.reviewMemory.clearAnnotation({ annotationId })
      if (res.ok) await onChanged()
      else setError(res.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="run__finding-actions" aria-label="Review-memory actions">
        {QUICK_MEMORY_DECISIONS.map((item) => (
          <button
            key={item.decision}
            className="btn btn--ghost run__finding-action"
            disabled={busy || memory?.annotation.decision === item.decision}
            onClick={() => {
              if (decisionRequiresNote(item.decision)) {
                setDraft({
                  decision: item.decision,
                  note: memory?.annotation.note ?? ''
                })
              } else {
                void saveDecision(item.decision)
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
            onClick={() => void archiveDecision()}
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
            onChange={(event) => setDraft({ ...draft, note: event.target.value })}
          />
          <button
            className="btn btn--primary"
            disabled={busy || (decisionRequiresNote(draft.decision) && draft.note.trim() === '')}
            onClick={() => void saveDecision(draft.decision, draft.note)}
          >
            Save
          </button>
          <button className="btn btn--ghost" disabled={busy} onClick={() => setDraft(null)}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p className="run__memory-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

export default ReviewMemoryFindingActions
