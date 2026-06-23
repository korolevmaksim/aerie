// Shared types for the typed IPC surface. Imported by main, preload, and the
// renderer. Keep this free of runtime imports — types only — so it is safe to
// pull into every process.

export interface RateLimitInfo {
  /** Total requests allowed in the current window. */
  limit: number
  /** Requests remaining in the current window. */
  remaining: number
  /** Unix epoch (seconds) when the window resets. */
  reset: number
}

/**
 * Read-only liveness snapshot of the automation poller (ROADMAP M14), surfaced in the Automate
 * view so the user can trust automation is alive. Carries no token/secret — only timing + the
 * last-seen public rate budget.
 */
export interface PollerStatus {
  /** Whether the poll loop is running (it runs while the app is open). */
  running: boolean
  /** ISO timestamp of the last actual GitHub poll, or null if none yet this session. */
  lastPolledAt: string | null
  /** ISO timestamp of the next scheduled tick, or null when not running. */
  nextPollAt: string | null
  /** Last-seen GitHub primary rate budget (either number may be null until first observed). */
  rate: { remaining: number | null; limit: number | null } | null
}

export type AccountKind = 'user' | 'org'

/**
 * Renderer-safe view of an account. Deliberately omits the token — the raw or
 * encrypted token never crosses the IPC boundary into the renderer (SPEC §4).
 */
export interface AccountSummary {
  id: number
  label: string
  login: string
  kind: AccountKind
  createdAt: string
  /** Present only after a live validate/refresh against GitHub. */
  rateLimit?: RateLimitInfo
}

export interface AddAccountInput {
  /** Human label for the account (e.g. "work", "personal"). */
  label: string
  /** GitHub Personal Access Token (classic or fine-grained). */
  token: string
}

/**
 * Discriminated result returned across IPC for fallible operations, so the
 * renderer receives typed failures instead of opaque thrown errors.
 */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Renderer-safe view of a repository (Stage 2). */
export interface RepoSummary {
  id: number
  fullName: string
  defaultBranch: string | null
  remoteUrl: string | null
  htmlUrl: string | null
  isPrivate: boolean
  pushedAt: string | null
  /** Local-only favorite (pins to the top of the list; not a GitHub star). */
  isFavorite: boolean
}

export interface ReposResult {
  repos: RepoSummary[]
  /** True when served unchanged from the local cache (ETag 304 — ~0 rate cost). */
  fromCache: boolean
}

// --- commit / PR drill-in (Stage 3) ------------------------------------------

export interface BranchSummary {
  name: string
  commitSha: string
}

export interface CommitSummary {
  sha: string
  /** Full commit message (UI shows the first line as the title). */
  message: string
  authorName: string | null
  authorLogin: string | null
  authoredAt: string | null
}

export interface CommitFile {
  filename: string
  status: string
  additions: number
  deletions: number
  /** Unified-diff hunk for this file; null for binary/too-large files. */
  patch: string | null
  previousFilename: string | null
}

export interface CommitDetail extends CommitSummary {
  htmlUrl: string | null
  stats: { additions: number; deletions: number; total: number } | null
  files: CommitFile[]
}

export interface PullRequestSummary {
  number: number
  title: string
  state: string
  authorLogin: string | null
  createdAt: string | null
  headRef: string
  baseRef: string
  htmlUrl: string | null
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string | null
  commits: CommitSummary[]
}

/** Page of results plus whether GitHub reports a next page (Link header). */
export interface Paginated<T> {
  items: T[]
  page: number
  hasMore: boolean
  /** True when served unchanged from the local cache (ETag 304 — ~0 rate cost). */
  fromCache?: boolean
}

/**
 * Result of a cheap conditional head-probe of a watched ref (M8 polling foundation).
 * `changed` is true only when the current head SHA differs from the watch's last-seen
 * SHA; `fromCache` marks a free 304 hit; `rate`/`nextPollDelayMs` pace the next poll.
 */
export interface PollResult {
  headSha: string | null
  lastSeenSha: string | null
  changed: boolean
  fromCache: boolean
  rate: { remaining: number | null; limit: number | null; resetAt: number | null }
  nextPollDelayMs: number
}

// --- automation pipelines (ROADMAP M9a) --------------------------------------
// A pipeline is a configurable `trigger → scope filter → steps → aggregate → action`
// automation. Persisted per repo; the engine/poller (later M9a slices) execute it.
// SPEC §10: no real-time webhooks (pipelines are user-run or scheduled), every GitHub
// write stays behind the explicit confirm, and auto-post is a hard per-pipeline opt-in.

