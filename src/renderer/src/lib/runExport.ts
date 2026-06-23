import type { RunHistoryItem } from '@shared/types'
import { runRefLabel } from './runConsole'

/**
 * Client-side export of the Run-history list (ROADMAP M14). Pure: projects each run to a SAFE,
 * human-meaningful subset and renders it as JSON or a Markdown table. Deliberately EXCLUDES the
 * local `outputPath` (a filesystem path), the internal numeric ids (id/repoId/accountId), and
 * anything token/secret-bearing — the export only carries metadata the user already sees in the
 * list. No IPC, no GitHub call.
 */
export interface ExportedRun {
  repo: string
  agent: string
  ref: string
  sha: string
  status: string
  exitCode: number | null
  startedAt: string
  finishedAt: string | null
  author: string | null
  postedUrl: string | null
}

export function toExportRun(run: RunHistoryItem): ExportedRun {
  return {
    repo: run.repoFullName,
    agent: run.agentId,
    ref: runRefLabel(run),
    sha: run.headSha,
    status: run.status,
    exitCode: run.exitCode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    author: run.authorLogin,
    postedUrl: run.postedUrl
  }
}

/** The visible runs as a pretty-printed JSON array of the safe subset. */
export function runsToJson(runs: RunHistoryItem[]): string {
  return JSON.stringify(runs.map(toExportRun), null, 2)
}

const MD_COLUMNS: { header: string; cell: (r: ExportedRun) => string }[] = [
  { header: 'Repo', cell: (r) => r.repo },
  { header: 'Agent', cell: (r) => r.agent },
  { header: 'Ref', cell: (r) => r.ref },
  { header: 'SHA', cell: (r) => r.sha.slice(0, 8) },
  { header: 'Status', cell: (r) => r.status },
  { header: 'Exit', cell: (r) => (r.exitCode === null ? '' : String(r.exitCode)) },
  { header: 'Started', cell: (r) => r.startedAt },
  { header: 'Finished', cell: (r) => r.finishedAt ?? '' },
  { header: 'Author', cell: (r) => r.author ?? '' },
  { header: 'Posted', cell: (r) => r.postedUrl ?? '' }
]

/** Escape a Markdown table cell: a pipe breaks the column, a newline breaks the row. */
function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** The visible runs as a GitHub-flavored Markdown table (header + separator + one row each). */
export function runsToMarkdown(runs: RunHistoryItem[]): string {
  if (runs.length === 0) return '_No runs._'
  const header = `| ${MD_COLUMNS.map((c) => c.header).join(' | ')} |`
  const separator = `| ${MD_COLUMNS.map(() => '---').join(' | ')} |`
  const body = runs.map((run) => {
    const r = toExportRun(run)
    return `| ${MD_COLUMNS.map((c) => mdCell(c.cell(r))).join(' | ')} |`
  })
  return [header, separator, ...body].join('\n')
}
