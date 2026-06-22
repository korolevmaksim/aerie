// Pure agent-registry logic — the editable agent contract (SPEC §7), validation,
// placeholder substitution, and prompt building. Electron-free so it is testable.
//
// Each default template was verified on-machine for a CLEAN, headless, read-only
// code-review invocation (only the final review is captured — no chat UI, no
// reasoning/tool-call transcript). Adding/editing an agent is a config edit.

export interface Agent {
  id: string
  label: string
  command: string
  args: string[]
  promptDelivery: 'arg' | 'stdin' | 'file'
  promptPlaceholder: string
  outputCapture: 'stdout' | 'file'
  outputFile: string | null
  timeoutSec: number
  env: Record<string, string>
  /** Currently selected model (substituted into {{model}}). */
  model?: string
  /** Selectable models for this agent (UI dropdown). */
  models?: string[]
  /** Default reasoning/thinking level (substituted into {{reasoning}}). */
  reasoning?: string
  /** Selectable reasoning levels (empty/absent → the CLI has no reasoning control). */
  reasoningLevels?: string[]
  /** Binary to check for availability (defaults to `command`). */
  detect?: string
  /** 'agent' (LLM CLI, default) or 'tool' (deterministic linter/SAST/type-checker). */
  kind?: 'agent' | 'tool'
  /**
   * Exit codes that mean the run SUCCEEDED (findings may or may not be present), so a
   * linter that exits non-zero when it finds issues is recorded 'done', not 'error'.
   * Defaults to [0] when absent or empty.
   */
  successExitCodes?: number[]
}

const REVIEW_TIMEOUT = 900

/**
 * Ids of templates that used to ship as defaults but were retired. A removed default
 * otherwise lingers in the persisted agents.json and reads as a user-added agent, so it
 * would never disappear from the list. Pruned on load. (Re-adding the same id as a real
 * user agent is still possible — only the exact retired id is dropped.)
 */
export const RETIRED_AGENT_IDS: ReadonlySet<string> = new Set(['dummy'])

