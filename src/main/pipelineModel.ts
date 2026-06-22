// Pure pipeline logic (ROADMAP M9a): config validation, the auto-post safety gate,
// trigger scope-matching, and dedupe-key derivation. Electron-free + unit-tested —
// the security-critical bits (a disabled `post` can NEVER reach a write) live here
// so they are provable in isolation, before the live engine/poller wire them up.

import { createHash } from 'node:crypto'
import type {
  PipelineAction,
  PipelineActionKind,
  PipelineDraft,
  PipelineScope,
  PipelineStep,
  PipelineTrigger
} from '../shared/types'

const TRIGGERS: readonly PipelineTrigger[] = ['commit', 'pr', 'schedule', 'manual']
const ACTION_KINDS: readonly PipelineActionKind[] = ['notify', 'stage', 'post']
const POST_TARGETS = ['commit', 'pr', 'issue'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'string')
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value)
}

// Counts/caps are never negative; a negative would silently read as "no cap" downstream.
function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function isStep(value: unknown): value is PipelineStep {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (value.kind === 'agent' || value.kind === 'tool') &&
    typeof value.ref === 'string' &&
    value.ref.length > 0 &&
    (value.model === undefined || typeof value.model === 'string') &&
    isOptionalStringArray(value.dependsOn)
  )
}

function isScope(value: unknown): value is PipelineScope {
  if (!isRecord(value)) return false
  return (
    isOptionalStringArray(value.branches) &&
    isOptionalStringArray(value.labels) &&
    isOptionalStringArray(value.authors) &&
    isOptionalStringArray(value.paths) &&
    (value.includeDrafts === undefined || typeof value.includeDrafts === 'boolean') &&
    isOptionalNonNegativeNumber(value.maxCommits)
  )
}

function isAction(value: unknown): value is PipelineAction {
  if (!isRecord(value)) return false
  return (
    typeof value.kind === 'string' &&
    ACTION_KINDS.includes(value.kind as PipelineActionKind) &&
    typeof value.autoPost === 'boolean' &&
    (value.target === undefined || POST_TARGETS.includes(value.target as never))
  )
}

function isGuardrails(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    isOptionalNonNegativeNumber(value.maxConcurrentRuns) &&
    isOptionalNonNegativeNumber(value.perRepoCooldownSeconds) &&
    isOptionalNonNegativeNumber(value.maxRunsPerHour)
  )
}

/**
 * Validates an authored/persisted pipeline config (no DB id). Used when loading a
 * `config` blob from SQLite or accepting one over IPC, so a malformed row can never
 * reach the engine. Steps may be empty here (a no-op pipeline); the engine decides
 * eligibility separately.
 */
export function isPipelineDraft(value: unknown): value is PipelineDraft {
  if (!isRecord(value)) return false
  if (typeof value.name !== 'string' || value.name.length === 0) return false
  if (typeof value.repoId !== 'number' || !Number.isInteger(value.repoId)) return false
  if (typeof value.trigger !== 'string' || !TRIGGERS.includes(value.trigger as PipelineTrigger)) {
    return false
  }
  if (value.schedule !== undefined && typeof value.schedule !== 'string') return false
  if (typeof value.enabled !== 'boolean') return false
  if (!isScope(value.scope)) return false
  if (!Array.isArray(value.steps) || !value.steps.every(isStep)) return false
  if (!isAction(value.action)) return false
  if (!isGuardrails(value.guardrails)) return false
  // Cross-field requirements (a `schedule` when trigger==='schedule', a `target` when an
  // enabled post) are intentionally NOT enforced here: the editor supplies defaults and the
  // engine re-checks before acting. This validator guarantees structural shape only — the
  // engine must not assume a non-null `schedule`/`target` from a passing draft.
  return true
}

// --- the auto-post safety gate (SPEC §10) ------------------------------------

/** True ONLY for an explicitly enabled post action — the sole condition for a write. */
export function mayAutoPost(action: PipelineAction): boolean {
  return action.kind === 'post' && action.autoPost === true
}

/**
 * Defense-in-depth guard: throws unless the action is an enabled auto-post. Call this
 * immediately before ANY `createCommitComment`/`createPrComment`/`createIssue` the
 * engine makes, so an unset/false `autoPost` (or a non-`post` kind) can never write —
 * even if a caller's branch logic is wrong. The human confirm path does not use this.
 */
