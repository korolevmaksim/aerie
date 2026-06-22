// Pre-run LLM grounding (ROADMAP M5b): run the installed, repo-relevant local
// quality tools on the change BEFORE the LLM agent, and turn their deterministic
// findings into a ground-truth block the agent must verify (confirm/refute/merge)
// rather than hallucinate around. Electron-free (spawn + pure findings logic), so
// it is unit-testable end to end.

import { spawn, type ChildProcess } from 'child_process'
import { aggregateFindings } from './aggregate'
import { substitute, type Agent } from './agentConfig'
import {
  parseChangedLineRanges,
  parseToolOutput,
  renderFindingsForPrompt,
  scopeToChanges,
  type Finding,
  type Severity
} from './findings'
import { whichOnPath } from './pathLookup'

// File extensions that make a tool relevant to a change. A tool with no entry
// (e.g. gitleaks — secrets can be anywhere) is always relevant.
const RELEVANT_EXT: Record<string, string[]> = {
  eslint: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
  oxlint: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
  biome: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.jsonc'],
  tsc: ['.ts', '.tsx', '.mts', '.cts'],
  ruff: ['.py', '.pyi'],
  bandit: ['.py', '.pyi'],
  yamllint: ['.yml', '.yaml'],
  actionlint: ['.yml', '.yaml']
}

/** True if a tool is worth running given the files the change touches. */
export function isToolRelevant(toolId: string, changedFiles: string[]): boolean {
  const exts = RELEVANT_EXT[toolId]
  if (!exts || exts.length === 0) return true // unknown/always-relevant (gitleaks) → run
  return changedFiles.some((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
}

/** The kind:'tool' agents that are installed on PATH AND relevant to the change. */
export function selectGroundingTools(agents: Agent[], changedFiles: string[]): Agent[] {
  return agents.filter(
    (a) =>
      a.kind === 'tool' &&
      whichOnPath(a.detect ?? a.command) !== null &&
      isToolRelevant(a.id, changedFiles)
  )
}

const MAX_TOOL_OUTPUT = 4 * 1024 * 1024

/** Signals the child's whole process group (it leads its own group). */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    } catch {
      /* ignore */
    }
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Runs a tool in `cwd`, captures stdout, and resolves with it. Never rejects:
 * a spawn error resolves '' and a timeout kills the process group and resolves
 * whatever was captured. The GitHub token is NEVER placed in the tool env.
 */
export function runToolCapture(
  agent: Agent,
  cwd: string,
  vars: Record<string, string>,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    let timer: NodeJS.Timeout | undefined = undefined
    const settle = (value: string): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }

    let child: ChildProcess
    try {
      const args = agent.args.map((a) => substitute(a, vars))
      child = spawn(agent.command, args, { cwd, env: { ...process.env }, detached: true })
    } catch {
      settle('')
      return
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      if (out.length < MAX_TOOL_OUTPUT) out += d
    })
    // Drain stderr so a chatty tool can't fill the OS pipe buffer and block.
    child.stderr?.resume()
    child.stdin?.end()
    timer = setTimeout(() => {
      killTree(child, 'SIGTERM')
      setTimeout(() => killTree(child, 'SIGKILL'), 1000).unref()
      settle(out)
    }, timeoutMs)
    child.on('error', () => settle(''))
    child.on('close', () => settle(out))
  })
}

export interface GroundingResult {
  groundTruth: string
  /** Findings after the noise filter (dedup/consensus/severity). */
  findingsCount: number
  /** Findings before the noise filter (for an "X of Y" message). */
  rawCount: number
  toolsRun: number
  /** Relevant+installed tools NOT run because the cap was hit (0 = none dropped). */
  toolsSkipped: number
}

/**
 * Runs the relevant installed tools (capped), parses + scopes their findings to
 * the change, and renders them as a ground-truth block. Best-effort: a failing
 * tool contributes nothing and never blocks. Tools run in parallel, each bounded
 * by `timeoutMs`; at most `maxTools` run.
 */
export async function gatherGroundTruth(args: {
  agents: Agent[]
  cwd: string
  diff: string
  diffFile: string
  changedFiles: string[]
  maxTools?: number
  timeoutMs?: number
  /** Noise-filter knobs (M6); default off — pure dedup. */
  consensusMin?: number
  minSeverity?: Severity
}): Promise<GroundingResult> {
  // Relevance gating is the real limiter (only tools matching the changed files run);
  // the cap is a safety ceiling above the current catalog (9 tools) so even a polyglot
  // diff isn't truncated in practice. If the cap is ever hit, `toolsSkipped` makes the
  // drop visible (never silent) — the runner surfaces it.
  const relevant = selectGroundingTools(args.agents, args.changedFiles)
  const selected = relevant.slice(0, args.maxTools ?? 12)
  const toolsSkipped = relevant.length - selected.length
  if (selected.length === 0) {
    return { groundTruth: '', findingsCount: 0, rawCount: 0, toolsRun: 0, toolsSkipped: 0 }
  }

  const ranges = parseChangedLineRanges(args.diff)
  const vars: Record<string, string> = {
    repoPath: args.cwd,
    diffFile: args.diffFile,
    changedFiles: args.changedFiles.join('\n')
  }
  const captured = await Promise.all(
    selected.map((tool) =>
      runToolCapture(tool, args.cwd, vars, args.timeoutMs ?? 60_000).then((raw) => ({ tool, raw }))
    )
  )

  const findings: Finding[] = []
  for (const { tool, raw } of captured) {
    let f = parseToolOutput(tool.id, raw)
    if (ranges.size > 0) f = scopeToChanges(f, ranges)
    findings.push(...f)
  }
  // Filter noise before injecting: dedup + collapse the same issue reported by
  // multiple tools. Consensus/severity thresholds are off by default.
  const agg = aggregateFindings(findings, {
    consensusMin: args.consensusMin,
    minSeverity: args.minSeverity
  })
  return {
    groundTruth: renderFindingsForPrompt(agg.kept),
    findingsCount: agg.kept.length,
    rawCount: findings.length,
    toolsRun: selected.length,
    toolsSkipped
  }
}