export const DEFAULT_AGENTS: Agent[] = [
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    command: 'codex',
    // -o writes ONLY the final message (no exec/reasoning transcript) → clean comment.
    args: [
      'exec',
      '--skip-git-repo-check',
      '-C',
      '{{repoPath}}',
      '-s',
      'read-only',
      '-m',
      '{{model}}',
      '-c',
      'model_reasoning_effort={{reasoning}}',
      '-o',
      '{{outFile}}',
      '{{prompt}}'
    ],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'file',
    outputFile: '{{outFile}}',
    timeoutSec: REVIEW_TIMEOUT,
    env: {},
    model: 'gpt-5.5',
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
    reasoning: 'high',
    reasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    detect: 'codex'
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    args: [
      '-p',
      '{{prompt}}',
      '--output-format',
      'text',
      '--model',
      '{{model}}',
      '--effort',
      '{{reasoning}}',
      '--permission-mode',
      'plan',
      '--add-dir',
      '{{repoPath}}'
    ],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: REVIEW_TIMEOUT,
    env: {},
    model: 'claude-opus-4-8',
    models: [
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-fable-5'
    ],
    reasoning: 'high',
    reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    detect: 'claude'
  },
  {
    id: 'cursor-agent',
    label: 'Cursor Agent',
    args: [
      '-p',
      '--output-format',
      'text',
      '--trust',
      '--mode',
      'ask',
      '--workspace',
      '{{repoPath}}',
      '--model',
      '{{model}}',
      '{{prompt}}'
    ],
    command: 'cursor-agent',
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: REVIEW_TIMEOUT,
    env: {},
    // Cursor encodes reasoning effort in the model-id suffix.
    model: 'gpt-5.5-high',
    models: [
      'gpt-5.5-high',
      'gpt-5.4-high',
      'claude-opus-4-8-thinking-high',
      'claude-opus-4-8-high',
      'claude-4.6-sonnet-medium',
      'gpt-5.3-codex-high',
      'gemini-3.1-pro',
      'auto'
    ],
    detect: 'cursor-agent'
  },
  {
    id: 'opencode',
    label: 'opencode',
    command: 'opencode',
    args: [
      'run',
      '--dir',
      '{{repoPath}}',
      '--model',
      '{{model}}',
      '--variant',
      '{{reasoning}}',
      '--dangerously-skip-permissions',
      '{{prompt}}'
    ],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: REVIEW_TIMEOUT,
    env: {},
    // opencode --variant is provider-specific; high/max are valid for the
    // default Claude model (and high is valid everywhere).
    reasoning: 'high',
    reasoningLevels: ['high', 'max'],
    model: 'opencode/claude-opus-4-8',
    models: [
      'opencode/claude-opus-4-8',
      'opencode/gpt-5.5',
      'anthropic/claude-sonnet-4-6',
      'openai/gpt-5.5'
    ],
    detect: 'opencode'
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    // kimi has no clean-output flag: take stream-json and keep the last assistant
    // message via a tiny node filter (node ships with Electron/on PATH).
    command: 'sh',
    args: [
      '-c',
      `kimi -p "$1" --output-format stream-json --model "$2" 2>/dev/null | node -e 'let last="";require("readline").createInterface({input:process.stdin}).on("line",l=>{try{const o=JSON.parse(l);if(o.role==="assistant"&&typeof o.content==="string"&&o.content.trim())last=o.content}catch{}}).on("close",()=>process.stdout.write(last))'`,
      'sh',
      '{{prompt}}',
      '{{model}}'
    ],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: REVIEW_TIMEOUT,
    env: {},
    model: 'kimi-code/kimi-for-coding',
    models: ['kimi-code/kimi-for-coding', 'moonshot-ai/kimi-k2.6', 'moonshot-ai/kimi-k2.5'],
    detect: 'kimi'
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    args: [
      '--skip-trust',
      '--approval-mode',
      'plan',
      '-o',
      'text',
      '-m',
      '{{model}}',
      '-p',
      '{{prompt}}'
    ],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: REVIEW_TIMEOUT,
    // Headless Gemini needs an API key (OAuth is interactive-only).
    env: {},
    model: 'gemini-3-pro',
    models: ['gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    detect: 'gemini'
  },
  {
    id: 'vibe',
    label: 'Mistral Vibe',
    command: 'vibe',
    // -p = programmatic mode (send prompt, print final response, exit); --output text
    // is the clean human-readable response (no tool/reasoning transcript). --trust skips
    // the folder-trust prompt and --auto-approve never blocks on tool approval — the run
    // is confined to the disposable app-owned worktree (same posture as opencode/agy/mimo).
    args: [
      '-p',
      '{{prompt}}',
      '--output',
      'text',
      '--auto-approve',
      '--trust',
      '--workdir',
      '{{repoPath}}'
    ],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: REVIEW_TIMEOUT,
    // Vibe has no --model flag: the model is chosen via VIBE_ACTIVE_MODEL, which matches a
    // model's `alias` in ~/.vibe/config.toml (NOT its `name`) — e.g. mistral-medium-3.5,
    // devstral-small, or `local` (llamacpp). Reasoning is model-intrinsic (devstral/
    // magistral), so there is no per-run reasoning control.
    env: { VIBE_ACTIVE_MODEL: '{{model}}' },
    model: 'mistral-medium-3.5',
    models: ['mistral-medium-3.5', 'devstral-small', 'local'],
    detect: 'vibe'
  },
  {
    id: 'grok',
    label: 'Grok CLI',
    command: 'grok',
    args: [
      '-p',
      '{{prompt}}',
      '--cwd',
      '{{repoPath}}',
      '--always-approve',
      '--output-format',
      'plain',
      '--effort',
      '{{reasoning}}',
      '-m',
      '{{model}}'
    ],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: REVIEW_TIMEOUT,
    env: {},
    model: 'grok-build',
    models: ['grok-build', 'grok-composer-2.5-fast'],
    // grok-build accepts --effort (agentic budget); --reasoning-effort is rejected.
    reasoning: 'high',
    reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    detect: 'grok'
  },
  {
    id: 'agy',
    label: 'Antigravity (agy)',
    command: 'agy',
    args: [
      '-p',
      '{{prompt}}',
      '--model',
      '{{model}}',
      '--dangerously-skip-permissions',
      '--add-dir',
      '{{repoPath}}'
    ],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: REVIEW_TIMEOUT,
    env: {},
    model: 'Claude Opus 4.6 (Thinking)',
    models: [
      'Claude Opus 4.6 (Thinking)',
      'Claude Sonnet 4.6 (Thinking)',
      'Gemini 3.1 Pro (High)',
      'Gemini 3.5 Flash (High)',
      'GPT-OSS 120B (Medium)'
    ],
    detect: 'agy'
  },
  {
    id: 'mimo',
    label: 'MiMo Code',
    command: 'mimo',
    args: [
      'run',
      '--dir',
      '{{repoPath}}',
      '--model',
      '{{model}}',
      '--variant',
      '{{reasoning}}',
      '--format',
      'default',
      '--dangerously-skip-permissions',
      '-f',
      '{{diffFile}}',
      '{{prompt}}'
    ],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: REVIEW_TIMEOUT,
    env: {},
    model: 'xiaomi/mimo-v2.5-pro',
    models: ['xiaomi/mimo-v2.5-pro', 'xiaomi/mimo-v2.5-pro-ultraspeed', 'xiaomi/mimo-v2-pro'],
    reasoning: 'high',
    reasoningLevels: ['high', 'max'],
    detect: 'mimo'
  }
]

