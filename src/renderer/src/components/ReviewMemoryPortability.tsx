import { useState } from 'react'

interface ReviewMemoryPortabilityProps {
  repoId: number | null
  disabled: boolean
  onImported: () => Promise<void>
}

function ReviewMemoryPortability({
  repoId,
  disabled,
  onImported
}: ReviewMemoryPortabilityProps): React.JSX.Element {
  const [exportText, setExportText] = useState('')
  const [importText, setImportText] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const exportRepo = async (): Promise<void> => {
    if (repoId === null) return
    setBusy(true)
    setStatus(null)
    try {
      const res = await window.aerie.reviewMemory.exportRepo(repoId)
      if (!res.ok) {
        setStatus(res.error)
        return
      }
      const text = JSON.stringify(res.value, null, 2)
      setExportText(text)
      try {
        await navigator.clipboard.writeText(text)
        setStatus(`Export copied: ${res.value.annotations.length} records.`)
      } catch {
        setStatus(`Export ready: ${res.value.annotations.length} records.`)
      }
    } finally {
      setBusy(false)
    }
  }

  const importRepo = async (): Promise<void> => {
    if (repoId === null || importText.trim().length === 0) return
    setBusy(true)
    setStatus(null)
    try {
      const res = await window.aerie.reviewMemory.importRepo({
        repoId,
        payload: importText
      })
      if (!res.ok) {
        setStatus(res.error)
        return
      }
      await onImported()
      const suffix = res.value.errors.length > 0 ? ` ${res.value.errors.join(' ')}` : ''
      setStatus(`Imported ${res.value.imported}; skipped ${res.value.skipped}.${suffix}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="review-memory__portability">
      <summary>Portability</summary>
      <div className="review-memory__portability-actions">
        <button
          className="btn btn--ghost"
          onClick={() => void exportRepo()}
          disabled={disabled || busy || repoId === null}
        >
          Export JSON
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => void importRepo()}
          disabled={disabled || busy || repoId === null || importText.trim().length === 0}
        >
          Import JSON
        </button>
      </div>
      {status && <p className="review-memory__portability-status">{status}</p>}
      {exportText && (
        <textarea
          className="field review-memory__json"
          value={exportText}
          readOnly
          aria-label="Review memory export JSON"
        />
      )}
      <textarea
        className="field review-memory__json"
        value={importText}
        onChange={(event) => setImportText(event.target.value)}
        placeholder="Paste review-memory JSON"
        disabled={disabled || busy}
        aria-label="Review memory import JSON"
      />
    </details>
  )
}

export default ReviewMemoryPortability
