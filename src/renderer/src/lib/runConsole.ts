// Pure helpers for the RunView console toolbar (ROADMAP M14). Copying a run's review is
// client-side over text the user already sees; these helpers only build a label and an optional
// Markdown wrapper — they add NO token, secret, or local path of their own.

export interface RunRef {
  refType: string
  refId: string
  headSha: string
}

export interface RunOutputMeta {
  agentId: string
  refLabel: string
  status: string
}

/** A human label for a run's target: "PR #42", "working tree abc1234", or "commit abc1234". */
export function runRefLabel(run: RunRef): string {
  if (run.refType === 'pr') return `PR #${run.refId}`
  if (run.refType === 'working-tree') return `working tree ${run.headSha.slice(0, 8)}`
  return `commit ${run.headSha.slice(0, 8)}`
}

/**
 * Wraps a run's review `text` in a small Markdown header (target + agent + status) for pasting
 * into a PR/issue/notes. The body is passed through verbatim (agents already emit Markdown); the
 * wrapper contributes only the meta fields — no token/secret/path.
 */
export function runOutputToMarkdown(meta: RunOutputMeta, text: string): string {
  const header = `### Aerie review — ${meta.refLabel}`
  const sub = `_agent \`${meta.agentId}\` · ${meta.status}_`
  return `${header}\n\n${sub}\n\n${text.trim()}\n`
}
