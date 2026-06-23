import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import type { Agent, AgentInfo } from '@shared/types'
import {
  agentToForm,
  blankForm,
  formToAgent,
  type AgentFormState,
  type EnvRow
} from '../lib/agentForm'
import { useConfirm } from '../lib/useConfirm'
import ChipListEditor from './ChipListEditor'

/** Imperative handle so the Tools view can open the editor prefilled from a detected candidate. */
export interface AgentEditorHandle {
  openFromCandidate: (candidate: { command: string; label: string }) => void
}

/** Tokens substituted into args/env at run time, with a one-line description for the legend. */
const TOKENS: { token: string; desc: string }[] = [
  { token: '{{prompt}}', desc: 'the review instruction + diff' },
  { token: '{{model}}', desc: 'the selected model id' },
  { token: '{{reasoning}}', desc: 'the selected thinking level (empty if none)' },
  { token: '{{repoPath}}', desc: 'the checked-out repo path' },
  { token: '{{diffFile}}', desc: 'a temp file holding the diff' },
  { token: '{{outFile}}', desc: 'where file-captured output is written' }
]

/**
 * In-app agent registry editor (ROADMAP M12). Add / edit / clone / delete USER agents.
 * Security is enforced in main: a save can't shadow a built-in and anything saved still
 * needs exec-consent before it can run (surfaced here as "needs approval").
 */
const AgentEditor = forwardRef<
  AgentEditorHandle,
  { agents: AgentInfo[]; onChange: (agents: AgentInfo[]) => void }
