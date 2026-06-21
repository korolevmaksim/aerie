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

export type PrepareMode = 'app-clone' | 'user-worktree'

export interface PrepareResult {
  mode: PrepareMode
  worktreePath: string
  diffPath: string
}

// --- agent runner (Stage 5) --------------------------------------------------

export type RunStatus = 'queued' | 'running' | 'done' | 'error' | 'killed'

/** Renderer-facing agent identity (the full config, incl. command/env, stays in main). */
export interface AgentInfo {
  id: string
  label: string
  /** Currently selected model. */
  model: string
  /** Selectable models for this agent. */
  models: string[]
  /** Currently selected reasoning/thinking level (empty if the CLI has none). */
  reasoning: string
  /** Selectable reasoning levels (empty if the CLI exposes no reasoning control). */
  reasoningLevels: string[]
  /** Whether the agent's CLI is installed on this machine (autodiscovery). */
  available: boolean
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
  refType: 'commit' | 'pr'
  /** Commit SHA or PR number (as a string). */
  refId: string
  agentId: string
  /** Selected review prompt; falls back to the built-in default when absent. */
  promptId?: number
  /** GitHub login of the commit/PR author, so a posted comment can @-mention them. */
  authorLogin?: string | null
}

export interface RunRecord {
  id: number
  repoId: number
  refType: 'commit' | 'pr'
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
export type SettingKey = 'ui.closeToTray' | 'ui.notifyOnFinish' | 'ui.closeToTrayHintShown'

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
}

export interface SystemInfo {
  version: string
  userDataPath: string
  agentsPath: string
  logsPath: string
  dbPath: string
}

export type OpenTarget = 'userData' | 'agents' | 'logs'
