// Pre-run LLM grounding (ROADMAP M5b): run the installed, repo-relevant local
// quality tools on the change BEFORE the LLM agent, and turn their deterministic
// findings into a ground-truth block the agent must verify (confirm/refute/merge)
// rather than hallucinate around. Electron-free (spawn + pure findings logic), so
// it is unit-testable end to end.

import { spawn, type ChildProcess } from 'child_process'
import { substitute, type Agent } from './agentConfig'
import {
  parseChangedLineRanges,
  parseToolOutput,
  renderFindingsForPrompt,
  scopeToChanges,
  type Finding
} from './findings'
import { whichOnPath } from './pathLookup'

// File extensions that make a tool relevant to a change. A tool with no entry
// (e.g. gitleaks — secrets can be anywhere) is always relevant.
const RELEVANT_EXT: Record<string, string[]> = {
  eslint: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
  biome: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.jsonc'],
  tsc: ['.ts', '.tsx', '.mts', '.cts'],
  ruff: ['.py', '.pyi']
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
  findingsCount: number
  toolsRun: number
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
}): Promise<GroundingResult> {
  const selected = selectGroundingTools(args.agents, args.changedFiles).slice(0, args.maxTools ?? 4)
  if (selected.length === 0) return { groundTruth: '', findingsCount: 0, toolsRun: 0 }

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
  return {
    groundTruth: renderFindingsForPrompt(findings),
    findingsCount: findings.length,
    toolsRun: selected.length
  }
}
