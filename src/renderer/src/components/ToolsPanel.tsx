import { useCallback, useEffect, useState } from 'react'
import type { AgentInfo } from '@shared/types'
import AgentEditor from './AgentEditor'

/**
 * Read-only inventory of the agent CLIs Aerie auto-detects on this machine — the
 * visible home for tool autodiscovery. Uses the existing `runner.listAgents`
 * surface (no new IPC); "Re-scan" re-runs PATH detection.
 */
function describeCapabilities(agent: AgentInfo): string {
  const parts: string[] = []
  if (agent.models.length > 0) {
    const src = agent.modelsSource === 'discovered' ? ' (live)' : ''
    parts.push(`${agent.models.length} model${agent.models.length > 1 ? 's' : ''}${src}`)
  }
  if (agent.reasoningLevels.length > 0) parts.push('reasoning levels')
  return parts.join(' · ')
}

function ToolRow({
  agent,
  onApprove
}: {
  agent: AgentInfo
  onApprove: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="mapping__row">
      <span className="mapping__key">{agent.label}</span>
      <code className="mapping__val">{agent.available ? (agent.path ?? '(on PATH)') : '—'}</code>
      <span className="muted">{describeCapabilities(agent) || '—'}</span>
      {agent.needsConsent && agent.available && (
        <span className="agent-consent">
          <span className="agent-consent__warn">⚠ needs approval</span>
          <button className="btn btn--ghost" onClick={() => onApprove(agent.id)}>
            Approve to run
          </button>
        </span>
      )}
    </div>
  )
}

function ToolsPanel(): React.JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true)
    setError(null)
    const res = await window.aerie.runner.listAgents()
    if (res.ok) setAgents(res.value)
    else setError(res.error)
    setScanning(false)
  }, [])

  // Exec-consent (M12): approve a user-added agent's exact command so it may be spawned.
  const approve = useCallback(async (id: string): Promise<void> => {
    setError(null)
    const res = await window.aerie.runner.approveAgent(id)
    if (res.ok) setAgents(res.value)
    else setError(res.error)
  }, [])

  // Live model discovery (M2): runs each installed agent's model-list probe (e.g.
  // `opencode models`) and overlays the discovered models on the static seeds.
  const discover = useCallback(async (): Promise<void> => {
    setDiscovering(true)
    setError(null)
    const res = await window.aerie.runner.discoverAgents()
    if (res.ok) setAgents(res.value)
    else setError(res.error)
    setDiscovering(false)
  }, [])

  // Initial load: await first (no synchronous setState in the effect); the Re-scan
  // button owns the spinner state via `scan`.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.aerie.runner.listAgents()
      if (cancelled) return
      if (res.ok) setAgents(res.value)
      else setError(res.error)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const installed = (agents ?? []).filter((a) => a.available)
  const missing = (agents ?? []).filter((a) => !a.available)

  return (
    <section className="panel" aria-busy={scanning || discovering}>
      <div className="panel__head">
        <h2 className="panel__title">Tools</h2>
        <div className="panel__head-actions">
          <button
            className="btn btn--ghost"
            onClick={() => void discover()}
            disabled={scanning || discovering}
            title="Run each installed agent's model-list probe (e.g. `opencode models`)"
          >
            {discovering ? 'Discovering…' : 'Discover models'}
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => void scan()}
            disabled={scanning || discovering}
          >
            {scanning ? 'Scanning…' : 'Re-scan'}
          </button>
        </div>
      </div>

      {error && <p className="alert">{error}</p>}

      {agents === null ? (
        !error && <p className="empty">Scanning your PATH…</p>
      ) : (
        <>
          <p className="muted" aria-live="polite">
            Aerie auto-detects the agent CLIs installed on your machine —{' '}
            <strong>{installed.length}</strong> of {agents.length} found on your PATH. Adding or
            editing an agent is a config edit in <code>agents.json</code>, never a code change.
          </p>

          <h3 className="subhead">Installed ({installed.length})</h3>
          {installed.length === 0 ? (
            <p className="hint">
              No agent CLIs found on your PATH yet — install one (e.g. Codex, Claude Code, Gemini)
              and Re-scan.
            </p>
          ) : (
            <div className="mapping">
              {installed.map((a) => (
                <ToolRow key={a.id} agent={a} onApprove={approve} />
              ))}
            </div>
          )}

          {missing.length > 0 && (
            <>
              <h3 className="subhead">Not installed ({missing.length})</h3>
              <div className="mapping">
                {missing.map((a) => (
                  <ToolRow key={a.id} agent={a} onApprove={approve} />
                ))}
              </div>
            </>
          )}

          <AgentEditor agents={agents} onChange={setAgents} />
        </>
      )}
    </section>
  )
}

export default ToolsPanel
