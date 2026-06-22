// Pure helpers for the live pipeline-engine adapter (ROADMAP M9a). Electron-free +
// unit-tested: the decisions the adapter makes (parse+validate a persisted config row,
// resolve a PR number / issue title, assemble the guardrail snapshot) live here so the
// electron-bound glue in `pipelineEngine.ts` stays a thin binding to the runner/store/
// GitHub writers.

import type { Pipeline } from '../shared/types'
import { isPipelineDraft } from './pipelineModel'
import type { GuardrailState } from './pipelinePlan'

// Prototype-pollution guard for the config trust boundary: JSON allows an own key named
// `__proto__`/`constructor`/`prototype` to ride a parsed object, which a later merge/assign
// downstream could turn into pollution. The reviver drops those keys recursively (no
// PipelineDraft field is named any of them), so a forged blob can never carry one through.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function safeJsonParse(text: string): unknown {
  return JSON.parse(text, (key, value) => (DANGEROUS_KEYS.has(key) ? undefined : value))
}

/**
 * Parses a persisted pipeline row into a validated `Pipeline`, or null if the JSON is
 * malformed or fails `isPipelineDraft`. The engine MUST run every loaded config through
 * this before acting on it — a corrupt/forged `config` blob can never reach the engine.
 * The row id is authoritative (overrides any `id` the config carries), and dangerous
 * prototype keys are stripped during parse.
 */
export function parsePipelineRow(row: { id: number; config: string }): Pipeline | null {
  let parsed: unknown
  try {
    parsed = safeJsonParse(row.config)
  } catch {
    return null
  }
  if (!isPipelineDraft(parsed)) return null
  return { ...parsed, id: row.id }
}

/** Extracts a positive PR number from a watch ref (`pr:42` → 42); null otherwise. */
export function prNumberFromRef(ref: string): number | null {
  const m = /^pr:(\d+)$/.exec(ref)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Splits an action body into a GitHub issue `title` + `body`. The title is the first line
 * (truncated to 120 chars), the body is the full text; an empty first line falls back to a
 * generic title so an issue is never created title-less.
 */
export function splitIssueBody(body: string): { title: string; body: string } {
  const firstLine = body.split('\n', 1)[0] ?? ''
  const trimmed = firstLine.trim()
  const title = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed
  return { title: title || 'Aerie pipeline review', body }
}

/**
 * Assembles the `GuardrailState` `checkGuardrails` needs from store-queried values: the
 * current active-run count, this pipeline's recent run-start timestamps, and the most
 * recent run-start for the whole repo. ISO strings are parsed to epoch ms; unparseable
 * timestamps are dropped (never NaN into the guardrail math).
 */
export function assembleGuardrailState(
  nowMs: number,
  activeRunCount: number,
  recentStartsIso: string[],
  lastRepoStartIso: string | null
): GuardrailState {
  const lastRepoMs = lastRepoStartIso !== null ? Date.parse(lastRepoStartIso) : NaN
  return {
    nowMs,
    activeRunCount,
    pipelineRunStartsLastHourMs: recentStartsIso
      .map((iso) => Date.parse(iso))
      .filter((n) => Number.isFinite(n)),
    lastRepoRunStartedAtMs: Number.isFinite(lastRepoMs) ? lastRepoMs : null
  }
}