export type PipelineTrigger = 'commit' | 'pr' | 'schedule' | 'manual'

/** What the pipeline does with the aggregated result. `post` is gated by `autoPost`. */
export type PipelineActionKind = 'notify' | 'stage' | 'post'

/** Where an enabled auto-post lands (only consulted for an enabled `post`). */
export type PostTarget = 'commit' | 'pr' | 'issue'

export interface PipelineStep {
  /** Stable id within the pipeline (for `dependsOn` references + run correlation). */
  id: string
  kind: 'agent' | 'tool'
  /** The agent id (`kind:'agent'`) or quality-tool id (`kind:'tool'`) to run. */
  ref: string
  /** Optional model override for an agent step. */
  model?: string
  /** Step ids this one waits for; empty/absent = runs in the first wave. */
  dependsOn?: string[]
}

/** Trigger-scoping filter — a delta must pass ALL provided predicates to run. */
export interface PipelineScope {
  /** Allowed branch names (commit trigger) — empty/absent = any branch. */
  branches?: string[]
  /** PR labels — empty/absent = any; otherwise the PR must carry at least one. */
  labels?: string[]
  /** Allowed commit/PR author logins — empty/absent = any. */
  authors?: string[]
  /** Changed-path prefixes that must be touched — empty/absent = any. */
  paths?: string[]
  /** Draft-PR handling (pr trigger): absent/true = include; set `false` to exclude. */
  includeDrafts?: boolean
  /** Skip a push landing more than N commits at once (noise guard). 0/absent = no cap. */
  maxCommits?: number
}

export interface PipelineAction {
  kind: PipelineActionKind
  /**
   * HARD per-pipeline opt-in for auto-posting to GitHub (SPEC §10). The engine may
   * reach a write API ONLY when `kind==='post'` AND `autoPost===true`. Defaults false;
   * an unset/false flag can NEVER post (defense-in-depth assertion in the engine — a
   * disabled `post` degrades to `stage`, holding the result for the manual confirm).
   */
  autoPost: boolean
  /** Where an enabled post lands. */
  target?: PostTarget
}

export interface PipelineGuardrails {
  /** Cap on concurrent runs this pipeline starts (bounded again by the global semaphore). */
  maxConcurrentRuns?: number
  /** Minimum seconds between two runs for the same repo. */
  perRepoCooldownSeconds?: number
  /** Cap on runs started per rolling hour. */
  maxRunsPerHour?: number
}

/** The authored pipeline config (everything except the DB-assigned id). */
export interface PipelineDraft {
  name: string
  repoId: number
  trigger: PipelineTrigger
  /** Cron-ish schedule for `trigger==='schedule'`, interpreted by the poller. */
  schedule?: string
  enabled: boolean
  scope: PipelineScope
  steps: PipelineStep[]
  action: PipelineAction
  guardrails: PipelineGuardrails
}

/** A persisted pipeline (config + its DB id). */
export interface Pipeline extends PipelineDraft {
  id: number
}

export type PipelineRunStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'

export interface PipelineRunSummary {
  id: number
  pipelineId: number
  trigger: PipelineTrigger
  refType: RefType
  ref: string
  headSha: string
  status: PipelineRunStatus
  /** The action actually taken (a disabled `post` resolves to `stage`). */
  action: PipelineActionKind
  /** True only when this run actually wrote to GitHub (an enabled auto-post). */
  posted: boolean
  dedupeKey: string
  startedAt: string
  finishedAt: string | null
}

/** A pipeline plus its recent run history (the `pipelines:list` item). */
export interface PipelineWithRuns {
  pipeline: Pipeline
  /** The pipeline repo's `owner/name` for display, or null if the repo is gone. */
  repoFullName: string | null
  runs: PipelineRunSummary[]
}

/** A live pipeline-run status change pushed to the renderer (`pipeline:status`). Token-free. */
export interface PipelineRunChange {
  pipelineId: number
  pipelineRunId: number
  status: PipelineRunStatus
  /** The action this run takes (notify/stage/post). */
  action: PipelineActionKind
  /** True once the run actually wrote to GitHub. */
  posted: boolean
}

/** The outcome of running one pipeline once (engine result; also the run-now/dry-run reply). */
export type PipelineRunOutcome =
  | {
      ran: false
      reason: 'scope' | 'invalid' | 'no-steps' | 'guardrail' | 'dedupe' | 'error'
      detail?: string
    }
  | {
      ran: true
      pipelineRunId: number
      action: PipelineActionKind
      posted: boolean
      findings: number
    }