>(function AgentEditor({ agents, onChange }, ref): React.JSX.Element {
  const [form, setForm] = useState<AgentFormState | null>(null)
  const [base, setBase] = useState<Agent | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cloneFrom, setCloneFrom] = useState('')
  // The agent just saved that still needs approval — drives the one-time hint near the list.
  const [savedNeedsApproval, setSavedNeedsApproval] = useState<{
    id: string
    label: string
  } | null>(null)
  // Whether the Thinking add-row is revealed when a CLI starts with no reasoning levels.
  const [showReasoningAdd, setShowReasoningAdd] = useState(false)
  const idInputRef = useRef<HTMLInputElement>(null)
  const confirm = useConfirm()

  const userAgents = agents.filter((a) => a.editable)

  // Open a NEW-agent form prefilled from a candidate's "Add as agent" (M2). Imperative (not a
  // prop/effect) so it can confirm before discarding an in-progress edit and move focus into the
  // form. The saved agent still needs exec-consent before it can run — prefilling is pure
  // convenience, not a trust grant.
  useImperativeHandle(
    ref,
    () => ({
      openFromCandidate: async (candidate): Promise<void> => {
        if (
          form !== null &&
          !(await confirm({
            title: 'Discard changes?',
            message: 'Discard the agent form you have open and start from this CLI instead?',
            confirmLabel: 'Discard',
            danger: true
          }))
        ) {
          return
        }
        setForm({
          ...blankForm(),
          id: candidate.command,
          label: candidate.label,
          command: candidate.command
        })
        setBase(null)
        setEditingId(null)
        setError(null)
        setShowReasoningAdd(false)
        // Focus the first field once the form has mounted (focus also scrolls it into view).
        requestAnimationFrame(() => idInputRef.current?.focus())
      }
    }),
    [form, confirm]
  )

  const openNew = (): void => {
    setForm(blankForm())
    setBase(null)
    setEditingId(null)
    setError(null)
    setShowReasoningAdd(false)
    setSavedNeedsApproval(null)
  }

  const openFrom = async (id: string, asClone: boolean): Promise<void> => {
    setError(null)
    setSavedNeedsApproval(null)
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
    setShowReasoningAdd(f.reasoningLevels.length > 0)
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
        // Surface the needs-approval hint for the agent we just saved (mirrors the per-row ⚠).
        const saved = res.value.find((a) => a.id === built.agent.id)
        setSavedNeedsApproval(
          saved && saved.needsConsent ? { id: saved.id, label: saved.label } : null
        )
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
    const ok = await confirm({
      title: 'Delete agent',
      message: `Delete the agent "${id}"? This removes it from agents.json.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    const res = await window.aerie.runner.deleteAgent(id)
    if (res.ok) onChange(res.value)
    else setError(res.error)
  }

  const onApprove = async (id: string): Promise<void> => {
    const res = await window.aerie.runner.approveAgent(id)
    if (res.ok) {
      onChange(res.value)
      if (savedNeedsApproval?.id === id) setSavedNeedsApproval(null)
    } else setError(res.error)
  }

  const set = (patch: Partial<AgentFormState>): void => setForm((f) => (f ? { ...f, ...patch } : f))
  const setEnv = (i: number, patch: Partial<EnvRow>): void =>
    setForm((f) => (f ? { ...f, env: f.env.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : f))

  // Availability of the form's command: matched against any known agent sharing that command
  // (autodiscovery already probed PATH for those). Undefined when no known agent uses it yet.
  const commandAvailability = (cmd: string): boolean | undefined => {
    const c = cmd.trim()
    if (!c) return undefined
    const known = agents.find((a) => a.id === editingId)
    if (known && form && form.command.trim() === c) return known.available
    return undefined
  }

  // Quick-fill low/medium/high: append any missing levels without clobbering an existing default;
  // when starting empty, medium becomes the default.
  const quickFillReasoning = (): void => {
    if (!form) return
    const wanted = ['low', 'medium', 'high']
    const merged = [
      ...form.reasoningLevels,
      ...wanted.filter((l) => !form.reasoningLevels.includes(l))
    ]
    set({ reasoningLevels: merged, reasoning: form.reasoning || 'medium' })
    setShowReasoningAdd(true)
  }

  return (
    <section className="agent-editor">
      <h3 className="subhead">Your agents ({userAgents.length})</h3>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {form === null ? (
        <>
          {savedNeedsApproval && (
            <p className="hint">
              Saved. <strong>{savedNeedsApproval.label}</strong> needs approval before it can run —{' '}
              <button
                className="btn btn--ghost"
                onClick={() => void onApprove(savedNeedsApproval.id)}
              >
                Approve it here
              </button>
              .
            </p>
          )}
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
            to run it.
          </p>

          {/* --- Identity ------------------------------------------------------ */}
          <fieldset className="agent-editor__group">
            <legend>Identity</legend>
            <label className="agent-editor__field">
              Id
              {editingId ? (
                // The id is immutable once saved (it keys the registry); show it read-only.
                <input className="field" value={form.id} readOnly aria-readonly="true" />
              ) : (
                <input
                  ref={idInputRef}
                  className="field"
                  value={form.id}
                  onChange={(e) => set({ id: e.target.value })}
                  placeholder="my-agent"
                />
              )}
            </label>
            <label className="agent-editor__field">
              Label
              <input
                className="field"
                value={form.label}
                onChange={(e) => set({ label: e.target.value })}
              />
            </label>
          </fieldset>

          {/* --- Basics -------------------------------------------------------- */}
          <fieldset className="agent-editor__group">
            <legend>Basics</legend>
            <label className="agent-editor__field">
              Command (binary on PATH)
              <input
                className="field"
                value={form.command}
                onChange={(e) => set({ command: e.target.value })}
                placeholder="my-cli"
              />
            </label>
            {(() => {
              const avail = commandAvailability(form.command)
              if (avail === undefined) return null
              return avail ? (
                <p className="hint agent-editor__source">
                  <code>{form.command.trim()}</code> is installed on this machine.
                </p>
              ) : (
                <p className="hint">
                  <code>{form.command.trim()}</code> isn’t on your PATH yet — install it before this
                  agent can run.
                </p>
              )
            })()}

            {/* Model sub-editor */}
            <fieldset className="agent-editor__group agent-editor__subeditor">
              <legend>Model</legend>
              {form.models.length === 0 ? (
                <p className="empty">
                  No models set. Add an id — they become the dropdown when you run this agent.
                </p>
              ) : null}
              <ChipListEditor
                groupLabel="Models"
                itemNoun="model"
                items={form.models}
                value={form.model}
                addPlaceholder="model id"
                addLabel="New model id"
                onChange={({ items, value }) => set({ models: items, model: value })}
              />
              <p className="agent-editor__count" aria-live="polite">
                {form.models.length === 0
                  ? ''
                  : `${form.models.length} model${form.models.length === 1 ? '' : 's'}`}
              </p>
              <p className="hint">
                The default model is substituted into the <code>{'{{model}}'}</code> token in your
                args.
              </p>
              {form.models.length > 0 && !form.argsText.includes('{{model}}') && (
                <p className="agent-editor__warn" role="status">
                  Your args don’t use <code>{'{{model}}'}</code> — the selected model won’t reach
                  the CLI.
                </p>
              )}
            </fieldset>

            {/* Thinking (reasoning) sub-editor */}
            <fieldset className="agent-editor__group agent-editor__subeditor">
              <legend>Thinking</legend>
              {form.reasoningLevels.length === 0 && !showReasoningAdd ? (
                <>
                  <p className="empty">This CLI has no thinking/reasoning control.</p>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setShowReasoningAdd(true)}
                  >
                    Add reasoning levels
                  </button>
                </>
              ) : (
                <>
                  <div className="agent-editor__add-row">
                    <button type="button" className="btn btn--ghost" onClick={quickFillReasoning}>
                      Use low / medium / high
                    </button>
                  </div>
                  <ChipListEditor
                    groupLabel="Reasoning levels"
                    itemNoun="reasoning level"
                    items={form.reasoningLevels}
                    value={form.reasoning}
                    addPlaceholder="reasoning level"
                    addLabel="New reasoning level"
                    onChange={({ items, value }) =>
                      set({ reasoningLevels: items, reasoning: value })
                    }
                  />
                  <p className="agent-editor__count" aria-live="polite">
                    {form.reasoningLevels.length === 0
                      ? ''
                      : `${form.reasoningLevels.length} level${
                          form.reasoningLevels.length === 1 ? '' : 's'
                        }`}
                  </p>
                </>
              )}
              <p className="hint">
                Leave empty if the CLI has no reasoning flag — <code>{'{{reasoning}}'}</code> then
                resolves to nothing.
              </p>
              {form.reasoningLevels.length > 0 && !form.argsText.includes('{{reasoning}}') && (
                <p className="agent-editor__warn" role="status">
                  Your args don’t use <code>{'{{reasoning}}'}</code> — the selected level won’t
                  reach the CLI.
                </p>
              )}
            </fieldset>
          </fieldset>

          {/* --- Advanced (collapsed) ----------------------------------------- */}
          <details className="agent-editor__group agent-editor__advanced">
            <summary>Advanced</summary>

            <div className="agent-editor__tokens" aria-label="Available tokens">
              {TOKENS.map((t) => (
                <span key={t.token} className="agent-editor__token">
                  <code>{t.token}</code> <span className="muted">{t.desc}</span>
                </span>
              ))}
            </div>
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
          </details>

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
})

export default AgentEditor