export function isAgent(value: unknown): value is Agent {
  const a = value as Partial<Agent>
  return (
    !!a &&
    typeof a.id === 'string' &&
    typeof a.label === 'string' &&
    typeof a.command === 'string' &&
    Array.isArray(a.args) &&
    a.args.every((x) => typeof x === 'string') &&
    (a.promptDelivery === 'arg' || a.promptDelivery === 'stdin' || a.promptDelivery === 'file') &&
    (a.outputCapture === 'stdout' || a.outputCapture === 'file') &&
    typeof a.timeoutSec === 'number'
  )
}

/**
 * Merges the agent registry from its three sources into (a) the set to PERSIST to
 * agents.json and (b) the set to surface at RUNTIME. Defaults are authoritative;
 * user-added agents (ids not among the defaults, and not retired) are preserved.
 * Catalog entries (the broad autodiscovery set) are surfaced ONLY when their CLI
 * is detected on PATH and are NEVER persisted — so they vanish when the tool is
 * uninstalled and never shadow a user's own same-id edit. Pure (PATH detection is
 * injected) so it stays electron-free and unit-testable.
 */
export function mergeAgents(opts: {
  defaults: Agent[]
  userAgents: Agent[]
  catalog: Agent[]
  retired: ReadonlySet<string>
  isDetected: (agent: Agent) => boolean
}): { persist: Agent[]; runtime: Agent[] } {
  const defaultIds = new Set(opts.defaults.map((a) => a.id))
  const userAdded = opts.userAgents.filter((a) => !defaultIds.has(a.id) && !opts.retired.has(a.id))
  const persist = [...opts.defaults, ...userAdded]
  const persistIds = new Set(persist.map((a) => a.id))
  const detectedCatalog = opts.catalog.filter((a) => !persistIds.has(a.id) && opts.isDetected(a))
  return { persist, runtime: [...persist, ...detectedCatalog] }
}

/**
 * Terminal status for an agent/tool process exit. `successExitCodes` (default [0])
 * lets a deterministic tool that exits non-zero when it finds issues be recorded
 * 'done' rather than 'error'. A timeout always wins. Pure so it is unit-testable.
 */
export function runStatusForExit(
  code: number | null,
  killedByTimeout: boolean,
  successExitCodes?: number[]
): 'done' | 'error' | 'killed' {
  if (killedByTimeout) return 'killed'
  const ok = successExitCodes && successExitCodes.length > 0 ? successExitCodes : [0]
  return code !== null && ok.includes(code) ? 'done' : 'error'
}

/** Replaces {{placeholder}} tokens; unknown placeholders are left intact. */
export function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => (key in vars ? vars[key] : whole))
}

/**
 * The original built-in review instructions (Aerie ≤ this release). Kept so the
 * prompts migration can recognise an UNEDITED default and upgrade it in place
 * without clobbering a user's edits. Do not change this literal — it is a
 * migration anchor, not live copy.
 */
export const LEGACY_DEFAULT_REVIEW_INSTRUCTIONS = [
  'You are a senior software engineer performing a code review.',
  'Review the diff for correctness, bugs, security issues, and code quality.',
  'Output ONLY your review — concise, concrete, actionable findings. No preamble.'
].join('\n')

/**
 * The built-in review instructions. Used when no custom prompt is selected, and
 * seeded as the editable "Default review" prompt. This is only the INSTRUCTION
 * half — buildPrompt always prepends the machine context (repo/sha/paths), so a
 * user-edited prompt can never strip the agent of where to look.
 */
