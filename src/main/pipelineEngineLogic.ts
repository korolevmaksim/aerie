// Pure helpers for the live pipeline-engine adapter (ROADMAP M9a). Electron-free +
// unit-tested: the decisions the adapter makes (parse+validate a persisted config row,
// resolve a PR number / issue title, assemble the guardrail snapshot) live here so the
// electron-bound glue in `pipelineEngine.ts` stays a thin binding to the runner/store/
// GitHub writers.

import type { Pipeline, PipelineAction, PostTarget } from '../shared/types'
import { assertMayPost, isPipelineDraft } from './pipelineModel'
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
 * Deep-strips dangerous prototype keys (`__proto__`/`constructor`/`prototype`) from a plain
 * data value by round-tripping it through `safeJsonParse`. Used on the SAVE path so a forged
 * key never even reaches the DB — defense-in-depth so the strip isn't only on read.
 */
export function stripDangerousKeys<T>(value: T): T {
  return safeJsonParse(JSON.stringify(value)) as T
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

/** The three GitHub write APIs the engine's `post` port can reach (injected, so testable). */
export interface GithubWriters {
  createCommitComment(
    accountId: number,
    repoFullName: string,
    sha: string,
    body: string
  ): Promise<string>
  createPrComment(
    accountId: number,
    repoFullName: string,
    prNumber: number,
    body: string
  ): Promise<string>
  createIssue(accountId: number, repoFullName: string, title: string, body: string): Promise<string>
}

/** The slice of `DeltaContext` a write needs (structural, to avoid importing the engine). */
export interface WriteContext {
  accountId: number
  ref: string
  headSha: string
}

/**
 * The SINGLE engine→GitHub write dispatch. Re-asserts `assertMayPost(action)` FIRST
 * (defense-in-depth — throws for any non-enabled-post action, so even a mis-routed caller
 * cannot write), resolves the repo's full name, then routes to the writer for the target:
 * commit-comment / PR-comment (PR number parsed from the ref) / new issue (title split from
 * the body). Returns the created object's URL. Pure given injected `writers` + `repoFullName`.
 */
export async function dispatchGithubWrite(
  writers: GithubWriters,
  repoFullName: string | null,
  action: PipelineAction,
  target: PostTarget,
  ctx: WriteContext,
  body: string
): Promise<string> {
  assertMayPost(action)
  if (!repoFullName) throw new Error('pipeline auto-post: repository not found')
  if (target === 'commit') {
    return writers.createCommitComment(ctx.accountId, repoFullName, ctx.headSha, body)
  }
  if (target === 'pr') {
    const prNumber = prNumberFromRef(ctx.ref)
    if (prNumber === null) {
      throw new Error(`pipeline auto-post: cannot resolve a PR number from ref "${ctx.ref}"`)
    }
    return writers.createPrComment(ctx.accountId, repoFullName, prNumber, body)
  }
  const { title, body: issueBody } = splitIssueBody(body)
  return writers.createIssue(ctx.accountId, repoFullName, title, issueBody)
}
