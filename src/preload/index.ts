import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS } from '../shared/channels'
import type {
  Agent,
  AccountSummary,
  AddAccountInput,
  AgentCandidate,
  AgentInfo,
  ApiResult,
  BranchSummary,
  CommitDetail,
  CommitSummary,
  Paginated,
  OpenTarget,
  PostResult,
  PostRunParams,
  PrepareResult,
  PipelineRunChange,
  PipelineRunOutcome,
  PipelineWithRuns,
  Preset,
  Prompt,
  PullRequestDetail,
  PullRequestSummary,
  RepoMapping,
  SavePipelineRequest,
  ReposResult,
  ConsensusParams,
  ConsensusResult,
  RunFinding,
  RunHistoryItem,
  RunOutputChunk,
  RunRecord,
  RunStatusUpdate,
  SettingKey,
  StartBatchParams,
  StartBatchResult,
  StartRunParams,
  SystemInfo,
  TrayOpenRun
} from '../shared/types'

/**
 * Aerie's typed bridge surface. This is the ONLY way the renderer talks to the
 * main process (SPEC §4). It is intentionally small and explicit — every method
 * maps to a single named IPC channel. No Node APIs and no tokens ever cross this
 * boundary back to the renderer. The preload runs sandboxed (`sandbox: true`),
 * so it may only use `electron` (contextBridge/ipcRenderer) and the polyfilled
 * `process`.
 */
