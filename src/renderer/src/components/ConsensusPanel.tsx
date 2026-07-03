import type { ConsensusFinding } from '@shared/types'

function memoryDecisionLabel(decision: string): string {
  return decision.replace(/_/g, ' ')
}

function memoryLabel(finding: ConsensusFinding): string | null {
  const memory = finding.memory
  if (!memory) return null
  const parts = [`memory: ${memoryDecisionLabel(memory.annotation.decision)}`]
  if (memory.reopened) parts.push('reopened')
  if (memory.matchedBy === 'context_hash') parts.push('via context')
  return parts.join(' · ')
}

function FindingList({ findings }: { findings: ConsensusFinding[] }): React.JSX.Element {
  return (
    <ul className="run__findings-list">
      {findings.map((finding, index) => (
        <li key={finding.id || index} className="run__finding">
          <span className="chip">{finding.agreement}×</span>
          <span className={`chip sev sev--${finding.severity}`}>{finding.severity}</span>
          <code className="run__finding-loc">
            {finding.file}
            {finding.line != null ? `:${finding.line}` : ''}
          </code>
          <span className="run__finding-msg">{finding.message}</span>
          {finding.memory && (
            <span
              className={`chip run__memory-chip${finding.memory.suppresses ? ' run__memory-chip--suppressed' : ''}${finding.memory.reopened ? ' run__memory-chip--reopened' : ''}`}
              title={finding.memory.annotation.note || undefined}
            >
              {memoryLabel(finding)}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function ConsensusPanel({
  consensus,
  consensusMin,
  runCount,
  computing,
  onConsensusMinChange,
  onCompute
}: {
  consensus: ConsensusFinding[] | null
  consensusMin: number
  runCount: number
  computing: boolean
  onConsensusMinChange: (value: number) => void
  onCompute: () => void
}): React.JSX.Element {
  const actionable = consensus?.filter((finding) => !finding.memory?.suppresses) ?? null
  const suppressed = consensus?.filter((finding) => finding.memory?.suppresses) ?? []

  return (
    <div className="run__consensus">
      <div className="run__consensus-controls">
        <strong>Consensus</strong>
        <label className="run__consensus-min">
          agreed by ≥
          <select
            className="field"
            value={consensusMin}
            onChange={(event) => onConsensusMinChange(Number(event.target.value))}
            disabled={computing}
          >
            {Array.from({ length: Math.max(1, runCount) }, (_, i) => i + 1)
              .filter((n) => n >= 2)
              .map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
          </select>
          agents
        </label>
        <button className="btn btn--ghost" onClick={onCompute} disabled={computing}>
          {computing ? 'Computing…' : 'Compute'}
        </button>
      </div>
      <p className="hint">
        Consensus is by code location (file + line) — different agents word the same issue
        differently. Run it after the reviews finish.
      </p>
      {consensus !== null &&
        (actionable !== null && actionable.length === 0 ? (
          <p className="empty">
            {suppressed.length > 0
              ? 'All consensus findings are suppressed by review memory.'
              : `No location was flagged by ≥${consensusMin} agents (or no findings yet).`}
          </p>
        ) : (
          <FindingList findings={actionable ?? []} />
        ))}
      {suppressed.length > 0 && (
        <details className="run__suppressed">
          <summary>Suppressed by review memory ({suppressed.length})</summary>
          <FindingList findings={suppressed} />
        </details>
      )}
    </div>
  )
}

export default ConsensusPanel