export const DEFAULT_REVIEW_INSTRUCTIONS = `You are a senior software engineer reviewing a code change. The repository is checked out locally and the unified diff is provided as a file — read the diff, then open the surrounding code and related files you need to judge the change in context. If a file or symbol you need is missing from the checkout, or the diff looks truncated, say so and do not infer its contents.

Review for: correctness and logic errors, unhandled edge cases, error handling, security (injection, auth, secret handling, unsafe input), concurrency and race conditions, resource leaks, broken APIs or contracts, and missing or weak tests. Focus on the changed lines; raise a pre-existing issue only when the change reaches or worsens it, and say so.

Severity: Critical = data loss, a security hole, a crash, a broken build, or silently wrong results; Major = incorrect behaviour or a likely bug under realistic input; Minor = a real but low-impact defect. If unsure between two tiers, pick the lower.

For every finding give: the severity, the file path and the specific changed line or symbol (quoted from the code), what is wrong, why it matters, a concrete fix, and a confidence (High/Medium) — for Medium, name exactly what to check to confirm. Report only issues you can substantiate by reading the code; never speculate, invent problems, or pad with subjective style preferences. Order by severity. If the change is sound, say so in one line.

Output GitHub-flavored markdown: a one-sentence summary, then the findings. Be concise and concrete. No preamble, and do not restate the diff.`

/**
 * Curated review prompts seeded into a fresh database so a first clone ships with
 * high-quality, scenario-specific defaults out of the box. The first entry is the
 * editable "Default review"; the rest are focused lenses selectable per run.
 * Adding a prompt here only affects NEW databases — to roll one out to existing
 * installs, add a store migration (never edit this array's seeded rows in place).
 */
export const SEED_PROMPTS: ReadonlyArray<{ name: string; body: string }> = [
  { name: 'Default review', body: DEFAULT_REVIEW_INSTRUCTIONS },
  {
    name: 'Security audit',
    body: `You are an application security engineer auditing a code change. The repository is checked out locally and the unified diff is provided as a file — read the diff and trace the data and trust boundaries it touches. Focus on vulnerabilities introduced or newly exposed by this change; report a pre-existing weakness only when the change reaches, worsens, or exposes it, and say which.

Hunt for: injection (SQL, command, path, template), missing authentication or authorization on state-changing actions, privilege and trust-boundary crossings, secret and credential handling (hardcoded, logged, or leaked secrets), unsafe handling of untrusted input, SSRF and unsafe outbound requests, insecure deserialization, path traversal, weak or missing input validation, unsafe defaults, and TOCTOU/races with security impact. For each, consider how an attacker who controls the input could abuse it.

Severity by exploitability: Critical = remotely exploitable with no/low preconditions and high impact (RCE, auth bypass, secret/data exfiltration); High = exploitable under realistic preconditions; Medium = needs significant attacker control or local access; Low = hardening / defense-in-depth. State the precondition for each.

For every issue give: the severity, the file and line, the source→sink path (the untrusted input and the dangerous sink it reaches), the attack scenario, the impact, and a concrete remediation. Report only vulnerabilities you can substantiate from the code — do not invent threats or flag the theoretical without a plausible path. Order by severity. If you find nothing exploitable, say so and note any residual hardening worth considering.

Output GitHub-flavored markdown. Precise and actionable. No preamble.`
  },
  {
    name: 'Tests & edge cases',
    body: `You are a senior engineer reviewing a code change for test coverage and robustness. The repository is checked out locally and the unified diff is provided as a file — read the diff and the existing tests around the changed code. First identify the project's test framework, file/naming conventions, and fixtures by reading its tests and config, so the tests you propose fit that harness and level (unit / integration / smoke).

Identify: behaviour the change introduces or alters but leaves untested; missing edge and boundary cases (empty, null/undefined, zero, negative, very large, unicode, concurrent, malformed input); unhandled error paths and failure modes; brittle or incorrect assertions in existing tests; and assumptions that break under real-world input. Before listing a gap, confirm from the code that the scenario is actually reachable and not already prevented by types or validation — if the code already precludes an input, do not flag it. Skip trivial glue and code already covered.

For each gap give: a severity tag (High/Medium/Low by the bug that could slip through), the file/function, the specific untested scenario, why it matters, and a concrete test as a runnable case stub or precise Given/When/Then (key inputs + expected outcome). Rank by defect risk and mark the top 1–3 as Write-first. Be specific — name the cases. If coverage is genuinely adequate, say so.

Output GitHub-flavored markdown. Concrete and prioritized. No preamble.`
  },
  {
    name: 'Performance',
    body: `You are a performance-focused engineer reviewing a code change. The repository is checked out locally and the unified diff is provided as a file — read the diff and the paths it touches. Assess code the change introduces or alters; flag pre-existing hot-path code only when the change adds to its cost.

Look for: inefficient algorithms and avoidable super-linear complexity, repeated or redundant work, N+1 queries and chatty I/O, redundant network/DB/subprocess round-trips, chatty cross-process (IPC) calls, unnecessary allocations and copies, blocking work on the main/event-loop or UI thread, missing batching/caching/memoization, unbounded growth (memory, buffers, listeners), and contention that limits concurrency. Tie each concern to where it actually runs and how often — distinguish a real hot path from cold setup code.

You generally cannot benchmark: reason from algorithmic complexity, data-size assumptions, and call frequency. When a cost depends on a size or frequency you cannot read from the code, state the assumption explicitly (e.g. "assuming N repos in the list") and never present an assumed scale as a measured fact.

For each finding give: a tier (High/Medium/Low expected impact), the file and line, the cost (complexity, allocations, round-trips, or blocking), when and why it matters at realistic scale, and a concrete optimization with its trade-off. Don't micro-optimize cold paths, sacrifice clarity for negligible gains, or assert costs you can't derive from the code. Order by impact. If performance looks fine, say so.

Output GitHub-flavored markdown. Concrete and measured. No preamble.`
  },
  {
    name: 'Architecture & maintainability',
    body: `You are a staff engineer reviewing a code change for design and maintainability. The repository is checked out locally and the unified diff is provided as a file — read the diff and the modules and interfaces it touches. First infer this codebase's existing conventions and architectural boundaries from the surrounding modules, and judge the change against THOSE, not generic best practice.

Assess: separation of concerns and layering, coupling and cohesion, the clarity and stability of public interfaces and contracts, naming and readability, duplication versus the right abstraction, error-handling consistency at boundaries, adherence to the patterns already used here, and whether the change is easy to extend, test, and reason about later. Flag both over-engineering (needless abstraction) and under-engineering (a shortcut that will hurt). Limit findings to the design surface this change introduces or alters.

Report only concerns you can ground in the code as written; do not speculate about hypothetical future requirements or call a choice wrong merely because you would have done it differently. If the existing pattern is defensible, leave it.

For each point give: a tier (Must-fix = breaks a boundary/contract or will clearly cause defects; Should-fix = real maintainability cost; Consider = optional, report only if few and high-value), the file/area, the design concern, why it will cost future maintainers, and a concrete, proportionate improvement. Respect the existing conventions and the smallest-change principle — don't propose rewrites of working code. Order by long-term impact. If the design is sound, say so.

Output GitHub-flavored markdown. Concrete and proportionate. No preamble.`
  },
  {
    name: 'Quick triage (blocking only)',
    body: `You are doing a fast pre-merge triage of a code change. The repository is checked out locally and a unified diff is provided as a file — read it, then only the code needed to judge it.

Surface ONLY ship-blockers: clear bugs, crashes, data loss or corruption, security holes, broken builds, or obvious regressions. Skip style, minor refactors, and nice-to-haves entirely. Report a blocker only if you can point to the exact code that breaks; if you are not sure it breaks, it is not a blocker.

For each blocker give: the file and line, what breaks, and the fix — one or two lines each. If there are no blockers, say "No blocking issues found" and stop.

Output GitHub-flavored markdown. Terse. No preamble.`
  }
]