const api = {
  /** Health check that proves the renderer → main IPC seam is wired. */
  ping: (): Promise<string> => ipcRenderer.invoke(CHANNELS.ping),

  /** Multi-account auth. Tokens are sent in only on `add`; nothing returns one. */
  accounts: {
    add: (input: AddAccountInput): Promise<ApiResult<AccountSummary>> =>
      ipcRenderer.invoke(CHANNELS.accountsAdd, input),
    list: (): Promise<AccountSummary[]> => ipcRenderer.invoke(CHANNELS.accountsList),
    remove: (id: number): Promise<ApiResult<true>> =>
      ipcRenderer.invoke(CHANNELS.accountsRemove, id),
    refresh: (id: number): Promise<ApiResult<AccountSummary>> =>
      ipcRenderer.invoke(CHANNELS.accountsRefresh, id),
    /** Quota-free rate-limit read (no identity check) for auto-load on mount. */
    rateLimit: (id: number): Promise<ApiResult<AccountSummary>> =>
      ipcRenderer.invoke(CHANNELS.accountsRateLimit, id),
    updateToken: (id: number, token: string): Promise<ApiResult<AccountSummary>> =>
      ipcRenderer.invoke(CHANNELS.accountsUpdateToken, id, token)
  },

  /** Repository browsing for an account (cached + ETag-aware). */
  repos: {
    list: (accountId: number): Promise<ApiResult<ReposResult>> =>
      ipcRenderer.invoke(CHANNELS.reposList, accountId),
    refresh: (accountId: number): Promise<ApiResult<ReposResult>> =>
      ipcRenderer.invoke(CHANNELS.reposRefresh, accountId),
    /** Toggle a repo's local favorite (pins to top); returns the re-sorted list. */
    setFavorite: (repoId: number, value: boolean): Promise<ApiResult<ReposResult>> =>
      ipcRenderer.invoke(CHANNELS.reposSetFavorite, repoId, value)
  },

  /** Read-only commit / PR drill-in for a single repo (Stage 3). */
  repo: {
    branches: (accountId: number, fullName: string): Promise<ApiResult<BranchSummary[]>> =>
      ipcRenderer.invoke(CHANNELS.repoBranches, accountId, fullName),
    commits: (
      accountId: number,
      fullName: string,
      opts: { branch?: string; page?: number }
    ): Promise<ApiResult<Paginated<CommitSummary>>> =>
      ipcRenderer.invoke(CHANNELS.repoCommits, accountId, fullName, opts),
    commit: (accountId: number, fullName: string, sha: string): Promise<ApiResult<CommitDetail>> =>
      ipcRenderer.invoke(CHANNELS.repoCommit, accountId, fullName, sha),
    pulls: (
      accountId: number,
      fullName: string,
      opts: { page?: number }
    ): Promise<ApiResult<Paginated<PullRequestSummary>>> =>
      ipcRenderer.invoke(CHANNELS.repoPulls, accountId, fullName, opts),
    pull: (
      accountId: number,
      fullName: string,
      num: number
    ): Promise<ApiResult<PullRequestDetail>> =>
      ipcRenderer.invoke(CHANNELS.repoPull, accountId, fullName, num)
  },

  /** Repo mapping + git engine (Stage 4): app-owned clones, worktrees, diffs. */
  mapping: {
    get: (repoId: number): Promise<ApiResult<RepoMapping>> =>
      ipcRenderer.invoke(CHANNELS.mappingGet, repoId),
    pickLocal: (repoId: number): Promise<ApiResult<RepoMapping>> =>
      ipcRenderer.invoke(CHANNELS.mappingPickLocal, repoId),
    clearLocal: (repoId: number): Promise<ApiResult<RepoMapping>> =>
      ipcRenderer.invoke(CHANNELS.mappingClearLocal, repoId),
    setUseLocal: (repoId: number, value: boolean): Promise<ApiResult<RepoMapping>> =>
      ipcRenderer.invoke(CHANNELS.mappingSetUseLocal, repoId, value)
  },
  git: {
    prepare: (accountId: number, repoId: number, sha: string): Promise<ApiResult<PrepareResult>> =>
      ipcRenderer.invoke(CHANNELS.gitPrepare, accountId, repoId, sha)
  },

  /** Agent runner (Stage 5): start a run, stream its output, kill, list history. */
  runner: {
    listAgents: (): Promise<ApiResult<AgentInfo[]>> =>
      ipcRenderer.invoke(CHANNELS.runnerListAgents),
    // Detected coding CLIs with no configured agent (M2) — inert, never runnable.
    listCandidates: (): Promise<ApiResult<AgentCandidate[]>> =>
      ipcRenderer.invoke(CHANNELS.runnerListCandidates),
    discoverAgents: (): Promise<ApiResult<AgentInfo[]>> =>
      ipcRenderer.invoke(CHANNELS.runnerDiscoverAgents),
    approveAgent: (id: string): Promise<ApiResult<AgentInfo[]>> =>
      ipcRenderer.invoke(CHANNELS.runnerApproveAgent, id),
    // Agent editor (M12). `agent` is an Agent-shaped object; main validates it.
    getAgent: (id: string): Promise<ApiResult<Agent | null>> =>
      ipcRenderer.invoke(CHANNELS.runnerGetAgent, id),
    saveAgent: (agent: Agent, editingId?: string): Promise<ApiResult<AgentInfo[]>> =>
      ipcRenderer.invoke(CHANNELS.runnerSaveAgent, agent, editingId),
    deleteAgent: (id: string): Promise<ApiResult<AgentInfo[]>> =>
      ipcRenderer.invoke(CHANNELS.runnerDeleteAgent, id),
    cloneAgent: (sourceId: string, newId: string): Promise<ApiResult<AgentInfo[]>> =>
      ipcRenderer.invoke(CHANNELS.runnerCloneAgent, sourceId, newId),
    setAgentModel: (agentId: string, model: string): Promise<ApiResult<AgentInfo[]>> =>
      ipcRenderer.invoke(CHANNELS.runnerSetAgentModel, agentId, model),
    setAgentReasoning: (agentId: string, reasoning: string): Promise<ApiResult<AgentInfo[]>> =>
      ipcRenderer.invoke(CHANNELS.runnerSetAgentReasoning, agentId, reasoning),
    start: (params: StartRunParams): Promise<ApiResult<RunRecord>> =>
      ipcRenderer.invoke(CHANNELS.runnerStart, params),
    startBatch: (params: StartBatchParams): Promise<ApiResult<StartBatchResult>> =>
      ipcRenderer.invoke(CHANNELS.runnerStartBatch, params),
    kill: (runId: number): Promise<ApiResult<true>> =>
      ipcRenderer.invoke(CHANNELS.runnerKill, runId),
    listRuns: (repoId: number): Promise<ApiResult<RunRecord[]>> =>
      ipcRenderer.invoke(CHANNELS.runnerListRuns, repoId),
    listAllRuns: (): Promise<ApiResult<RunHistoryItem[]>> =>
      ipcRenderer.invoke(CHANNELS.runsListAll),
    readOutput: (runId: number): Promise<ApiResult<string>> =>
      ipcRenderer.invoke(CHANNELS.runnerReadOutput, runId),
    findings: (runId: number): Promise<ApiResult<RunFinding[]>> =>
      ipcRenderer.invoke(CHANNELS.runnerFindings, runId),
    consensus: (params: ConsensusParams): Promise<ApiResult<ConsensusResult>> =>
      ipcRenderer.invoke(CHANNELS.runnerConsensus, params),
    transcript: (runId: number): Promise<ApiResult<string>> =>
      ipcRenderer.invoke(CHANNELS.runnerTranscript, runId),
    /** Post a finished run's output to GitHub. Gated by the in-app confirm UI. */
    post: (params: PostRunParams): Promise<ApiResult<PostResult>> =>
      ipcRenderer.invoke(CHANNELS.githubPost, params),
    onOutput: (cb: (payload: RunOutputChunk) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: RunOutputChunk): void => cb(payload)
      ipcRenderer.on(CHANNELS.runnerOutput, listener)
      return () => ipcRenderer.removeListener(CHANNELS.runnerOutput, listener)
    },
    onStatus: (cb: (payload: RunStatusUpdate) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: RunStatusUpdate): void => cb(payload)
      ipcRenderer.on(CHANNELS.runnerStatus, listener)
      return () => ipcRenderer.removeListener(CHANNELS.runnerStatus, listener)
    }
  },

  /** Saved review presets (agent + model + reasoning bundles). */
  presets: {
    list: (): Promise<ApiResult<Preset[]>> => ipcRenderer.invoke(CHANNELS.presetsList),
    save: (input: {
      name: string
      agentId: string
      model: string
      reasoning: string
    }): Promise<ApiResult<Preset[]>> => ipcRenderer.invoke(CHANNELS.presetsSave, input),
    delete: (id: number): Promise<ApiResult<Preset[]>> =>
      ipcRenderer.invoke(CHANNELS.presetsDelete, id)
  },

  /** Editable review prompts (the instruction half), selectable on the run screen. */
  prompts: {
    list: (): Promise<ApiResult<Prompt[]>> => ipcRenderer.invoke(CHANNELS.promptsList),
    /** Create (omit id) or update (with id) a prompt; returns the new list. */
    save: (input: { id?: number; name: string; body: string }): Promise<ApiResult<Prompt[]>> =>
      ipcRenderer.invoke(CHANNELS.promptsSave, input),
    delete: (id: number): Promise<ApiResult<Prompt[]>> =>
      ipcRenderer.invoke(CHANNELS.promptsDelete, id)
  },

  /** Automation pipelines (ROADMAP M9a). Config CRUD; the poller runs them. Never writes
   *  to GitHub directly — every write goes through the engine's per-pipeline auto-post gate. */
  pipelines: {
    list: (): Promise<ApiResult<PipelineWithRuns[]>> => ipcRenderer.invoke(CHANNELS.pipelinesList),
    /** Create (id omitted/null) or update (with id) a pipeline; returns the saved item. */
    save: (req: SavePipelineRequest): Promise<ApiResult<PipelineWithRuns>> =>
      ipcRenderer.invoke(CHANNELS.pipelinesSave, req),
    delete: (id: number): Promise<ApiResult<true>> =>
      ipcRenderer.invoke(CHANNELS.pipelinesDelete, id),
    setEnabled: (id: number, enabled: boolean): Promise<ApiResult<true>> =>
      ipcRenderer.invoke(CHANNELS.pipelinesSetEnabled, id, enabled),
    /** Run one pass now against the repo's current head. May post per the pipeline's opt-in. */
    runNow: (id: number): Promise<ApiResult<PipelineRunOutcome>> =>
      ipcRenderer.invoke(CHANNELS.pipelinesRunNow, id),
    /** Like runNow but NEVER writes to GitHub, regardless of the auto-post opt-in. */
    dryRun: (id: number): Promise<ApiResult<PipelineRunOutcome>> =>
      ipcRenderer.invoke(CHANNELS.pipelinesDryRun, id),
    /** Live pipeline-run status changes (insert / status / posted). Returns an unsubscribe fn. */
    onStatus: (cb: (change: PipelineRunChange) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, change: PipelineRunChange): void => cb(change)
      ipcRenderer.on(CHANNELS.pipelineStatus, listener)
      return () => ipcRenderer.removeListener(CHANNELS.pipelineStatus, listener)
    }
  },

  /** App info + opening data locations (Stage 7 settings). */
  system: {
    info: (): Promise<ApiResult<SystemInfo>> => ipcRenderer.invoke(CHANNELS.systemInfo),
    openPath: (which: OpenTarget): Promise<ApiResult<true>> =>
      ipcRenderer.invoke(CHANNELS.systemOpenPath, which)
  },

  /** UI behavior toggles (close-to-tray, finish notifications). Booleans only. */
  settings: {
    get: (key: SettingKey): Promise<ApiResult<boolean>> =>
      ipcRenderer.invoke(CHANNELS.settingsGet, key),
    set: (key: SettingKey, value: boolean): Promise<ApiResult<true>> =>
      ipcRenderer.invoke(CHANNELS.settingsSet, key, value)
  },

  /** Main → renderer: the tray (or a finish notification) asks the UI to open a run. */
  onTrayOpenRun: (cb: (payload: TrayOpenRun) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: TrayOpenRun): void => cb(payload)
    ipcRenderer.on(CHANNELS.trayOpenRun, listener)
    return () => ipcRenderer.removeListener(CHANNELS.trayOpenRun, listener)
  }
} as const

export type AerieApi = typeof api

// contextIsolation is enforced true in the main process, so exposeInMainWorld is
// always the path taken. The guard keeps us safe if that ever regresses.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('aerie', api)
  } catch (error) {
    console.error('Failed to expose Aerie preload API:', error)
  }
} else {
  // @ts-ignore — fallback only; should never run under our security config.
  window.aerie = api
}
