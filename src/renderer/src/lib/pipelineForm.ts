// Pure form ↔ PipelineDraft mapping for the Automate pipeline editor (ROADMAP M13). Keeps
// the string-field serialization (comma-separated lists, numeric strings) and client-side
// validation out of the component so they're unit-testable. The MAIN process re-validates
// every save with `isPipelineDraft`, and the engine checks the step graph (`planWaves`) at
// run time — this is for instant feedback only.

import type {
  PipelineAction,
  PipelineActionKind,
  PipelineDraft,
  PipelineGuardrails,
  PipelineScope,
  PipelineStep,
  PipelineTrigger,
  PostTarget
} from '@shared/types'

export interface PipelineStepForm {
  /** Stable id within the pipeline (referenced by other steps' `dependsOn`). */
  id: string
  /**
   * Agent id to run. Only AGENT steps are supported in the UI for now — `formToDraft` always
   * emits `kind:'agent'`. The editor must therefore refuse to open a tool-bearing draft for
   * edit (else a re-save would silently rewrite tool steps to agent steps); enabled pipelines
   * never have tool steps today (`loadEnabledPipelines` skips them).
   */
  ref: string
  /** Optional model override. */
  model: string
  /** Comma-separated step ids this one waits for. */
  dependsOn: string
}

export interface PipelineFormState {
  name: string
  /** Numeric string from the repo picker ('' = none selected). */
  repoId: string
  trigger: PipelineTrigger
  steps: PipelineStepForm[]
  // scope (comma-separated text)
  branchesText: string
  pathsText: string
  labelsText: string
  authorsText: string
  /** PR draft handling — true (default) includes drafts; false excludes them. */
  includeDrafts: boolean
  /** Numeric string; '' = no cap. */
  maxCommitsText: string
  // action
  actionKind: PipelineActionKind
  /** Only meaningful (and shown) when actionKind === 'post'. */
  autoPost: boolean
  postTarget: PostTarget
  // guardrails (numeric strings; '' = unset)
  maxConcurrentRunsText: string
  perRepoCooldownSecondsText: string
  maxRunsPerHourText: string
}

export function blankStep(id: string): PipelineStepForm {
  return { id, ref: '', model: '', dependsOn: '' }
}

export function blankForm(): PipelineFormState {
  return {
    name: '',
    repoId: '',
    trigger: 'commit',
    steps: [blankStep('s1')],
    branchesText: '',
    pathsText: '',
    labelsText: '',
    authorsText: '',
    includeDrafts: true,
    maxCommitsText: '',
    actionKind: 'notify',
    autoPost: false,
    postTarget: 'commit',
    maxConcurrentRunsText: '',
    perRepoCooldownSecondsText: '',
    maxRunsPerHourText: ''
  }
}