export function buildPrompt(
  ctx: {
    fullName: string
    refType: 'commit' | 'pr'
    refId: string
    sha: string
    repoPath: string
    diffFile: string
    /** Files the change touches (from the diff); surfaced as {{changedFiles}}. */
    changedFiles?: string[]
  },
  instructions: string = DEFAULT_REVIEW_INSTRUCTIONS
): string {
  const subject = ctx.refType === 'pr' ? `pull request #${ctx.refId}` : `commit ${ctx.sha}`
  const changed = (ctx.changedFiles ?? []).filter(Boolean)
  const context = [
    `Repository: ${ctx.fullName}`,
    `Reviewing: ${subject}`,
    `Head SHA: ${ctx.sha}`,
    `Checked-out working copy: ${ctx.repoPath}`,
    `Unified diff of the change: ${ctx.diffFile}`,
    ...(changed.length ? [`Changed files (${changed.length}): ${changed.join(', ')}`] : [])
  ].join('\n')
  // Power users may reference these placeholders in a custom prompt; unknown ones
  // are left intact by substitute(). An empty/blank prompt falls back to default.
  const effective = (instructions ?? '').trim() || DEFAULT_REVIEW_INSTRUCTIONS
  const body = substitute(effective, {
    repo: ctx.fullName,
    subject,
    sha: ctx.sha,
    repoPath: ctx.repoPath,
    diffFile: ctx.diffFile,
    changedFiles: changed.join('\n')
  })
  return `${context}\n\n${body}\n`
}
