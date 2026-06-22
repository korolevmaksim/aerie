import { useEffect, useRef, useState } from 'react'
import type {
  AgentInfo,
  Pipeline,
  PipelineActionKind,
  PipelineTrigger,
  PostTarget
} from '@shared/types'
import { useFocusTrap } from '../lib/useFocusTrap'
import {
  blankForm,
  blankStep,
  draftToForm,
  formToDraft,
  type PipelineFormState,
  type PipelineStepForm
} from '../lib/pipelineForm'

/** A repo the user has added, for the picker. */
export interface RepoOption {
  id: number
  fullName: string
}

const TRIGGERS: PipelineTrigger[] = ['commit', 'pr', 'schedule', 'manual']
const ACTIONS: PipelineActionKind[] = ['notify', 'stage', 'post']
const TARGETS: PostTarget[] = ['commit', 'pr', 'issue']

/** Next unique `s<n>` step id given the current steps. */
function nextStepId(steps: PipelineStepForm[]): string {
  const ids = new Set(steps.map((s) => s.id))
  let n = steps.length + 1
  while (ids.has(`s${n}`)) n++
  return `s${n}`
}

/**
 * Create/edit a pipeline (ROADMAP M13). A focus-trapped modal over the pure
 * `pipelineForm` mapping. It holds NO privileged logic — Save calls the gated
 * `aerie.pipelines.save`, and the engine's `assertMayPost` (not this dialog) is the real
 * auto-post guard; the danger confirm here is a deliberate-friction UX affordance.
 */
