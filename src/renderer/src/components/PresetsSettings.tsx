import { useEffect, useState } from 'react'
import type { AgentInfo, Preset } from '@shared/types'

/** Manage saved review presets (agent + model + reasoning) used on the run screen. */
function PresetsSettings(): React.JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [name, setName] = useState('')
  const [agentId, setAgentId] = useState('')
  const [model, setModel] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [a, p] = await Promise.all([
        window.aerie.runner.listAgents(),
        window.aerie.presets.list()
      ])
      if (cancelled) return
      if (a.ok) {
        setAgents(a.value)
        const first = a.value.find((x) => x.available) ?? a.value[0]
        if (first) {
          setAgentId(first.id)
          setModel(first.model)
          setReasoning(first.reasoning)
        }
      }
      if (p.ok) setPresets(p.value)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const selected = agents.find((a) => a.id === agentId)

  const onSelectAgent = (id: string): void => {
    setAgentId(id)
    const a = agents.find((x) => x.id === id)
    setModel(a?.model ?? '')
    setReasoning(a?.reasoning ?? '')
  }

  const onSave = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await window.aerie.presets.save({ name: name.trim(), agentId, model, reasoning })
      if (res.ok) {
        setPresets(res.value)
        setName('')
      } else {
        setError(res.error)
      }
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (id: number): Promise<void> => {
    const res = await window.aerie.presets.delete(id)
    if (res.ok) setPresets(res.value)
  }

  const agentLabel = (id: string): string => agents.find((a) => a.id === id)?.label ?? id

  return (
    <div className="presets">
      <h3 className="subhead">Review presets</h3>
      <p className="muted">
        Save an agent + model + reasoning combo, then apply it in one click on the run screen.
      </p>

      <form className="preset-form" onSubmit={onSave}>
        <input
          className="field"
          type="text"
          placeholder="Preset name (e.g. Deep Opus)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
        <select
          className="field"
          value={agentId}
          onChange={(e) => onSelectAgent(e.target.value)}
          disabled={busy}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
              {a.available ? '' : ' — not installed'}
            </option>
          ))}
        </select>
        {selected && selected.models.length > 0 && (
          <select
            className="field"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy}
            title="Model"
          >
            {selected.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
        {selected && selected.reasoningLevels.length > 0 && (
          <select
            className="field"
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value)}
            disabled={busy}
            title="Reasoning"
          >
            {selected.reasoningLevels.map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn--primary" type="submit" disabled={busy || !name.trim()}>
          Save preset
        </button>
      </form>
      {error && <p className="alert">{error}</p>}

      {presets.length === 0 ? (
        <p className="empty">No presets yet.</p>
      ) : (
        <ul className="accounts">
          {presets.map((p) => (
            <li key={p.id} className="account">
              <div className="account__main">
                <span className="account__login">{p.name}</span>
                <span className="account__label">
                  {agentLabel(p.agentId)}
                  {p.model ? ` · ${p.model}` : ''}
                  {p.reasoning ? ` · ${p.reasoning}` : ''}
                </span>
              </div>
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

export default PresetsSettings
