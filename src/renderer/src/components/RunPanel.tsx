import { useEffect, useState } from 'react'
import type {
  AgentInfo,
  ConsensusFinding,
  Preset,
  Prompt,
  RefType,
  RunRecord,
  RunStatus,
  StartBatchResult
} from '@shared/types'
import RunView from './RunView'

/**
 * Launcher for a run on a commit/PR/working-tree: pick an agent (installed ones
 * marked), a model, and a review prompt, start it, and show its live RunView. A run
 * already in flight for this ref is rehydrated so it can be controlled after
 * navigating away and back.
 */
function RunPanel({
  accountId,
  repoId,
  sha,
  refType,
  refId,
  authorLogin
}: {
  accountId: number
  repoId: number
  /** Head SHA for commit/PR runs; for working-tree runs the main process resolves it. */
  sha?: string
  refType: RefType
  refId: string
  /** Commit/PR author login — persisted on the run so a comment can @-mention them. */
  authorLogin?: string | null
}): React.JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [agentId, setAgentId] = useState('')
  const [presets, setPresets] = useState<Preset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [promptId, setPromptId] = useState<number | null>(null)
  const [currentRun, setCurrentRun] = useState<RunRecord | null>(null)
  const [currentStatus, setCurrentStatus] = useState<RunStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Panel-review (multi-agent fan-out) state. Off by default — single-agent is the norm.
  const [panelMode, setPanelMode] = useState(false)
  const [panelIds, setPanelIds] = useState<Set<string>>(new Set())
  const [batchRuns, setBatchRuns] = useState<RunRecord[]>([])
  const [batchSkipped, setBatchSkipped] = useState<StartBatchResult['skipped']>([])
  const [consensus, setConsensus] = useState<ConsensusFinding[] | null>(null)
  const [consensusMin, setConsensusMin] = useState(2)
  const [computingConsensus, setComputingConsensus] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [a, p, pr] = await Promise.all([
        window.aerie.runner.listAgents(),
        window.aerie.presets.list(),
        window.aerie.prompts.list()
      ])
      if (cancelled) return
      if (a.ok) {
        setAgents(a.value)
        setAgentId((prev) => {
          if (prev) return prev
          const firstAvailable = a.value.find((x) => x.available)
          return (firstAvailable ?? a.value[0])?.id ?? ''
        })
      }
      if (p.ok) setPresets(p.value)
      if (pr.ok) {
        setPrompts(pr.value)
        setPromptId((prev) => prev ?? pr.value[0]?.id ?? null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Rehydrate a run already in flight (or the latest) for this ref.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.runner.listRuns(repoId)
      if (cancelled) return
      // Panel runs are session-only (not rehydrated), so clear them when the ref changes —
      // otherwise commit A's panel reviews would linger when navigating to commit B.
      setBatchRuns([])
      setBatchSkipped([])
      setConsensus(null)
      if (!res.ok) return
      // commit runs are keyed by head SHA; PR and working-tree runs by refId
      // (the PR number, or the working-tree mode), since their head SHA varies.
      const match = res.value.find(
        (r) =>
          r.refType === refType && (refType === 'commit' ? r.headSha === sha : r.refId === refId)
      )
      if (match) {
        setCurrentRun(match)
        setCurrentStatus(match.status)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [repoId, refType, refId, sha])

  const selectedAgent = agents.find((a) => a.id === agentId)
  const active = currentStatus === 'queued' || currentStatus === 'running'
  // Guard against a promptId that no longer exists (e.g. deleted in Settings): the
  // picker and the start request always use a live id (or the first prompt).
  const effectivePromptId = prompts.some((p) => p.id === promptId)
    ? promptId
    : (prompts[0]?.id ?? null)

  // A manual agent/model/reasoning change means the selection no longer matches a
  // preset, so the preset picker returns to its "Preset…" placeholder.
  const onChangeAgent = (id: string): void => {
    setAgentId(id)
    setSelectedPresetId('')
  }

  const onChangeModel = async (model: string): Promise<void> => {
    setSelectedPresetId('')
    const res = await window.aerie.runner.setAgentModel(agentId, model)
    if (res.ok) setAgents(res.value)
  }

  const onChangeReasoning = async (level: string): Promise<void> => {
    setSelectedPresetId('')
    const res = await window.aerie.runner.setAgentReasoning(agentId, level)
    if (res.ok) setAgents(res.value)
  }

  // Apply a saved preset: select its agent, persist its model + reasoning, and
  // reflect the choice in the picker.
  const onApplyPreset = async (presetId: string): Promise<void> => {
    const preset = presets.find((p) => String(p.id) === presetId)
    if (!preset) return
    // The preset's agent may no longer be in the registry (removed/renamed). Don't
    // apply a selection that would leave the controls in an invalid state.
    if (!agents.some((a) => a.id === preset.agentId)) {
      setError(`Preset "${preset.name}" uses an agent that is no longer available.`)
      return
    }
    setError(null)
    setAgentId(preset.agentId)
    let latest = agents
    if (preset.model) {
      const r = await window.aerie.runner.setAgentModel(preset.agentId, preset.model)
      if (r.ok) latest = r.value
    }
    if (preset.reasoning) {
      const r = await window.aerie.runner.setAgentReasoning(preset.agentId, preset.reasoning)
      if (r.ok) latest = r.value
    }
    setAgents(latest)
    setSelectedPresetId(presetId)
  }

  const onStart = async (): Promise<void> => {
    setStarting(true)
    setError(null)
    try {
      const res = await window.aerie.runner.start({
        accountId,
        repoId,
        // Working-tree runs have no renderer-known SHA — main resolves the clone HEAD.
        sha: sha ?? '',
        refType,
        refId,
        agentId,
        promptId: effectivePromptId ?? undefined,
        authorLogin: authorLogin ?? null
      })
      if (res.ok) {
        setCurrentRun(res.value)
        setCurrentStatus(res.value.status)
      } else {
        setError(res.error)
      }
    } finally {
      setStarting(false)
    }
  }

  // Panel review: fan out the selected agents on this ref; each runs with its own
  // saved/default model. The runs stream side by side below.
  const onStartBatch = async (): Promise<void> => {
    setStarting(true)
    setError(null)
    try {
      const res = await window.aerie.runner.startBatch({
        accountId,
        repoId,
        sha: sha ?? '',
        refType,
        refId,
        agentIds: [...panelIds],
        promptId: effectivePromptId ?? undefined,
        authorLogin: authorLogin ?? null
      })
      if (res.ok) {
        setBatchRuns(res.value.runs)
        setBatchSkipped(res.value.skipped)
        if (res.value.runs.length === 0) setError('No agents could be started for this review.')
      } else {
        setError(res.error)
      }
    } finally {
      setStarting(false)
    }
  }

  const togglePanelId = (id: string): void =>
    setPanelIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Cross-agent consensus: aggregate the panel runs' findings by location, keeping only
  // issues that >= consensusMin of the agents flagged. Run after the reviews finish.
  const onComputeConsensus = async (): Promise<void> => {
    setComputingConsensus(true)
    setError(null)
    try {
      const res = await window.aerie.runner.consensus({
        runIds: batchRuns.map((r) => r.id),
        consensusMin,
        groupBy: 'location'
      })
      if (res.ok) setConsensus(res.value.findings)
      else setError(res.error)
    } finally {
      setComputingConsensus(false)
    }
  }

  const installedAgents = agents.filter((a) => a.available)
  const labelFor = (id: string): string => agents.find((a) => a.id === id)?.label ?? id

  return (
    <div className="run">
      <label className="run__panel-toggle" title="Run several agents on this change at once">
        <input
          type="checkbox"
          checked={panelMode}
          onChange={(e) => {
            setPanelMode(e.target.checked)
            setError(null)
          }}
          disabled={starting}
        />
        Panel review (run several agents)
      </label>

      {!panelMode ? (
        <>
          <div className="run__controls">
            {presets.length > 0 && (
              <select
                className="field"
                value={selectedPresetId}
                onChange={(e) => onApplyPreset(e.target.value)}
                disabled={active || starting}
                title="Apply a saved preset"
              >
                <option value="" disabled>
                  Preset…
                </option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <select
              className="field"
              value={agentId}
              onChange={(e) => onChangeAgent(e.target.value)}
              disabled={active || starting}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {a.available ? '' : ' — not installed'}
                </option>
              ))}
            </select>
            {prompts.length > 0 && (
              <select
                className="field"
                value={effectivePromptId ?? ''}
                onChange={(e) => setPromptId(Number(e.target.value))}
                disabled={active || starting}
                title="Review prompt"
              >
                {prompts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            {selectedAgent && selectedAgent.models.length > 0 && (
              <select
                className="field"
                value={selectedAgent.model}
                onChange={(e) => onChangeModel(e.target.value)}
                disabled={active || starting}
                title="Model"
              >
                {selectedAgent.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
            {selectedAgent && selectedAgent.reasoningLevels.length > 0 && (
              <select
                className="field"
                value={selectedAgent.reasoning}
                onChange={(e) => onChangeReasoning(e.target.value)}
                disabled={active || starting}
                title="Reasoning / thinking effort"
              >
                {selectedAgent.reasoningLevels.map((lvl) => (
                  <option key={lvl} value={lvl}>
                    {lvl}
                  </option>
                ))}
              </select>
            )}
            <button
              className="btn btn--primary"
              onClick={onStart}
              disabled={
                !agentId || !selectedAgent || active || starting || !selectedAgent.available
              }
            >
              {active || starting ? 'Running…' : 'Review with agent'}
            </button>
          </div>
          {selectedAgent && !selectedAgent.available && (
            <p className="hint">
              The <code>{selectedAgent.label}</code> CLI isn’t on your PATH — install it to use this
              agent.
            </p>
          )}
          {error && <p className="alert">{error}</p>}
          {currentRun && (
            <RunView key={currentRun.id} run={currentRun} onStatusChange={setCurrentStatus} />
          )}
        </>
      ) : (
        <>
          <div className="run__controls">
            {prompts.length > 0 && (
              <select
                className="field"
                value={effectivePromptId ?? ''}
                onChange={(e) => setPromptId(Number(e.target.value))}
                disabled={starting}
                title="Review prompt (shared by every agent)"
              >
                {prompts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <button
              className="btn btn--primary"
              onClick={onStartBatch}
              disabled={panelIds.size === 0 || starting}
            >
              {starting
                ? 'Starting…'
                : `Review with ${panelIds.size} agent${panelIds.size === 1 ? '' : 's'}`}
            </button>
          </div>
          {installedAgents.length === 0 ? (
            <p className="hint">No installed agents to run — install an agent CLI and re-scan.</p>
          ) : (
            <div className="run__agent-picks">
              {installedAgents.map((a) => (
                <label key={a.id} className="run__agent-pick">
                  <input
                    type="checkbox"
                    checked={panelIds.has(a.id)}
                    onChange={() => togglePanelId(a.id)}
                    disabled={starting}
                  />
                  {a.label}
                </label>
              ))}
            </div>
          )}
          <p className="hint">
            Each agent runs with its own saved model; up to 3 run at once (the rest queue).
          </p>
          {error && <p className="alert">{error}</p>}
          {batchSkipped.length > 0 && (
            <p className="hint">
              Skipped:{' '}
              {batchSkipped
                .map((s) => `${labelFor(s.id)} (${s.reason.replace(/-/g, ' ')})`)
                .join(', ')}
              .
            </p>
          )}
          {batchRuns.length > 1 && (
            <div className="run__consensus">
              <div className="run__consensus-controls">
                <strong>Consensus</strong>
                <label className="run__consensus-min">
                  agreed by ≥
                  <select
                    className="field"
                    value={consensusMin}
                    onChange={(e) => setConsensusMin(Number(e.target.value))}
                    disabled={computingConsensus}
                  >
                    {Array.from({ length: Math.max(1, batchRuns.length) }, (_, i) => i + 1)
                      .filter((n) => n >= 2)
                      .map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                  </select>
                  agents
                </label>
                <button
                  className="btn btn--ghost"
                  onClick={() => void onComputeConsensus()}
                  disabled={computingConsensus}
                >
                  {computingConsensus ? 'Computing…' : 'Compute'}
                </button>
              </div>
              <p className="hint">
                Consensus is by code location (file + line) — different agents word the same issue
                differently. Run it after the reviews finish.
              </p>
              {consensus !== null &&
                (consensus.length === 0 ? (
                  <p className="empty">
                    No location was flagged by ≥{consensusMin} agents (or no findings yet).
                  </p>
                ) : (
                  <ul className="run__findings-list">
                    {consensus.map((c, i) => (
                      <li key={i} className="run__finding">
                        <span className="chip">{c.agreement}×</span>
                        <span className={`chip sev sev--${c.severity}`}>{c.severity}</span>
                        <code className="run__finding-loc">
                          {c.file}
                          {c.line != null ? `:${c.line}` : ''}
                        </code>
                        <span className="run__finding-msg">{c.message}</span>
                      </li>
                    ))}
                  </ul>
                ))}
            </div>
          )}

          {batchRuns.map((r) => (
            <div key={r.id} className="run__batch-item">
              <h4 className="run__batch-agent">{labelFor(r.agentId)}</h4>
              <RunView run={r} />
            </div>
          ))}
        </>
      )}
    </div>
  )
}

export default RunPanel