function PipelineEditor({
  editing,
  repos,
  agents,
  onClose,
  onSaved
}: {
  editing: Pipeline | null
  repos: RepoOption[]
  agents: AgentInfo[]
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const [form, setForm] = useState<PipelineFormState>(() =>
    editing ? draftToForm(editing) : blankForm()
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  useFocusTrap(modalRef)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const set = (patch: Partial<PipelineFormState>): void => setForm((f) => ({ ...f, ...patch }))
  const setStep = (i: number, patch: Partial<PipelineStepForm>): void =>
    setForm((f) => ({ ...f, steps: f.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }))
  const addStep = (): void =>
    setForm((f) => ({ ...f, steps: [...f.steps, blankStep(nextStepId(f.steps))] }))
  const removeStep = (i: number): void =>
    setForm((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))

  const onToggleAutoPost = (checked: boolean): void => {
    if (checked) {
      const ok = window.confirm(
        'Auto-post will publish AI reviews to GitHub automatically, without asking each time. ' +
          'Only enable this for a pipeline you trust. Continue?'
      )
      if (!ok) return
    }
    set({ autoPost: checked })
  }

  const onSave = async (): Promise<void> => {
    const built = formToDraft(form, editing ?? undefined)
    if (!built.ok) {
      setError(built.error)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await window.aerie.pipelines.save({ id: editing?.id ?? null, draft: built.draft })
      if (res.ok) {
        onSaved()
        onClose()
      } else {
        setError(res.error)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div
        className="modal pipeline-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pe-title"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal__title" id="pe-title">
          {editing ? 'Edit pipeline' : 'New pipeline'}
        </h3>
        {error && <p className="alert">{error}</p>}

        <div className="pipeline-editor__body">
          <label className="pe-field">
            <span>Name</span>
            <input
              className="field"
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="e.g. Security review on main"
              autoFocus
            />
          </label>

          <label className="pe-field">
            <span>Repository</span>
            <select
              className="field"
              value={form.repoId}
              onChange={(e) => set({ repoId: e.target.value })}
            >
              <option value="">Select a repository…</option>
              {repos.map((r) => (
                <option key={r.id} value={String(r.id)}>
                  {r.fullName}
                </option>
              ))}
            </select>
            {repos.length === 0 && (
              <span className="hint">Add a GitHub account and browse a repo first.</span>
            )}
          </label>

          <label className="pe-field">
            <span>Trigger</span>
            <select
              className="field"
              value={form.trigger}
              onChange={(e) => set({ trigger: e.target.value as PipelineTrigger })}
            >
              {TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <span className="hint">
              Commit pipelines run automatically on a new default-branch commit; all triggers can be
              run manually.
            </span>
          </label>

          <fieldset className="pe-fieldset">
            <legend>Steps (agents)</legend>
            {form.steps.map((s, i) => (
              <div className="pe-step" key={s.id}>
                <span className="pe-step__id">{s.id}</span>
                <select
                  className="field"
                  aria-label={`Step ${s.id} agent`}
                  value={s.ref}
                  onChange={(e) => setStep(i, { ref: e.target.value })}
                >
                  <option value="">Select an agent…</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                      {a.available ? '' : ' (not installed)'}
                    </option>
                  ))}
                </select>
                <input
                  className="field"
                  aria-label={`Step ${s.id} model (optional)`}
                  placeholder="model (optional)"
                  value={s.model}
                  onChange={(e) => setStep(i, { model: e.target.value })}
                />
                <input
                  className="field"
                  aria-label={`Step ${s.id} depends on (optional)`}
                  placeholder="depends on, e.g. s1"
                  value={s.dependsOn}
                  onChange={(e) => setStep(i, { dependsOn: e.target.value })}
                />
                <button
                  className="btn btn--ghost"
                  onClick={() => removeStep(i)}
                  disabled={form.steps.length <= 1}
                  aria-label={`Remove step ${s.id}`}
                >
                  Remove
                </button>
              </div>
            ))}
            <button className="btn btn--ghost" onClick={addStep}>
              Add step
            </button>
          </fieldset>

          <fieldset className="pe-fieldset">
            <legend>Scope (optional filters)</legend>
            <label className="pe-field">
              <span>Branches</span>
              <input
                className="field"
                placeholder="comma-separated, e.g. main, release"
                value={form.branchesText}
                onChange={(e) => set({ branchesText: e.target.value })}
              />
            </label>
            <label className="pe-field">
              <span>Changed paths</span>
              <input
                className="field"
                placeholder="comma-separated prefixes, e.g. src/"
                value={form.pathsText}
                onChange={(e) => set({ pathsText: e.target.value })}
              />
            </label>
            <label className="pe-field">
              <span>PR labels</span>
              <input
                className="field"
                placeholder="comma-separated"
                value={form.labelsText}
                onChange={(e) => set({ labelsText: e.target.value })}
              />
            </label>
            <label className="pe-field">
              <span>Authors</span>
              <input
                className="field"
                placeholder="comma-separated logins"
                value={form.authorsText}
                onChange={(e) => set({ authorsText: e.target.value })}
              />
            </label>
            <label className="pe-check">
              <input
                type="checkbox"
                checked={form.includeDrafts}
                onChange={(e) => set({ includeDrafts: e.target.checked })}
              />
              Include draft PRs
            </label>
            <label className="pe-field">
              <span>Max commits per push (0 = no cap)</span>
              <input
                className="field"
                type="number"
                min={0}
                value={form.maxCommitsText}
                onChange={(e) => set({ maxCommitsText: e.target.value })}
              />
            </label>
          </fieldset>

          <fieldset className="pe-fieldset">
            <legend>Action</legend>
            <div className="pe-radio" role="radiogroup" aria-label="Action">
              {ACTIONS.map((a) => (
                <label key={a} className="pe-radio__opt">
                  <input
                    type="radio"
                    name="pe-action"
                    checked={form.actionKind === a}
                    onChange={() => set({ actionKind: a })}
                  />
                  {a === 'notify' && 'Notify'}
                  {a === 'stage' && 'Stage for review'}
                  {a === 'post' && 'Post to GitHub'}
                </label>
              ))}
            </div>
            {form.actionKind === 'post' && (
              <div className="pe-post-danger">
                <label className="pe-field">
                  <span>Post to</span>
                  <select
                    className="field"
                    value={form.postTarget}
                    onChange={(e) => set({ postTarget: e.target.value as PostTarget })}
                  >
                    {TARGETS.map((t) => (
                      <option key={t} value={t}>
                        {t === 'commit' && 'Commit comment'}
                        {t === 'pr' && 'PR comment'}
                        {t === 'issue' && 'New issue'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="pe-check pe-check--danger">
                  <input
                    type="checkbox"
                    checked={form.autoPost}
                    onChange={(e) => onToggleAutoPost(e.target.checked)}
                  />
                  <strong>Auto-post without asking</strong> — publish the review to GitHub
                  automatically on every run. Off by default.
                </label>
                {!form.autoPost && (
                  <p className="hint">
                    With auto-post off, a post action stages the review for you to publish with the
                    usual confirm.
                  </p>
                )}
              </div>
            )}
          </fieldset>

          <details className="pe-fieldset">
            <summary>Guardrails (optional)</summary>
            <label className="pe-field">
              <span>Max concurrent runs</span>
              <input
                className="field"
                type="number"
                min={0}
                value={form.maxConcurrentRunsText}
                onChange={(e) => set({ maxConcurrentRunsText: e.target.value })}
              />
            </label>
            <label className="pe-field">
              <span>Per-repo cooldown (seconds)</span>
              <input
                className="field"
                type="number"
                min={0}
                value={form.perRepoCooldownSecondsText}
                onChange={(e) => set({ perRepoCooldownSecondsText: e.target.value })}
              />
            </label>
            <label className="pe-field">
              <span>Max runs per hour</span>
              <input
                className="field"
                type="number"
                min={0}
                value={form.maxRunsPerHourText}
                onChange={(e) => set({ maxRunsPerHourText: e.target.value })}
              />
            </label>
          </details>
        </div>

        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={onSave} disabled={busy}>
            {busy ? 'Saving…' : 'Save pipeline'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default PipelineEditor