/** The `pipelines:save` request: a validated draft, with an `id` to update or null to insert. */
export interface SavePipelineRequest {
  id?: number | null
  draft: PipelineDraft
}

// --- repo mapping & git engine (Stage 4) -------------------------------------

export interface RepoMapping {
  repoId: number
  fullName: string
  remoteUrl: string | null
  userLocalPath: string | null
  appClonePath: string | null
  /** Opt-in: run agents off the user's local clone (read-only). Default OFF. */
  useLocalWorktree: boolean
}

export type PrepareMode = 'app-clone' | 'user-worktree' | 'working-tree'

export interface PrepareResult {
  mode: PrepareMode
  worktreePath: string
  diffPath: string
}

// --- agent runner (Stage 5) --------------------------------------------------

export type RunStatus = 'queued' | 'running' | 'done' | 'error' | 'killed'

/**
 * What a run reviews. 'commit'/'pr' come from GitHub; 'working-tree' reviews the
 * uncommitted changes in the user's mapped local clone (read-only, zero GitHub
 * calls); 'project' reviews a whole repository snapshot from an app-owned checkout.
 * For a working-tree run, `refId` selects the diff: 'working-tree' = all uncommitted
 * tracked changes (`git diff HEAD`), 'staged' = `git diff --staged`. For a project
 * run, `refId` is the branch/ref name whose HEAD snapshot is audited.
 */
export type RefType = 'commit' | 'pr' | 'working-tree' | 'project'

/** The two working-tree review modes, used as `refId` when refType is 'working-tree'. */
export type WorkingTreeMode = 'working-tree' | 'staged'

/**
 * Live model-list discovery descriptor (M2): a non-interactive probe to enumerate the
 * models an agent CLI offers. `lines` = one model id per line (e.g. `opencode models`).
 */
export type ModelDiscovery = { kind: 'command'; argv: string[]; format: 'lines' }

/**
 * The editable agent contract (SPEC §7). An agent is an external CLI: `command` + `args`
 * are spawned, `{{placeholder}}` tokens are substituted, and the review is captured from
 * stdout or a file. Shared so the in-app editor (renderer) and the runner (main) agree on
 * the shape. (Defined here, re-exported from `main/agentConfig` for existing imports.)
 */
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
  /** Exit codes that mean the run SUCCEEDED (findings may be present). Defaults to [0]. */
  successExitCodes?: number[]
  /** Optional live model-list discovery (M2); overlays the static `models` seed. */
  modelDiscovery?: ModelDiscovery
}

/** Renderer-facing agent identity (the full config, incl. command/env, stays in main). */
export interface AgentInfo {
  id: string
  label: string
  /** Currently selected model. */
  model: string
  /** Selectable models for this agent. */
  models: string[]
  /** Where `models` came from: the static seed, or live discovery (M2). */
  modelsSource: 'static' | 'discovered'
  /** Currently selected reasoning/thinking level (empty if the CLI has none). */
  reasoning: string
  /** Selectable reasoning levels (empty if the CLI exposes no reasoning control). */
  reasoningLevels: string[]
  /** Whether the agent's CLI is installed on this machine (autodiscovery). */
  available: boolean
  /** Absolute path where the CLI was found on PATH, or null if not installed. */
  path: string | null
  /**
   * True when this is a user-authored/edited agent whose command has NOT been approved
   * to run (M12 exec-consent). Such an agent is refused at the spawn boundary until the
   * user explicitly approves it. Always false for author-shipped templates/catalog.
   */
  needsConsent: boolean
  /** True when this is a user agent (in the editable user slice) — the editor can edit/delete it. */
  editable: boolean
}

/**
 * A coding-agent CLI detected on PATH that Aerie has NO configured agent for (ROADMAP M2,
 * comprehensive autodiscovery). It is an informational "you could wire this" hint, NOT a
 * runnable agent: it carries no command template, is never spawned, and the user must
 * explicitly create + consent an agent before anything runs. Surfacing it is what keeps
 * autodiscovery from rotting — a newly-installed coding CLI shows up even before Aerie ships
 * a template for it.
 */
export interface AgentCandidate {
  /** The binary name found on PATH (e.g. 'aider'). */
  command: string
  /** Display name (e.g. 'Aider'). */
  label: string
  /** Absolute path where the binary was found on PATH. */
  path: string
}

/** A saved review preset: a quick agent + model + reasoning bundle. */
export interface Preset {
  id: number
  name: string
  agentId: string
  model: string
  reasoning: string
}

