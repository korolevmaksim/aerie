import { useEffect, useState } from 'react'
import type { AgentInfo, Preset, Prompt, RunRecord, RunStatus } from '@shared/types'
import RunView from './RunView'

/**
 * Launcher for a run on a commit/PR: pick an agent (installed ones marked), a
 * model, and a review prompt, start it, and show its live RunView. A run already
 * in flight for this ref is rehydrated so it can be controlled after navigating
 * away and back.
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
  sha: string
  refType: 'commit' | 'pr'
  refId: string
  /** Commit/PR author login — persisted on the run so a comment can @-mention them. */
  authorLogin?: string | null
}): React.JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [agentId, setAgentId] = useState('')
  const [presets, setPresets] = useState<Preset[]>([])
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [promptId, setPromptId] = useState<number | null>(null)
  const [currentRun, setCurrentRun] = useState<RunRecord | null>(null)
  const [currentStatus, setCurrentStatus] = useState<RunStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      if (cancelled || !res.ok) return
      const match = res.value.find(
        (r) => r.refType === refType && (refType === 'pr' ? r.refId === refId : r.headSha === sha)
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

  const onChangeModel = async (model: string): Promise<void> => {
    const res = await window.aerie.runner.setAgentModel(agentId, model)
    if (res.ok) setAgents(res.value)
  }

  const onChangeReasoning = async (level: string): Promise<void> => {
    const res = await window.aerie.runner.setAgentReasoning(agentId, level)
    if (res.ok) setAgents(res.value)
  }

  // Apply a saved preset: select its agent and persist its model + reasoning.
  const onApplyPreset = async (presetId: string): Promise<void> => {
    const preset = presets.find((p) => String(p.id) === presetId)
    if (!preset) return
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
  }

  const onStart = async (): Promise<void> => {
    setStarting(true)
    setError(null)
    try {
      const res = await window.aerie.runner.start({
        accountId,
        repoId,
        sha,
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

  return (
    <div className="run">
      <div className="run__controls">
        {presets.length > 0 && (
          <select
            className="field"
            value=""
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
          onChange={(e) => setAgentId(e.target.value)}
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
          disabled={!agentId || active || starting || selectedAgent?.available === false}
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
    </div>
  )
}

export default RunPanel
