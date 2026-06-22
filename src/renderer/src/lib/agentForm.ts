// Pure form ↔ Agent mapping for the in-app agent editor (ROADMAP M12). Keeps the
// string-field serialization (args one-per-line, env key/value rows) and client-side
// validation out of the component so they're unit-testable. The MAIN process re-validates
// every save with `isAgent` + the id rules — this is for instant feedback only.

import type { Agent } from '@shared/types'

/** Mirrors main's USER_AGENT_ID_RE (lowercase-only). Main is the source of truth. */
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface EnvRow {
  key: string
  value: string
}

export interface AgentFormState {
  id: string
  label: string
  command: string
  argsText: string // one arg per line
  promptDelivery: 'arg' | 'stdin' | 'file'
  promptPlaceholder: string
  outputCapture: 'stdout' | 'file'
  outputFile: string // '' → null
  timeoutSec: string // numeric string
  kind: 'agent' | 'tool'
  env: EnvRow[]
}

export function blankForm(): AgentFormState {
  return {
    id: '',
    label: '',
    command: '',
    argsText: '{{prompt}}',
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: '',
    timeoutSec: '900',
    kind: 'agent',
    env: []
  }
}

/** One non-empty arg per line. (Empty-string args aren't representable — no shipped
 *  agent uses one; a deliberately-empty arg would need a different editor affordance.) */
export function parseArgs(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0)
}

export function serializeArgs(args: string[]): string {
  return args.join('\n')
}

/** Env rows → record, dropping rows with an empty key (last write wins on a dup key). */
export function envRowsToRecord(rows: EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const k = r.key.trim()
    if (k) out[k] = r.value
  }
  return out
}

export function recordToEnvRows(env: Record<string, string>): EnvRow[] {
  return Object.entries(env).map(([key, value]) => ({ key, value }))
}

/** Populate the form from an existing agent (for edit/clone). Non-form fields are
 *  preserved by the caller via the original agent passed to `formToAgent`. */
export function agentToForm(agent: Agent): AgentFormState {
  return {
    id: agent.id,
    label: agent.label,
    command: agent.command,
    argsText: serializeArgs(agent.args),
    promptDelivery: agent.promptDelivery,
    promptPlaceholder: agent.promptPlaceholder,
    outputCapture: agent.outputCapture,
    outputFile: agent.outputFile ?? '',
    timeoutSec: String(agent.timeoutSec),
    kind: agent.kind ?? 'agent',
    env: recordToEnvRows(agent.env ?? {})
  }
}

export type FormToAgentResult = { ok: true; agent: Agent } | { ok: false; error: string }

/**
 * Build (and lightly validate) an Agent from the form. `base` (the original agent when
 * editing) preserves non-form fields (models/reasoning/detect/modelDiscovery/...). Returns
 * a typed error for the first problem; main re-validates authoritatively on save.
 */
export function formToAgent(form: AgentFormState, base?: Agent): FormToAgentResult {
  const id = form.id.trim()
  if (!AGENT_ID_RE.test(id)) {
    return {
      ok: false,
      error: 'Id must be lowercase, start alphanumeric, use only a-z 0-9 . _ - (≤64).'
    }
  }
  if (!form.label.trim()) return { ok: false, error: 'Label is required.' }
  if (!form.command.trim()) return { ok: false, error: 'Command is required.' }
  const timeoutSec = Number(form.timeoutSec)
  if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) {
    return { ok: false, error: 'Timeout must be a positive whole number of seconds.' }
  }
  const args = parseArgs(form.argsText)
  if (args.length === 0) return { ok: false, error: 'At least one argument is required.' }
  const outputFile = form.outputCapture === 'file' ? form.outputFile.trim() : ''
  if (form.outputCapture === 'file' && !outputFile) {
    return { ok: false, error: 'An output file is required when capturing from a file.' }
  }
  const agent: Agent = {
    // Preserve non-form fields (models/reasoning/detect/modelDiscovery/successExitCodes).
    ...base,
    id,
    label: form.label.trim(),
    command: form.command.trim(),
    args,
    promptDelivery: form.promptDelivery,
    promptPlaceholder: form.promptPlaceholder.trim() || '{{prompt}}',
    outputCapture: form.outputCapture,
    outputFile: outputFile || null,
    timeoutSec,
    kind: form.kind,
    env: envRowsToRecord(form.env)
  }
  return { ok: true, agent }
}
