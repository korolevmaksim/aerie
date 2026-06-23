import type { RunHistoryItem } from '@shared/types'
import { runRefLabel } from './runConsole'

/**
 * Free-text filtering for the Run-history list (ROADMAP M14). Pure + client-side over the
 * already-loaded runs — no IPC, no privileged surface. A query is split into whitespace tokens
 * and ALL must match (case-insensitive substring) across the run's searchable fields, so e.g.
 * "codex error" finds error runs by the codex agent. A blank query passes everything through.
 */
function searchableText(run: RunHistoryItem): string {
  return [
    run.repoFullName,
    run.agentId,
    run.headSha,
    // For a PR, "pr #42" already contains the bare number, so "42" or "pr #42" matches.
    runRefLabel(run),
    run.refId,
    run.status,
    run.localStatus,
    run.localStatus === 'open' ? '' : `${run.localStatus} locally`,
    run.authorLogin ?? ''
  ]
    .join(' ')
    .toLowerCase()
}

/** True if `run` matches every token in `query` (case-insensitive); a blank query matches all. */
export function matchesRunQuery(run: RunHistoryItem, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const text = searchableText(run)
  return tokens.every((t) => text.includes(t))
}

/** Filter runs by a free-text query (blank = passthrough). Pure. */
export function filterRuns(runs: RunHistoryItem[], query: string): RunHistoryItem[] {
  if (query.trim() === '') return runs
  return runs.filter((r) => matchesRunQuery(r, query))
}
