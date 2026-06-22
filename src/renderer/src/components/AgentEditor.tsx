import { useState } from 'react'
import type { Agent, AgentInfo } from '@shared/types'
import {
  agentToForm,
  blankForm,
  formToAgent,
  type AgentFormState,
  type EnvRow
} from '../lib/agentForm'

/**
 * In-app agent registry editor (ROADMAP M12). Add / edit / clone / delete USER agents.
 * Security is enforced in main: a save can't shadow a built-in and anything saved still
 * needs exec-consent before it can run (surfaced here as "needs approval").
 */
function AgentEditor({
  agents,
  onChange
}: {
  agents: AgentInfo[]
  onChange: (agents: AgentInfo[]) => void
}): React.JSX.Element {
  const [form, setForm] = useState<AgentFormState | null>(null)
  const [base, setBase] = useState<Agent | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cloneFrom, setCloneFrom] = useState('')

  const userAgents = agents.filter((a) => a.editable)

  const openNew = (): void => {
    setForm(blankForm())
    setBase(null)
    setEditingId(null)
    setError(null)
  }

  const openFrom = async (id: string, asClone: boolean): Promise<void> => {
    setError(null)
    const res = await window.aerie.runner.getAgent(id)
    if (!res.ok || !res.value) {
      setError(res.ok ? 'Agent not found.' : res.error)
      return
    }
    const f = agentToForm(res.value)
    if (asClone) {
      f.id = ''
      f.label = `${res.value.label} (copy)`
    }
    setForm(f)
    setBase(res.value)
    setEditingId(asClone ? null : id)
  }

  const onSave = async (): Promise<void> => {
    if (!form) return
    const built = formToAgent(form, base ?? undefined)
    if (!built.ok) {
      setError(built.error)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await window.aerie.runner.saveAgent(built.agent, editingId ?? undefined)
      if (res.ok) {
        onChange(res.value)
        setForm(null)
        setBase(null)
        setEditingId(null)
      } else {
        setError(res.error)
      }
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (id: string): Promise<void> => {
    if (!window.confirm(`Delete the agent "${id}"? This removes it from agents.json.`)) return
    const res = await window.aerie.runner.deleteAgent(id)
    if (res.ok) onChange(res.value)
    else setError(res.error)
  }

  const onApprove = async (id: string): Promise<void> => {
    const res = await window.aerie.runner.approveAgent(id)
    if (res.ok) onChange(res.value)
    else setError(res.error)
  }

  const set = (patch: Partial<AgentFormState>): void => setForm((f) => (f ? { ...f, ...patch } : f))
  const setEnv = (i: number, patch: Partial<EnvRow>): void =>
    setForm((f) => (f ? { ...f, env: f.env.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : f))

  return (
    <section className="agent-editor">
      <h3 className="subhead">Your agents ({userAgents.length})</h3>
      {error && <p className="alert">{error}</p>}

      {form === null ? (
        <>
          {userAgents.length === 0 ? (
            <p className="hint">
              No custom agents yet. Add one, or clone a built-in below as a starting point. A new
              agent must be approved before it can run.
            </p>
          ) : (
            <div className="mapping">
              {userAgents.map((a) => (
                <div key={a.id} className="mapping__row">
                  <span className="mapping__key">{a.label}</span>
                  <code className="mapping__val">{a.id}</code>
                  {a.needsConsent && <span className="agent-consent__warn">⚠ needs approval</span>}
                  <span className="agent-editor__actions">
                    {a.needsConsent && (
                      <button className="btn btn--ghost" onClick={() => void onApprove(a.id)}>
                        Approve
                      </button>
                    )}
                    <button className="btn btn--ghost" onClick={() => void openFrom(a.id, false)}>
                      Edit
                    </button>
                    <button className="btn btn--danger" onClick={() => void onDelete(a.id)}>
                      Delete
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="agent-editor__add">
            <button className="btn btn--primary" onClick={openNew}>
              New agent
            </button>
            <label className="agent-editor__clone">
              Clone an agent:
              <select
                className="field"
                aria-label="Clone an agent"
                value={cloneFrom}
                onChange={(e) => {
                  const id = e.target.value
                  setCloneFrom('')
                  if (id) void openFrom(id, true)
                }}
              >
                <option value="">Choose…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      ) : (
        <div className="agent-editor__form">
          <p className="hint">
            {editingId ? `Editing "${editingId}"` : 'New agent'}. After saving, approve its command
            to run it. Use <code>{'{{prompt}}'}</code>, <code>{'{{repoPath}}'}</code>,{' '}
            <code>{'{{diffFile}}'}</code>, <code>{'{{model}}'}</code> in args/env.
          </p>
          <label className="agent-editor__field">
            Id
            <input
              className="field"
              value={form.id}
              onChange={(e) => set({ id: e.target.value })}
              placeholder="my-agent"
            />
          </label>
          <label className="agent-editor__field">
            Label
            <input
              className="field"
              value={form.label}
              onChange={(e) => set({ label: e.target.value })}
            />
          </label>
          <label className="agent-editor__field">
            Command (binary on PATH)
            <input
              className="field"
              value={form.command}
              onChange={(e) => set({ command: e.target.value })}
              placeholder="my-cli"
            />
          </label>
          <label className="agent-editor__field">
            Args (one per line)
            <textarea
              className="field"
              rows={6}
              value={form.argsText}
              onChange={(e) => set({ argsText: e.target.value })}
            />
          </label>
          <div className="agent-editor__row">
            <label className="agent-editor__field">
              Prompt delivery
              <select
                className="field"
                value={form.promptDelivery}
                onChange={(e) =>
                  set({ promptDelivery: e.target.value as AgentFormState['promptDelivery'] })
                }
              >
                <option value="arg">arg</option>
                <option value="stdin">stdin</option>
                <option value="file">file</option>
              </select>
            </label>
            <label className="agent-editor__field">
              Kind
              <select
                className="field"
                value={form.kind}
                onChange={(e) => set({ kind: e.target.value as AgentFormState['kind'] })}
              >
                <option value="agent">agent (LLM)</option>
                <option value="tool">tool (linter/SAST)</option>
              </select>
            </label>
            <label className="agent-editor__field">
              Timeout (s)
              <input
                className="field"
                type="number"
                value={form.timeoutSec}
                onChange={(e) => set({ timeoutSec: e.target.value })}
              />
            </label>
          </div>
          <div className="agent-editor__row">
            <label className="agent-editor__field">
              Output capture
              <select
                className="field"
                value={form.outputCapture}
                onChange={(e) =>
                  set({ outputCapture: e.target.value as AgentFormState['outputCapture'] })
                }
              >
                <option value="stdout">stdout</option>
                <option value="file">file</option>
              </select>
            </label>
            {form.outputCapture === 'file' && (
              <label className="agent-editor__field">
                Output file
                <input
                  className="field"
                  value={form.outputFile}
                  onChange={(e) => set({ outputFile: e.target.value })}
                  placeholder="{{outFile}}"
                />
              </label>
            )}
          </div>
          <div className="agent-editor__field">
            Environment
            {form.env.map((r, i) => (
              <div key={i} className="agent-editor__env-row">
                <input
                  className="field"
                  aria-label="Env name"
                  value={r.key}
                  onChange={(e) => setEnv(i, { key: e.target.value })}
                  placeholder="NAME"
                />
                <input
                  className="field"
                  aria-label="Env value"
                  value={r.value}
                  onChange={(e) => setEnv(i, { value: e.target.value })}
                  placeholder="value"
                />
                <button
                  className="btn btn--ghost"
                  onClick={() => set({ env: form.env.filter((_, j) => j !== i) })}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="btn btn--ghost"
              onClick={() => set({ env: [...form.env, { key: '', value: '' }] })}
            >
              + Add variable
            </button>
          </div>
          <div className="agent-editor__form-actions">
            <button className="btn btn--ghost" onClick={() => setForm(null)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn--primary" onClick={() => void onSave()} disabled={busy}>
              {busy ? 'Saving…' : 'Save agent'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

export default AgentEditor