export function assertMayPost(action: PipelineAction): void {
  if (!mayAutoPost(action)) {
    throw new Error(
      `refusing to auto-post: action is "${action.kind}" with autoPost=${action.autoPost} ` +
        '(an enabled post opt-in is required)'
    )
  }
}

/**
 * The action the engine will actually take. A `post` without the `autoPost` opt-in
 * degrades to `stage` (hold the prepared result for the manual confirm) — it never
 * silently posts. `notify`/`stage` pass through unchanged.
 */
export function effectiveAction(action: PipelineAction): PipelineActionKind {
  if (action.kind === 'post' && !action.autoPost) return 'stage'
  return action.kind
}

// --- trigger scope matching --------------------------------------------------

export interface ScopeContext {
  /** Branch the delta landed on (commit trigger). */
  branch?: string
  /** Labels on the PR (pr trigger). */
  labels?: string[]
  /** Commit/PR author login. */
  author?: string | null
  /** Paths changed by the delta. */
  paths?: string[]
  /** Whether the PR is a draft (pr trigger). */
  isDraft?: boolean
  /** Number of commits in the delta (push size). */
  commitCount?: number
}

function pathMatches(changed: string, prefix: string): boolean {
  if (prefix.endsWith('/')) return changed.startsWith(prefix)
  return changed === prefix || changed.startsWith(`${prefix}/`)
}

/**
 * Whether a delta passes a pipeline's scope filter. An absent/empty predicate is a
 * wildcard; a present one must be satisfied. Labels/paths match if ANY entry hits;
 * branches/authors must match exactly; a push larger than `maxCommits` is skipped.
 * Drafts pass unless `includeDrafts` is explicitly `false` (the editor defaults a new
 * PR pipeline to false — the pure matcher stays a uniform "absent = wildcard").
 */
export function matchesScope(scope: PipelineScope, ctx: ScopeContext): boolean {
  if (scope.branches?.length) {
    if (!ctx.branch || !scope.branches.includes(ctx.branch)) return false
  }
  if (scope.labels?.length) {
    const have = ctx.labels ?? []
    if (!scope.labels.some((l) => have.includes(l))) return false
  }
  if (scope.authors?.length) {
    if (!ctx.author || !scope.authors.includes(ctx.author)) return false
  }
  if (scope.paths?.length) {
    const changed = ctx.paths ?? []
    if (!changed.some((c) => scope.paths!.some((p) => pathMatches(c, p)))) return false
  }
  if (scope.includeDrafts === false && ctx.isDraft) return false
  if (scope.maxCommits && scope.maxCommits > 0 && (ctx.commitCount ?? 0) > scope.maxCommits) {
    return false
  }
  return true
}

// --- dedupe key (finished-run cache) -----------------------------------------

/**
 * A stable hash of the bits that determine a run's WORK, so the poller never re-runs
 * identical work on an unchanged head. Includes the steps + their models + the action
 * kind; scope/enabled/name do not affect the produced result and are excluded.
 */
export function pipelineConfigHash(steps: PipelineStep[], action: PipelineActionKind): string {
  const canon = JSON.stringify({
    steps: steps.map((s) => ({
      kind: s.kind,
      ref: s.ref,
      model: s.model ?? '',
      dependsOn: [...(s.dependsOn ?? [])].sort()
    })),
    action
  })
  return createHash('sha256').update(canon).digest('hex')
}

export interface DedupeParts {
  repoId: number
  refType: string
  ref: string
  baseSha: string | null
  headSha: string
  /** Tool/agent catalog version (so a catalog bump re-runs). */
  catalogVersion: string
  /** Hash of the review prompt body. */
  promptHash: string
  /** `pipelineConfigHash` of the steps + action. */
  configHash: string
}

/** Deterministic dedupe key for a (repo, ref, base→head, catalog, prompt, config) tuple. */
export function dedupeKey(parts: DedupeParts): string {
  // JSON-encode the parts (not a delimiter join) so no field value — e.g. a ref or branch
  // name containing a delimiter char — can shift a boundary and collide two distinct work
  // units onto one key (which would silently skip a real review).
  const canon = JSON.stringify([
    parts.repoId,
    parts.refType,
    parts.ref,
    parts.baseSha ?? '',
    parts.headSha,
    parts.catalogVersion,
    parts.promptHash,
    parts.configHash
  ])
  return createHash('sha256').update(canon).digest('hex')
}
