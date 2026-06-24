import type {
  ConsensusFinding,
  RefType,
  RunGroupHistoryItem,
  RunHistoryItem,
  RunStatus
} from '../shared/types'

const STATUS_RANK: Record<RunStatus, number> = {
  queued: 0,
  running: 1,
  done: 2,
  error: 3,
  killed: 4
}

const MAX_AGENT_OUTPUT_CHARS = 20_000

function statusForRuns(runs: Pick<RunHistoryItem, 'status'>[]): RunStatus {
  if (runs.length === 0) return 'error'
  if (runs.some((r) => r.status === 'running')) return 'running'
  if (runs.some((r) => r.status === 'queued')) return 'queued'
  if (runs.some((r) => r.status === 'done')) return 'done'
  if (runs.some((r) => r.status === 'error')) return 'error'
  return 'killed'
}

export function derivePanelStatus(runs: Pick<RunHistoryItem, 'status'>[]): RunStatus {
  return statusForRuns(runs)
}

export function derivePanelFinishedAt(
  runs: Pick<RunHistoryItem, 'status' | 'finishedAt'>[]
): string | null {
  if (runs.length === 0) return null
  if (runs.some((r) => r.status === 'queued' || r.status === 'running')) return null
  const finished = runs
    .map((r) => r.finishedAt)
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort()
  return finished.at(-1) ?? null
}

export function sortPanelRuns(runs: RunHistoryItem[]): RunHistoryItem[] {
  return [...runs].sort((a, b) => {
    const status = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    if (status !== 0) return status
    return a.agentId.localeCompare(b.agentId)
  })
}

function refLabel(refType: RefType, refId: string, sha: string): string {
  if (refType === 'pr') return `PR #${refId}`
  if (refType === 'project') return `project ${refId}`
  if (refType === 'working-tree') return `working tree ${sha.slice(0, 8)}`
  return `commit ${sha.slice(0, 8)}`
}

function findingLine(f: ConsensusFinding): string {
  const loc = `${f.file}${f.line != null ? `:${f.line}` : ''}`
  return `- ${f.severity.toUpperCase()} · ${f.agreement} agent${f.agreement === 1 ? '' : 's'} · \`${loc}\` — ${f.message}`
}

function boundOutput(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_AGENT_OUTPUT_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_AGENT_OUTPUT_CHARS).trimEnd()}\n\n[aerie] agent output truncated in consolidated report`
}

export function renderPanelReportMarkdown(args: {
  group: RunGroupHistoryItem
  runs: RunHistoryItem[]
  consensusFindings: ConsensusFinding[]
  singleSourceFindings: ConsensusFinding[]
  consensusMin: number
  totalFindings: number
  outputs: Map<number, string>
}): string {
  const { group, consensusFindings, singleSourceFindings, consensusMin, totalFindings } = args
  const lines: string[] = [
    `# Aerie panel review — ${refLabel(group.refType, group.refId, group.headSha)}`,
    '',
    `Repository: \`${group.repoFullName}\``,
    `Status: \`${group.status}\``,
    `Agents: ${group.agentIds.map((id) => `\`${id}\``).join(', ')}`,
    `Target SHA: \`${group.headSha}\``,
    ''
  ]

  lines.push('## Consolidated findings', '')
  if (consensusFindings.length > 0) {
    lines.push(`Findings agreed by at least ${consensusMin} agents:`, '')
    lines.push(...consensusFindings.map(findingLine), '')
  } else {
    lines.push(
      `No finding reached ${consensusMin}-agent consensus${totalFindings > 0 ? '; review single-source findings below.' : '.'}`,
      ''
    )
  }

  lines.push('## Single-source findings to triage', '')
  if (singleSourceFindings.length > 0) {
    lines.push(...singleSourceFindings.map(findingLine), '')
  } else {
    lines.push('_No additional structured findings._', '')
  }

  lines.push('## Agent reports', '')
  for (const run of sortPanelRuns(args.runs)) {
    const output = boundOutput(args.outputs.get(run.id) ?? '')
    lines.push(
      `<details>`,
      `<summary>${run.agentId} · ${run.status}${run.exitCode == null ? '' : ` · exit ${run.exitCode}`}</summary>`,
      '',
      output.length > 0 ? output : '_No clean review output recorded._',
      '',
      `</details>`,
      ''
    )
  }

  lines.push('---', '_Consolidated by Aerie from local agent runs._')
  return `${lines.join('\n').trim()}\n`
}