/** Comma-separated → trimmed non-empty items. */
export function splitCsv(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function joinCsv(items: string[] | undefined): string {
  return (items ?? []).join(', ')
}

/** Populate the form from an existing draft (for edit). */
export function draftToForm(draft: PipelineDraft): PipelineFormState {
  return {
    name: draft.name,
    repoId: String(draft.repoId),
    trigger: draft.trigger,
    steps:
      draft.steps.length > 0
        ? draft.steps.map((s) => ({
            id: s.id,
            ref: s.ref,
            model: s.model ?? '',
            dependsOn: joinCsv(s.dependsOn)
          }))
        : [blankStep('s1')],
    branchesText: joinCsv(draft.scope.branches),
    pathsText: joinCsv(draft.scope.paths),
    labelsText: joinCsv(draft.scope.labels),
    authorsText: joinCsv(draft.scope.authors),
    includeDrafts: draft.scope.includeDrafts !== false,
    maxCommitsText: draft.scope.maxCommits ? String(draft.scope.maxCommits) : '',
    actionKind: draft.action.kind,
    autoPost: draft.action.autoPost,
    postTarget: draft.action.target ?? 'commit',
    maxConcurrentRunsText: draft.guardrails.maxConcurrentRuns
      ? String(draft.guardrails.maxConcurrentRuns)
      : '',
    perRepoCooldownSecondsText: draft.guardrails.perRepoCooldownSeconds
      ? String(draft.guardrails.perRepoCooldownSeconds)
      : '',
    maxRunsPerHourText: draft.guardrails.maxRunsPerHour
      ? String(draft.guardrails.maxRunsPerHour)
      : ''
  }
}

export type FormToDraftResult = { ok: true; draft: PipelineDraft } | { ok: false; error: string }

const err = (error: string): FormToDraftResult => ({ ok: false, error })

/** Parses an optional non-negative-integer field. '' → undefined; invalid → null (caller errors). */
function parseOptionalCount(text: string): number | null | undefined {
  const t = text.trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/**
 * Build (and lightly validate) a `PipelineDraft` from the form. `base` (the original draft
 * when editing) preserves non-form fields — `enabled` (toggled from the list) and `schedule`.
 * A new pipeline defaults to disabled (the user enables it explicitly after reviewing).
 * Returns the first problem; main re-validates authoritatively on save.
 */
export function formToDraft(form: PipelineFormState, base?: PipelineDraft): FormToDraftResult {
  const name = form.name.trim()
  if (!name) return err('Name is required.')

  const repoId = Number(form.repoId)
  if (!Number.isInteger(repoId) || repoId <= 0) return err('Select a repository.')

  if (form.steps.length === 0) return err('Add at least one step.')
  const stepIds = new Set<string>()
  const steps: PipelineStep[] = []
  for (const s of form.steps) {
    const id = s.id.trim()
    const ref = s.ref.trim()
    if (!id) return err('Each step needs an id.')
    if (!ref) return err(`Step "${id}" needs an agent.`)
    if (stepIds.has(id)) return err(`Duplicate step id "${id}".`)
    stepIds.add(id)
    const dependsOn = splitCsv(s.dependsOn)
    steps.push({
      id,
      kind: 'agent',
      ref,
      ...(s.model.trim() ? { model: s.model.trim() } : {}),
      ...(dependsOn.length ? { dependsOn } : {})
    })
  }
  for (const s of steps) {
    for (const dep of s.dependsOn ?? []) {
      if (dep === s.id) return err(`Step "${s.id}" can't depend on itself.`)
      if (!stepIds.has(dep)) return err(`Step "${s.id}" depends on unknown step "${dep}".`)
    }
  }

  const maxCommits = parseOptionalCount(form.maxCommitsText)
  if (maxCommits === null) return err('Max commits must be a non-negative whole number.')
  const scope: PipelineScope = {}
  const branches = splitCsv(form.branchesText)
  const paths = splitCsv(form.pathsText)
  const labels = splitCsv(form.labelsText)
  const authors = splitCsv(form.authorsText)
  if (branches.length) scope.branches = branches
  if (paths.length) scope.paths = paths
  if (labels.length) scope.labels = labels
  if (authors.length) scope.authors = authors
  // Persist `includeDrafts` ONLY when excluding (false). Absent === true === "include"
  // (`matchesScope`), so omitting it when including keeps the stored scope minimal — a draft
  // with an explicit `includeDrafts:true` round-trips to an (equivalent) scope without it.
  if (!form.includeDrafts) scope.includeDrafts = false
  if (maxCommits && maxCommits > 0) scope.maxCommits = maxCommits

  const action: PipelineAction = {
    kind: form.actionKind,
    // autoPost only applies to a 'post' action; never persist a true flag on notify/stage.
    autoPost: form.actionKind === 'post' ? form.autoPost : false,
    ...(form.actionKind === 'post' ? { target: form.postTarget } : {})
  }

  const guardrails: PipelineGuardrails = {}
  const gr: Array<[keyof PipelineGuardrails, string, string]> = [
    ['maxConcurrentRuns', form.maxConcurrentRunsText, 'Max concurrent runs'],
    ['perRepoCooldownSeconds', form.perRepoCooldownSecondsText, 'Per-repo cooldown'],
    ['maxRunsPerHour', form.maxRunsPerHourText, 'Max runs per hour']
  ]
  for (const [field, text, label] of gr) {
    const value = parseOptionalCount(text)
    if (value === null) return err(`${label} must be a non-negative whole number.`)
    if (value && value > 0) guardrails[field] = value
  }

  const draft: PipelineDraft = {
    name,
    repoId,
    trigger: form.trigger,
    ...(base?.schedule ? { schedule: base.schedule } : {}),
    enabled: base?.enabled ?? false,
    scope,
    steps,
    action,
    guardrails
  }
  return { ok: true, draft }
}
