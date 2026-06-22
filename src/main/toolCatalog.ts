// Local code-quality tools (linters / SAST / type-checkers) modeled as the same
// Agent contract with kind:'tool' (ROADMAP M3). loadAgents() surfaces an entry only
// when its binary is on PATH, and never persists it. These run 100% LOCALLY (no
// network) in the worktree and emit MACHINE-READABLE findings — later fed into the
// LLM review as ground truth (M5) and shown/filtered (M4/M6).
//
// Each invocation is documentation-researched + adversarially flag-checked. The
// successExitCodes include the "found issues" code so a tool that exits non-zero ON
// FINDINGS is recorded 'done', not 'error'.
//
// Deferred after research (not added, and why):
//  - semgrep, osv-scanner : need network by default (registry rules / osv.dev).
//  - golangci-lint : must compile the module — needs the Go toolchain and pulls
//    uncached modules (network); overloaded non-zero exit codes (3/5/7 ≠ findings).
//  - mypy, pylint : noisy/unusable as a config-less drop-in (flood import-stub errors
//    in a bare environment); pylint's exit code is a summed bitmask, not a clean set.
//  - shellcheck, hadolint : no tree/recursive scan — require explicit file targets,
//    which the static-argv contract can't enumerate (hadolint reads stdin with no arg).
//  - stylelint : errors "No configuration provided" when no config file is present.
//
// NOTE: detection is PATH-based, so a project-local eslint/tsc (node_modules/.bin) is
// only detected when also installed globally — per-repo bin detection is a follow-up.
//
// SECURITY (residual, accepted for M3): some tools execute the REPO's OWN config when
// run — ESLint loads/executes eslint.config.js, tsc resolves tsconfig `extends`, Biome
// reads its config, and oxlint auto-loads/executes an oxlint.config.ts if present — so
// running them on an UNTRUSTED repo/PR executes that repo's config code inside the
// worktree. (bandit/yamllint/actionlint read only DATA config, no code execution.)
// This is a strictly SMALLER capability than the LLM agents
// Aerie already runs there (auto-approved tools with shell access), is confined to the
// disposable app-owned worktree with no token, and true process sandboxing is a later
// stage. Review only repos you trust. As of M5b these tools also run AUTOMATICALLY as
// pre-review grounding on every LLM review (incl. an untrusted PR head); disable via
// Settings → "Ground reviews with local tools" (ui.groundReviews) when reviewing
// untrusted code.

import type { Agent } from './agentConfig'

const TOOL_TIMEOUT = 300

/** Builds a kind:'tool' Agent (no model/reasoning; prompt unused — tools scan the tree). */
function tool(t: {
  id: string
  label: string
  command: string
  args: string[]
  successExitCodes: number[]
}): Agent {
  return {
    id: t.id,
    label: t.label,
    command: t.command,
    detect: t.command,
    args: t.args,
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: TOOL_TIMEOUT,
    env: {},
    kind: 'tool',
    successExitCodes: t.successExitCodes,
    models: [],
    reasoningLevels: []
  }
}

export const TOOL_CATALOG: Agent[] = [
  tool({
    id: 'gitleaks',
    label: 'Gitleaks (secret scan)',
    command: 'gitleaks',
    // Scan the worktree tree (not git history) → JSON to stdout, no banner/color/logs.
    // CAVEAT: exit 1 means leaks-found OR error (overloaded); disambiguate by output (M4).
    args: [
      'dir',
      '.',
      '--report-format',
      'json',
      '--report-path',
      '-',
      '--no-banner',
      '--no-color',
      '--log-level',
      'fatal',
      '--exit-code',
      '1'
    ],
    successExitCodes: [0, 1]
  }),
  tool({
    id: 'ruff',
    label: 'Ruff (Python lint)',
    command: 'ruff',
    args: ['check', '--output-format', 'json', '.'],
    successExitCodes: [0, 1]
  }),
  tool({
    id: 'eslint',
    label: 'ESLint (JS/TS lint)',
    command: 'eslint',
    args: ['-f', 'json', '.'],
    successExitCodes: [0, 1]
  }),
  tool({
    id: 'biome',
    label: 'Biome (JS/TS lint)',
    command: 'biome',
    args: ['check', '--reporter=json', '.'],
    successExitCodes: [0, 1]
  }),
  tool({
    id: 'tsc',
    label: 'TypeScript (tsc --noEmit)',
    command: 'tsc',
    // Text diagnostics `file(line,col): error TSxxxx: msg` to stdout (no JSON mode).
    // Exit 1 = type errors (findings); exit 2 = config/CLI error (a real failure → 'error').
    args: ['--noEmit', '--pretty', 'false', '--incremental', 'false'],
    successExitCodes: [0, 1]
  }),
  tool({
    id: 'bandit',
    label: 'Bandit (Python SAST)',
    command: 'bandit',
    // Recursive AST scan → JSON to stdout; -q drops non-finding chatter. Offline.
    // Exit 1 = issues at/above threshold (findings); exit 2 = a real processing error.
    args: ['-r', '.', '-f', 'json', '-q'],
    successExitCodes: [0, 1]
  }),
  tool({
    id: 'oxlint',
    label: 'oxlint (fast JS/TS lint)',
    command: 'oxlint',
    // Runs with no config, but auto-loads/executes a repo oxlint.config.ts if present
    // (see the SECURITY note above). JSON diagnostics to stdout; exit 1 = error findings.
    args: ['-f', 'json', '.'],
    successExitCodes: [0, 1]
  }),
  tool({
    id: 'yamllint',
    label: 'yamllint (YAML lint)',
    command: 'yamllint',
    // Parsable text `path:line:col: [level] message (rule)` to stdout. Exit 1 on errors.
    args: ['-f', 'parsable', '.'],
    successExitCodes: [0, 1]
  }),
  tool({
    id: 'actionlint',
    label: 'actionlint (GitHub Actions lint)',
    command: 'actionlint',
    // With no path it auto-discovers .github/workflows/*.yml; JSON array via a Go template.
    // shellcheck/pyflakes integrations are optional (skipped if absent). Exit 1 on problems.
    args: ['-format', '{{json .}}'],
    successExitCodes: [0, 1]
  })
]