/** An editable, selectable review prompt — the INSTRUCTION half of the prompt. */
export interface Prompt {
  id: number
  name: string
  body: string
}

export interface StartRunParams {
  accountId: number
  repoId: number
  sha: string
  refType: RefType
  /** Commit SHA, PR number, WorkingTreeMode, or project branch/ref name. */
  refId: string
  agentId: string
  /** Selected review prompt; falls back to the built-in default when absent. */
  promptId?: number
  /** GitHub login of the commit/PR author, so a posted comment can @-mention them. */
  authorLogin?: string | null
}

/**
 * Launch one review across SEVERAL agents on the same ref (multi-agent fan-out). Same
 * shape as a single run but with `agentIds` instead of `agentId`; each eligible agent
 * starts as its own correlated run (per-agent default model/reasoning).
 */
export interface StartBatchParams {
  accountId: number
  repoId: number
  sha: string
  refType: RefType
  refId: string
  agentIds: string[]
  promptId?: number
  authorLogin?: string | null
}

/** Result of a fan-out: the runs that started, and any requested agents that didn't. */
export interface StartBatchResult {
  runs: RunRecord[]
  skipped: { id: string; reason: 'not-eligible' | 'over-cap' | 'already-running' }[]
}

/** A normalized finding persisted for a run (tool output or an agent's findings block). */
export interface RunFinding {
  /** The tool/agent that produced it (e.g. 'eslint', 'codex'). */
  tool: string
  ruleId: string | null
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  file: string
  line: number | null
  message: string
}

/** A finding aggregated across a panel of runs, tagged with how many sources agreed. */
export interface ConsensusFinding extends RunFinding {
  /** Distinct agents/tools that flagged this (by location or issue, per `groupBy`). */
  agreement: number
}

/** Request to aggregate findings across several runs (cross-agent consensus). */
export interface ConsensusParams {
  runIds: number[]
  /** Keep only issues ≥ this many distinct sources agree on. Default 1. */
  consensusMin?: number
  minSeverity?: RunFinding['severity']
  /** 'location' (file+line) is the robust cross-agent mode; 'issue' also matches message. */
  groupBy?: 'issue' | 'location'
}

export interface ConsensusResult {
  findings: ConsensusFinding[]
  /** Total raw findings across the runs, before aggregation. */
  total: number
}

export interface RunRecord {
  id: number
  repoId: number
  refType: RefType
  refId: string
  headSha: string
  agentId: string
  status: RunStatus
  exitCode: number | null
  startedAt: string
  finishedAt: string | null
  outputPath: string | null
  postedUrl: string | null
  /** GitHub login of the reviewed commit/PR author (for @-mention on post). */
  authorLogin: string | null
}

/** A live chunk of agent output streamed to the renderer. */
export interface RunOutputChunk {
  runId: number
  stream: 'stdout' | 'stderr' | 'system'
  chunk: string
}

export interface RunStatusUpdate {
  runId: number
  status: RunStatus
  exitCode?: number | null
  outputPath?: string | null
}

/**
 * Main → renderer push: the tray (or a finish notification) asks the UI to open a
 * specific run. The renderer switches to History and selects that run.
 */
export interface TrayOpenRun {
  runId: number
}

/**
 * The only settings keys the renderer may read or write through the typed bridge.
 * Backed by the key/value `settings` table in the main-process store; main owns
 * the privileged behavior these gate (close-to-tray, finish notifications).
 */
export type SettingKey =
  | 'ui.closeToTray'
  | 'ui.notifyOnFinish'
  | 'ui.closeToTrayHintShown'
  | 'ui.groundReviews'

// --- posting results to GitHub (Stage 6) -------------------------------------

export type PostKind = 'commitComment' | 'prComment' | 'issue'

export interface PostRunParams {
  runId: number
  /** Optional — the posting account is derived from the repo's owning account. */
  accountId?: number
  repoId: number
  kind: PostKind
  body: string
  /** Required for commitComment. */
  sha?: string
  /** Required for prComment. */
  prNumber?: number
  /** Required for issue. */
  title?: string
}

export interface PostResult {
  url: string
}

// --- hardening: history & settings (Stage 7) ---------------------------------

export interface RunHistoryItem extends RunRecord {
  repoFullName: string
  /** Owning account, derived from the run's repo — lets History scope per account. */
  accountId: number
}

export interface SystemInfo {
  version: string
  userDataPath: string
  agentsPath: string
  logsPath: string
  dbPath: string
}

export type OpenTarget = 'userData' | 'agents' | 'logs'
