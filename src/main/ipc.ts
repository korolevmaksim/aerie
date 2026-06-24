import { existsSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { CHANNELS } from '../shared/channels'
import type {
  AccountSummary,
  AddAccountInput,
  Agent,
  AgentCandidate,
  AgentInfo,
  ApiResult,
  BranchSummary,
  CommitDetail,
  CommitSummary,
  Paginated,
  PrepareResult,
  OpenTarget,
  PostRunGroupParams,
  PostResult,
  PostRunParams,
  Preset,
  Prompt,
  ConsensusParams,
  ConsensusResult,
  RunGroupReport,
  PipelineRunOutcome,
  PipelineWithRuns,
  PollerStatus,
  PullRequestDetail,
  PullRequestSummary,
  RefType,
  RepoMapping,
  ReposResult,
  ReviewHistoryItem,
  RunFinding,
  RunLocalStatus,
  RunRecord,
  SettingKey,
  StartBatchParams,
  StartBatchResult,
  StartRunParams,
  SystemInfo
} from '../shared/types'
import {
  aggregateRunFindings,
  approveAgentExec,
  cloneAgentToUser,
  deleteUserAgentById,
  discoverAgentModels,
  getAgentById,
  getRunGroupReport,
  getRunTranscript,
  killRun,
  listAgentInfos,
  listCandidates,
  listAllRunHistory,
  listRunFindings,
  listRunRecords,
  readRunOutput,
  saveUserAgent,
  setAgentModel,
  setAgentReasoning,
  setRunGroupLocalStatus,
  setRunLocalStatus,
  startBatch,
  startRun
} from './agentRunner'
import {
  decryptToken,
  describeAuthError,
  encryptToken,
  fetchRateLimit,
  validateToken
} from './auth'
import {
  createCommitComment,
  createIssue,
  createPrComment,
  getBranchHeadSha,
  getCommit,
  getPullRequest,
  listBranches,
  listCommits,
  listPullRequests,
  listRepos,
  pollCommitHead,
  reposFromCache
} from './github'
import { clonePathFor, headShaOf, prepareCheckout } from './gitEngine'
import { parsePipelineRow } from './pipelineEngineLogic'
import { buildEnginePorts } from './pipelineEngine'
import { planManualRun, toPipelineWithRuns, validateSaveRequest } from './pipelineIpc'
import { getPollerStatus } from './poller'
import { runPipelineForDelta } from './pipelines'
import { buildCommitDelta, DELTA_META } from './pollerLogic'
import { resolveRunPostTarget } from './postTarget'
import { redactText } from './redact'
import { isTrustedSender } from './security'
import { isValidId, isValidSha } from '../shared/validators'
import {
  deleteAccount,
  findAccountByLogin,
  getAccount,
  getSetting,
  setSetting,
  deletePipeline,
  deletePreset,
  deletePrompt,
  getPipelineRow,
  getRepoById,
  getRun,
  getRunGroup,
  hasActiveRun,
  insertAccount,
  insertPipeline,
  insertPreset,
  insertPrompt,
  listAccounts,
  listPipelineRows,
  listPipelineRunsForPipeline,
  listPresets,
  listPrompts,
  setPipelineEnabled,
  updatePipeline,
  type PresetRow,
  type PromptRow,
  setRepoClonePath,
  setRepoFavorite,
  setRepoLocalPath,
  setRepoUseLocalWorktree,
  setRunPostedUrl,
  setRunGroupPostedUrl,
  updateAccountToken,
  updatePrompt,
  type AccountRow,
  type RepoRow
} from './store'

function rowToSummary(row: AccountRow): AccountSummary {
  return {
    id: row.id,
    label: row.label,
    login: row.login,
    kind: row.kind,
    createdAt: row.created_at
  }
}

function ok<T>(value: T): ApiResult<T> {
  return { ok: true, value }
}

function fail(error: string): ApiResult<never> {
  return { ok: false, error }
}

const SEVERITY_VALUES = new Set<string>(['critical', 'high', 'medium', 'low', 'info'])
const RUN_LOCAL_STATUS_VALUES = new Set<RunLocalStatus>(['open', 'handled', 'verified'])

interface RunTarget {
  accountId: number
  repoId: number
  sha: string
  refType: RefType
  refId: string
  promptId?: number
  authorLogin: string | null
}

/**
 * Validate the SHARED fields of a run/batch request and resolve refs whose SHA is
 * main-owned (working-tree/project). Agent id(s) are validated by the caller.
 * Returns the normalized target or a typed error — used by both single and batch starts.
 */
async function resolveRunTarget(p: Partial<StartRunParams>): Promise<ApiResult<RunTarget>> {
  if (!p || typeof p !== 'object') return fail('Invalid run parameters.')
  if (!isValidId(p.accountId) || !isValidId(p.repoId)) return fail('Invalid account or repo id.')
  if (
    p.refType !== 'commit' &&
    p.refType !== 'pr' &&
    p.refType !== 'working-tree' &&
    p.refType !== 'project'
  ) {
    return fail('Invalid ref type.')
  }
  if (typeof p.refId !== 'string') return fail('Invalid run parameters.')
  if (p.promptId !== undefined && p.promptId !== null && !isValidId(p.promptId)) {
    return fail('Invalid prompt id.')
  }
  if (p.model !== undefined && typeof p.model !== 'string') {
    return fail('Invalid model.')
  }

  let sha = p.sha
  let refId = p.refId
  if (p.refType === 'working-tree') {
    if (p.refId !== 'working-tree' && p.refId !== 'staged')
      return fail('Invalid working-tree mode.')
    const repo = getRepoById(p.repoId)
    if (!repo) return fail('Repository not found.')
    if (!repo.user_local_path) {
      return fail('Map a local clone for this repository to review its working tree.')
    }
    try {
      sha = await headShaOf(repo.user_local_path)
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'Could not read the local clone HEAD.')
    }
  } else if (p.refType === 'project') {
    const repo = getRepoById(p.repoId)
    if (!repo) return fail('Repository not found.')
    const branch = (p.refId.trim() || repo.default_branch || '').trim()
    if (!branch) return fail('Repository has no default branch to review.')
    try {
      sha = await getBranchHeadSha(p.accountId, repo.full_name, branch)
      refId = branch
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'Could not resolve the project head.')
    }
  }
  if (!isValidSha(sha)) return fail('Invalid SHA.')

  const authorLogin =
    typeof p.authorLogin === 'string' && isGithubLogin(p.authorLogin) ? p.authorLogin : null
  return ok({
    accountId: p.accountId,
    repoId: p.repoId,
    sha,
    refType: p.refType,
    refId,
    promptId: p.promptId ?? undefined,
    authorLogin
  })
}

/**
 * Registers every renderer-facing handler. All GitHub/token work happens here in
 * the main process; the renderer only ever sees `AccountSummary` (never a token).
 * Every handler first verifies the call came from the app's own renderer frame.
 */
export function registerIpcHandlers(): void {
  ipcMain.handle(CHANNELS.ping, () => 'pong')

  ipcMain.handle(
    CHANNELS.accountsAdd,
    async (event, input: AddAccountInput): Promise<ApiResult<AccountSummary>> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      const label = input?.label?.trim()
      const token = input?.token?.trim()
      if (!label) return fail('A label is required.')
      if (!token) return fail('A token is required.')

      try {
        const identity = await validateToken(token)
        if (findAccountByLogin(identity.login)) {
          return fail(`Account "${identity.login}" is already added.`)
        }
        const row = insertAccount({
          label,
          login: identity.login,
          kind: identity.kind,
          tokenBlob: encryptToken(token),
          createdAt: new Date().toISOString()
        })
        return ok({ ...rowToSummary(row), rateLimit: identity.rateLimit })
      } catch (error) {
        return fail(describeAuthError(error))
      }
    }
  )

  ipcMain.handle(CHANNELS.accountsList, (event): AccountSummary[] => {
    if (!isTrustedSender(event)) return []
    try {
      return listAccounts().map(rowToSummary)
    } catch {
      return []
    }
  })

  ipcMain.handle(CHANNELS.accountsRemove, (event, id: unknown): ApiResult<true> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isValidId(id)) return fail('Invalid account id.')
    try {
      return deleteAccount(id) ? ok(true) : fail('Account not found.')
    } catch {
      return fail('Could not remove the account.')
    }
  })

  ipcMain.handle(
    CHANNELS.accountsRefresh,
    async (event, id: unknown): Promise<ApiResult<AccountSummary>> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      if (!isValidId(id)) return fail('Invalid account id.')
      const row = getAccount(id)
      if (!row) return fail('Account not found.')
      try {
        const identity = await validateToken(decryptToken(row.token_blob))
        return ok({ ...rowToSummary(row), rateLimit: identity.rateLimit })
      } catch (error) {
        return fail(describeAuthError(error))
      }
    }
  )

  // Quota-free rate read for auto-loading the display on panel mount. Unlike
  // `accounts:refresh` this skips the identity check (`users.getAuthenticated`),
  // so opening the panel costs ~0 core quota regardless of account count.
  ipcMain.handle(
    CHANNELS.accountsRateLimit,
    async (event, id: unknown): Promise<ApiResult<AccountSummary>> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      if (!isValidId(id)) return fail('Invalid account id.')
      const row = getAccount(id)
      if (!row) return fail('Account not found.')
      try {
        const rateLimit = await fetchRateLimit(decryptToken(row.token_blob))
        return ok({ ...rowToSummary(row), rateLimit })
      } catch (error) {
        return fail(describeAuthError(error))
      }
    }
  )

  ipcMain.handle(
    CHANNELS.accountsUpdateToken,
    async (event, id: unknown, token: unknown): Promise<ApiResult<AccountSummary>> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      if (!isValidId(id)) return fail('Invalid account id.')
      const t = typeof token === 'string' ? token.trim() : ''
      if (!t) return fail('A token is required.')
      const row = getAccount(id)
      if (!row) return fail('Account not found.')
      try {
        const identity = await validateToken(t)
        if (identity.login !== row.login) {
          return fail(`That token belongs to "${identity.login}", not "${row.login}".`)
        }
        updateAccountToken(id, encryptToken(t))
        return ok({ ...rowToSummary(getAccount(id)!), rateLimit: identity.rateLimit })
      } catch (error) {
        return fail(describeAuthError(error))
      }
    }
  )

  const handleReposList =
    (force: boolean) =>
    async (event: Electron.IpcMainInvokeEvent, id: unknown): Promise<ApiResult<ReposResult>> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      if (!isValidId(id)) return fail('Invalid account id.')
      try {
        return ok(await listRepos(id, { force }))
      } catch (error) {
        return fail(describeAuthError(error))
      }
    }

  ipcMain.handle(CHANNELS.reposList, handleReposList(false))
  ipcMain.handle(CHANNELS.reposRefresh, handleReposList(true))

  // Local-only favorite toggle (pins a repo to the top; not a GitHub star).
  // Returns the re-sorted cached list — no network call.
  ipcMain.handle(
    CHANNELS.reposSetFavorite,
    (event, repoId: unknown, value: unknown): ApiResult<ReposResult> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      if (!isValidId(repoId)) return fail('Invalid repository id.')
      const repo = getRepoById(repoId)
      if (!repo) return fail('Repository not found.')
      setRepoFavorite(repoId, value === true)
      return ok(reposFromCache(repo.account_id))
    }
  )

  // --- commit / PR drill-in (read-only) --------------------------------------

  ipcMain.handle(
    CHANNELS.repoBranches,
    guarded(
      (accountId: number, repoFullName: string): Promise<BranchSummary[]> =>
        listBranches(accountId, repoFullName)
    )
  )

  ipcMain.handle(
    CHANNELS.repoCommits,
    guarded(
      (
        accountId: number,
        repoFullName: string,
        opts: { branch?: string; page?: number }
      ): Promise<Paginated<CommitSummary>> => listCommits(accountId, repoFullName, opts ?? {})
    )
  )

  ipcMain.handle(
    CHANNELS.repoCommit,
    guarded(
      (accountId: number, repoFullName: string, sha: string): Promise<CommitDetail> =>
        getCommit(accountId, repoFullName, sha)
    )
  )

  ipcMain.handle(
    CHANNELS.repoPulls,
    guarded(
      (
        accountId: number,
        repoFullName: string,
        opts: { page?: number }
      ): Promise<Paginated<PullRequestSummary>> =>
        listPullRequests(accountId, repoFullName, opts ?? {})
    )
  )

  ipcMain.handle(
    CHANNELS.repoPull,
    guarded(
      (accountId: number, repoFullName: string, num: number): Promise<PullRequestDetail> =>
        getPullRequest(accountId, repoFullName, num)
    )
  )

  // --- repo mapping & git engine (Stage 4) -----------------------------------

  ipcMain.handle(CHANNELS.mappingGet, (event, repoId: unknown): ApiResult<RepoMapping> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isValidId(repoId)) return fail('Invalid repository id.')
    const row = getRepoById(repoId)
    return row ? ok(rowToMapping(row)) : fail('Repository not found.')
  })

  ipcMain.handle(
    CHANNELS.mappingPickLocal,
    async (event, repoId: unknown): Promise<ApiResult<RepoMapping>> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      if (!isValidId(repoId)) return fail('Invalid repository id.')
      const row = getRepoById(repoId)
      if (!row) return fail('Repository not found.')
      const win = BrowserWindow.fromWebContents(event.sender)
      const dialogOptions: Electron.OpenDialogOptions = {
        title: `Locate your local clone of ${row.full_name}`,
        properties: ['openDirectory']
      }
      const picked = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      if (picked.canceled || picked.filePaths.length === 0) return ok(rowToMapping(row))
      const chosen = picked.filePaths[0]
      if (!existsSync(join(chosen, '.git'))) {
        return fail('That folder is not a git repository (no .git found).')
      }
      setRepoLocalPath(repoId, chosen)
      return ok(rowToMapping(getRepoById(repoId)!))
    }
  )

  ipcMain.handle(CHANNELS.mappingClearLocal, (event, repoId: unknown): ApiResult<RepoMapping> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isValidId(repoId)) return fail('Invalid repository id.')
    if (!getRepoById(repoId)) return fail('Repository not found.')
    setRepoLocalPath(repoId, null)
    setRepoUseLocalWorktree(repoId, false) // can't use a local worktree without a path
    return ok(rowToMapping(getRepoById(repoId)!))
  })

  ipcMain.handle(
    CHANNELS.mappingSetUseLocal,
    (event, repoId: unknown, value: unknown): ApiResult<RepoMapping> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      if (!isValidId(repoId)) return fail('Invalid repository id.')
      const row = getRepoById(repoId)
      if (!row) return fail('Repository not found.')
      if (value === true && !row.user_local_path) {
        return fail('Set a local clone path before enabling read-only worktree mode.')
      }
      setRepoUseLocalWorktree(repoId, value === true)
      return ok(rowToMapping(getRepoById(repoId)!))
    }
  )

  ipcMain.handle(
    CHANNELS.gitPrepare,
    async (
      event,
      accountId: unknown,
      repoId: unknown,
      sha: unknown
    ): Promise<ApiResult<PrepareResult>> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      if (!isValidId(accountId)) return fail('Invalid account id.')
      if (!isValidId(repoId)) return fail('Invalid repository id.')
      if (!isValidSha(sha)) {
        return fail('Invalid commit SHA.')
      }
      const repo = getRepoById(repoId)
      if (!repo) return fail('Repository not found.')
      const account = getAccount(accountId)
      if (!account) return fail('Account not found.')
      if (!repo.remote_url) return fail('Repository has no remote URL.')
      try {
        const result = await prepareCheckout({
          fullName: repo.full_name,
          sha,
          remoteUrl: repo.remote_url,
          runTag: 'manual',
          token: decryptToken(account.token_blob),
          userLocalPath: repo.user_local_path,
          useLocalWorktree: repo.use_local_worktree === 1
        })
        if (result.mode === 'app-clone') setRepoClonePath(repoId, clonePathFor(repo.full_name))
        // baseDir is internal-only; the renderer gets the public PrepareResult.
        return ok({
          mode: result.mode,
          worktreePath: result.worktreePath,
          diffPath: result.diffPath
        })
      } catch (error) {
        return fail(describeGitError(error))
      }
    }
  )

  // --- agent runner (Stage 5) ------------------------------------------------

  ipcMain.handle(CHANNELS.runnerListAgents, (event): ApiResult<AgentInfo[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    return ok(listAgentInfos())
  })

  // Generic unknown-CLI candidates (M2): coding CLIs on PATH with no configured agent. Read-only
  // + inert — a candidate carries no runnable command; spawns nothing.
  ipcMain.handle(CHANNELS.runnerListCandidates, (event): ApiResult<AgentCandidate[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    return ok(listCandidates())
  })

  // Live model discovery (M2): runs each installed, author-shipped model-list probe,
  // caches the result, and returns the refreshed list. Spawns CLIs, so it's async.
  ipcMain.handle(CHANNELS.runnerDiscoverAgents, async (event): Promise<ApiResult<AgentInfo[]>> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    try {
      return ok(await discoverAgentModels())
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Model discovery failed.')
    }
  })

  // Exec-consent (M12): record the user's approval to run a user-authored agent's exact
  // current command. Main computes + persists the signature; the renderer can't fabricate
  // consent (it only names the id, and main re-derives the signature). No-op for shipped ids.
  ipcMain.handle(CHANNELS.runnerApproveAgent, (event, id: unknown): ApiResult<AgentInfo[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (typeof id !== 'string' || id.length === 0) return fail('Invalid agent id.')
    try {
      return ok(approveAgentExec(id))
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Could not approve the agent.')
    }
  })

  // In-app agent editor (M12). The full descriptor for editing/cloning (command/args/env
  // aren't secrets — the renderer is the app's own UI; the token is never in here).
  ipcMain.handle(CHANNELS.runnerGetAgent, (event, id: unknown): ApiResult<Agent | null> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (typeof id !== 'string' || id.length === 0) return fail('Invalid agent id.')
    try {
      return ok(getAgentById(id))
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Could not read the agent.')
    }
  })

  // Saves write ONLY the user slice; main validates the payload (isAgent + id rules) and
  // never lets a user shadow a shipped id. Anything saved still needs exec-consent before
  // it can run, so these are not an exec-bypass.
  ipcMain.handle(
    CHANNELS.runnerSaveAgent,
    (event, agent: unknown, editingId: unknown): ApiResult<AgentInfo[]> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      const edit = typeof editingId === 'string' && editingId.length > 0 ? editingId : undefined
      try {
        const res = saveUserAgent(agent, edit)
        return res.ok ? ok(res.agents) : fail(res.error)
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Could not save the agent.')
      }
    }
  )

  ipcMain.handle(CHANNELS.runnerDeleteAgent, (event, id: unknown): ApiResult<AgentInfo[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (typeof id !== 'string' || id.length === 0) return fail('Invalid agent id.')
    try {
      return ok(deleteUserAgentById(id))
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Could not delete the agent.')
    }
  })

  ipcMain.handle(
    CHANNELS.runnerCloneAgent,
    (event, sourceId: unknown, newId: unknown): ApiResult<AgentInfo[]> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      if (typeof sourceId !== 'string' || sourceId.length === 0) return fail('Invalid source id.')
      if (typeof newId !== 'string' || newId.length === 0) return fail('Invalid new id.')
      try {
        const res = cloneAgentToUser(sourceId, newId)
        return res.ok ? ok(res.agents) : fail(res.error)
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Could not clone the agent.')
      }
    }
  )

  ipcMain.handle(
    CHANNELS.runnerSetAgentModel,
    (event, agentId: unknown, model: unknown): ApiResult<AgentInfo[]> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      if (typeof agentId !== 'string' || typeof model !== 'string') {
        return fail('Invalid agent or model.')
      }
      setAgentModel(agentId, model)
      return ok(listAgentInfos())
    }
  )

  ipcMain.handle(
    CHANNELS.runnerSetAgentReasoning,
    (event, agentId: unknown, reasoning: unknown): ApiResult<AgentInfo[]> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      if (typeof agentId !== 'string' || typeof reasoning !== 'string') {
        return fail('Invalid agent or reasoning level.')
      }
      setAgentReasoning(agentId, reasoning)
      return ok(listAgentInfos())
    }
  )

  // --- review presets --------------------------------------------------------

  ipcMain.handle(CHANNELS.presetsList, (event): ApiResult<Preset[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    return ok(listPresets().map(rowToPreset))
  })

  ipcMain.handle(CHANNELS.presetsSave, (event, input: unknown): ApiResult<Preset[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    const p = input as Partial<Preset>
    const name = typeof p?.name === 'string' ? p.name.trim() : ''
    if (!name) return fail('A preset name is required.')
    if (typeof p.agentId !== 'string' || !p.agentId) return fail('An agent is required.')
    insertPreset({
      name,
      agentId: p.agentId,
      model: typeof p.model === 'string' ? p.model : '',
      reasoning: typeof p.reasoning === 'string' ? p.reasoning : '',
      createdAt: new Date().toISOString()
    })
    return ok(listPresets().map(rowToPreset))
  })

  ipcMain.handle(CHANNELS.presetsDelete, (event, id: unknown): ApiResult<Preset[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isValidId(id)) return fail('Invalid preset id.')
    deletePreset(id)
    return ok(listPresets().map(rowToPreset))
  })

  // --- review prompts (editable instructions) --------------------------------

  ipcMain.handle(CHANNELS.promptsList, (event): ApiResult<Prompt[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    return ok(listPrompts().map(rowToPrompt))
  })

  // Create (no id) or update (valid id) in one channel.
  ipcMain.handle(CHANNELS.promptsSave, (event, input: unknown): ApiResult<Prompt[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    const p = input as Partial<Prompt>
    const name = typeof p?.name === 'string' ? p.name.trim() : ''
    const body = typeof p?.body === 'string' ? p.body.trim() : ''
    if (!name) return fail('A prompt name is required.')
    if (!body) return fail('The prompt body is empty.')
    if (body.length > 20000) return fail('The prompt body is too long (max 20000 characters).')
    if (p.id !== undefined) {
      if (!isValidId(p.id)) return fail('Invalid prompt id.')
      if (!updatePrompt(p.id, { name, body })) return fail('Prompt not found.')
    } else {
      insertPrompt({ name, body, createdAt: new Date().toISOString() })
    }
    return ok(listPrompts().map(rowToPrompt))
  })

  ipcMain.handle(CHANNELS.promptsDelete, (event, id: unknown): ApiResult<Prompt[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isValidId(id)) return fail('Invalid prompt id.')
    // Keep at least one prompt so the run screen always has a selectable default.
    if (listPrompts().length <= 1) return fail('At least one prompt must remain.')
    deletePrompt(id)
    return ok(listPrompts().map(rowToPrompt))
  })

  ipcMain.handle(
    CHANNELS.runnerStart,
    async (event, params: unknown): Promise<ApiResult<RunRecord>> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      const p = params as Partial<StartRunParams>
      if (typeof p?.agentId !== 'string') return fail('Invalid run parameters.')
      const target = await resolveRunTarget(p)
      if (!target.ok) return target
      const t = target.value
      // Dedup on the resolved HEAD + agent; for working-tree also on the mode (refId),
      // since 'working-tree' and 'staged' share a HEAD but review different diffs.
      if (hasActiveRun(t.repoId, t.refType, t.refId, t.sha, p.agentId)) {
        const subject =
          t.refType === 'working-tree'
            ? 'working-tree review'
            : t.refType === 'project'
              ? 'project review'
              : t.refType === 'pr'
                ? 'pull request'
                : 'commit'
        return fail(`A run for this ${subject} and agent is already in progress.`)
      }
      // Output and status flow through the central run-events hub (broadcast to all
      // windows + the tray); no per-sender wiring here.
      try {
        return ok(startRun({ ...t, agentId: p.agentId, model: p.model }))
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Failed to start run.')
      }
    }
  )

  // Multi-agent fan-out (M8/M9): start one review across several agents on the same ref.
  ipcMain.handle(
    CHANNELS.runnerStartBatch,
    async (event, params: unknown): Promise<ApiResult<StartBatchResult>> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      const p = params as Partial<StartBatchParams>
      if (
        !Array.isArray(p?.agentIds) ||
        p.agentIds.length === 0 ||
        !p.agentIds.every((a) => typeof a === 'string')
      ) {
        return fail('Select at least one agent.')
      }
      const target = await resolveRunTarget(p as Partial<StartRunParams>)
      if (!target.ok) return target
      try {
        return ok(startBatch({ ...target.value, agentIds: p.agentIds }))
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Failed to start the review.')
      }
    }
  )

  ipcMain.handle(CHANNELS.runnerKill, (event, runId: unknown): ApiResult<true> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isValidId(runId)) return fail('Invalid run id.')
    return killRun(runId) ? ok(true) : fail('Run is not active.')
  })

  ipcMain.handle(CHANNELS.runnerListRuns, (event, repoId: unknown): ApiResult<RunRecord[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isValidId(repoId)) return fail('Invalid repository id.')
    try {
      return ok(listRunRecords(repoId))
    } catch {
      return ok([])
    }
  })

  // Reads a finished run's captured output (the clean review) for posting.
  ipcMain.handle(CHANNELS.runnerReadOutput, (event, runId: unknown): ApiResult<string> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isValidId(runId)) return fail('Invalid run id.')
    const run = getRun(runId)
    if (!run) return fail('Run not found.')
    return ok(run.output_path ? readRunOutput(run.output_path) : '')
  })

  // A run's persisted structured findings (tool output or an agent's findings block).
  ipcMain.handle(CHANNELS.runnerFindings, (event, runId: unknown): ApiResult<RunFinding[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isValidId(runId)) return fail('Invalid run id.')
    try {
      return ok(listRunFindings(runId))
    } catch {
      return ok([])
    }
  })

  // Cross-agent consensus: aggregate findings across a panel's runs (M8/M9).
  ipcMain.handle(CHANNELS.runnerConsensus, (event, params: unknown): ApiResult<ConsensusResult> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    const p = params as Partial<ConsensusParams>
    if (!Array.isArray(p?.runIds) || p.runIds.length === 0 || !p.runIds.every(isValidId)) {
      return fail('Invalid run ids.')
    }
    const consensusMin =
      typeof p.consensusMin === 'number' && Number.isInteger(p.consensusMin) && p.consensusMin >= 1
        ? p.consensusMin
        : 1
    // Consensus defaults to 'location' (the robust cross-agent mode); the aggregator's own
    // default is 'issue' (for the M6 grounding caller). The renderer always sends 'location'.
    const groupBy = p.groupBy === 'issue' ? 'issue' : 'location'
    const minSeverity = SEVERITY_VALUES.has(p.minSeverity as string) ? p.minSeverity : undefined
    try {
      return ok(aggregateRunFindings({ runIds: p.runIds, consensusMin, minSeverity, groupBy }))
    } catch {
      return ok({ findings: [], total: 0 })
    }
  })

  ipcMain.handle(
    CHANNELS.runnerGroupReport,
    (event, params: unknown): ApiResult<RunGroupReport> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      const p = params as { groupId?: unknown; consensusMin?: unknown }
      if (!isValidId(p?.groupId)) return fail('Invalid panel review id.')
      const consensusMin =
        typeof p.consensusMin === 'number' &&
        Number.isInteger(p.consensusMin) &&
        p.consensusMin >= 1
          ? p.consensusMin
          : 2
      try {
        return ok(getRunGroupReport(p.groupId, consensusMin))
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Could not build panel report.')
      }
    }
  )

  // The full console transcript (live for a running run, recorded for a finished
  // one) — for showing progress/logs incl. from History.
  ipcMain.handle(CHANNELS.runnerTranscript, (event, runId: unknown): ApiResult<string> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isValidId(runId)) return fail('Invalid run id.')
    const run = getRun(runId)
    if (!run) return fail('Run not found.')
    return ok(getRunTranscript(runId, run.output_path))
  })

  ipcMain.handle(CHANNELS.runnerSetLocalStatus, (event, params: unknown): ApiResult<RunRecord> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    const p = params as { runId?: unknown; localStatus?: unknown }
    if (!isValidId(p?.runId)) return fail('Invalid run id.')
    if (
      typeof p.localStatus !== 'string' ||
      !RUN_LOCAL_STATUS_VALUES.has(p.localStatus as RunLocalStatus)
    ) {
      return fail('Invalid local run status.')
    }
    try {
      return ok(setRunLocalStatus(p.runId, p.localStatus as RunLocalStatus))
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Failed to update run status.')
    }
  })

  ipcMain.handle(
    CHANNELS.runnerSetGroupLocalStatus,
    (event, params: unknown): ApiResult<RunGroupReport> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      const p = params as { groupId?: unknown; localStatus?: unknown }
      if (!isValidId(p?.groupId)) return fail('Invalid panel review id.')
      if (
        typeof p.localStatus !== 'string' ||
        !RUN_LOCAL_STATUS_VALUES.has(p.localStatus as RunLocalStatus)
      ) {
        return fail('Invalid local panel status.')
      }
      try {
        setRunGroupLocalStatus(p.groupId, p.localStatus as RunLocalStatus)
        return ok(getRunGroupReport(p.groupId))
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Failed to update panel status.')
      }
    }
  )

  // --- post results to GitHub (Stage 6) — write, gated by the in-app confirm --
  // The explicit confirmation is a renderer-side contract (PostConfirmModal):
  // this channel must only be called after the user confirms. Any new caller of
  // runner.post MUST go through that modal. Main validates and bounds the
  // request but does not re-prompt.

  ipcMain.handle(
    CHANNELS.githubPost,
    async (event, params: unknown): Promise<ApiResult<PostResult>> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      const p = params as Partial<PostRunParams>
      if (!p || typeof p !== 'object') return fail('Invalid post parameters.')
      if (!isValidId(p.runId) || !isValidId(p.repoId)) {
        return fail('Invalid run or repo id.')
      }
      const body = typeof p.body === 'string' ? p.body.trim() : ''
      if (!body) return fail('The comment body is empty.')
      if (body.length > 65536) return fail('The comment body is too long (max 65536 characters).')

      const repo = getRepoById(p.repoId)
      if (!repo) return fail('Repository not found.')
      // The posting account is the repo's owning account (so History can post too).
      const accountId = repo.account_id
      if (!getAccount(accountId)) return fail('Account not found.')
      // Integrity: the run must belong to the target repo.
      const run = getRun(p.runId)
      if (!run || run.repo_id !== p.repoId) return fail('Run does not belong to that repository.')

      try {
        const target = resolveRunPostTarget(run, { kind: p.kind, title: p.title })
        if (!target.ok) return fail(target.error)

        let url: string
        if (target.target.kind === 'commitComment') {
          url = await createCommitComment(accountId, repo.full_name, target.target.sha, body)
        } else if (target.target.kind === 'prComment') {
          url = await createPrComment(accountId, repo.full_name, target.target.prNumber, body)
        } else {
          url = await createIssue(accountId, repo.full_name, target.target.title, body)
        }
        setRunPostedUrl(p.runId, url)
        return ok({ url })
      } catch (error) {
        return fail(describeAuthError(error))
      }
    }
  )

  ipcMain.handle(
    CHANNELS.githubPostGroup,
    async (event, params: unknown): Promise<ApiResult<PostResult>> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      const p = params as Partial<PostRunGroupParams>
      if (!p || typeof p !== 'object') return fail('Invalid post parameters.')
      if (!isValidId(p.groupId) || !isValidId(p.repoId)) {
        return fail('Invalid panel review or repo id.')
      }
      const body = typeof p.body === 'string' ? p.body.trim() : ''
      if (!body) return fail('The comment body is empty.')
      if (body.length > 65536) return fail('The comment body is too long (max 65536 characters).')

      const repo = getRepoById(p.repoId)
      if (!repo) return fail('Repository not found.')
      const accountId = repo.account_id
      if (!getAccount(accountId)) return fail('Account not found.')
      const groupRow = getRunGroup(p.groupId)
      if (!groupRow || groupRow.repo_id !== p.repoId) {
        return fail('Panel review does not belong to that repository.')
      }

      try {
        const report = getRunGroupReport(p.groupId)
        const target = resolveRunPostTarget(
          {
            ref_type: report.group.refType,
            ref_id: report.group.refId,
            head_sha: report.group.headSha,
            status: report.group.status
          },
          { kind: p.kind, title: p.title }
        )
        if (!target.ok) return fail(target.error)

        let url: string
        if (target.target.kind === 'commitComment') {
          url = await createCommitComment(accountId, repo.full_name, target.target.sha, body)
        } else if (target.target.kind === 'prComment') {
          url = await createPrComment(accountId, repo.full_name, target.target.prNumber, body)
        } else {
          url = await createIssue(accountId, repo.full_name, target.target.title, body)
        }
        setRunGroupPostedUrl(p.groupId, url)
        return ok({ url })
      } catch (error) {
        return fail(describeAuthError(error))
      }
    }
  )

  // --- hardening: history & settings (Stage 7) -------------------------------

  ipcMain.handle(CHANNELS.runsListAll, (event): ApiResult<ReviewHistoryItem[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    try {
      return ok(listAllRunHistory())
    } catch {
      return ok([])
    }
  })

  // --- automation pipelines (M9a). Config CRUD only; the poller picks up changes on its
  //     next tick (it reloads the enabled set each cycle). Every GitHub write still goes
  //     through the engine's auto-post gate — these handlers never write to GitHub.
  // Read-only poller liveness for the Automate view (M14). No token/secret in the payload.
  ipcMain.handle(CHANNELS.pipelinesPollerStatus, (event): ApiResult<PollerStatus> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    return ok(getPollerStatus())
  })

  ipcMain.handle(CHANNELS.pipelinesList, (event): ApiResult<PipelineWithRuns[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    try {
      const items = listPipelineRows()
        .map((row) =>
          toPipelineWithRuns(
            row,
            listPipelineRunsForPipeline(row.id, 20),
            getRepoById(row.repo_id)?.full_name ?? null
          )
        )
        .filter((x): x is PipelineWithRuns => x !== null)
      return ok(items)
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Could not list pipelines.')
    }
  })

  ipcMain.handle(CHANNELS.pipelinesSave, (event, input: unknown): ApiResult<PipelineWithRuns> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    const parsed = validateSaveRequest(input)
    if (!parsed.ok) return fail(parsed.error)
    // The repo must be one the user has added (its account is the only one authorized to act
    // on it); this also prevents pointing a pipeline at an unknown/foreign repo id.
    if (!getRepoById(parsed.value.draft.repoId)) return fail('Unknown repository.')
    try {
      const now = new Date().toISOString()
      let row
      if (parsed.value.id === null) {
        row = insertPipeline(parsed.value.draft, now)
      } else {
        if (!updatePipeline(parsed.value.id, parsed.value.draft, now)) {
          return fail('Pipeline not found.')
        }
        row = getPipelineRow(parsed.value.id)!
      }
      const item = toPipelineWithRuns(
        row,
        listPipelineRunsForPipeline(row.id, 20),
        getRepoById(row.repo_id)?.full_name ?? null
      )
      return item ? ok(item) : fail('Saved pipeline could not be loaded.')
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Could not save the pipeline.')
    }
  })

  ipcMain.handle(CHANNELS.pipelinesDelete, (event, id: unknown): ApiResult<true> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isValidId(id)) return fail('Invalid pipeline id.')
    try {
      return deletePipeline(id) ? ok(true) : fail('Pipeline not found.')
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Could not delete the pipeline.')
    }
  })

  ipcMain.handle(
    CHANNELS.pipelinesSetEnabled,
    (event, id: unknown, enabled: unknown): ApiResult<true> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      if (!isValidId(id)) return fail('Invalid pipeline id.')
      if (typeof enabled !== 'boolean') return fail('Invalid enabled flag.')
      try {
        return setPipelineEnabled(id, enabled) ? ok(true) : fail('Pipeline not found.')
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Could not update the pipeline.')
      }
    }
  )

  // run-now / dry-run: run one pass of a pipeline against its repo's CURRENT default-branch
  // head, resolved here in main (the renderer supplies only the pipeline id — never a repo/sha).
  // run-now goes through the same gate (an enabled-post pipeline MAY post per its opt-in);
  // dry-run forces no GitHub write regardless of auto_post (engine `dryRun`: action autoPost
  // off → effectiveAction can never be 'post' → the write branch is unreachable).
  const runPipelineHandler =
    (dryRun: boolean) =>
    async (
      event: Electron.IpcMainInvokeEvent,
      id: unknown
    ): Promise<ApiResult<PipelineRunOutcome>> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      if (!isValidId(id)) return fail('Invalid pipeline id.')
      const row = getPipelineRow(id)
      if (!row) return fail('Pipeline not found.')
      const pipeline = parsePipelineRow(row)
      if (!pipeline) return fail('Pipeline configuration is invalid.')
      const plan = planManualRun(pipeline, getRepoById(pipeline.repoId))
      if (!plan.ok) return fail(plan.error)
      const engine = buildEnginePorts()
      try {
        const head = await pollCommitHead(
          plan.spec.accountId,
          plan.spec.repoId,
          plan.spec.repoFullName,
          plan.spec.ref
        )
        if (!head.headSha) return fail('Could not resolve the branch head.')
        const delta = buildCommitDelta(plan.spec, head.headSha, DELTA_META)
        const outcome = await runPipelineForDelta(pipeline, delta, engine.ports, {
          manual: true,
          dryRun
        })
        return ok(outcome)
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Pipeline run failed.')
      } finally {
        engine.dispose()
      }
    }

  ipcMain.handle(CHANNELS.pipelinesRunNow, runPipelineHandler(false))
  ipcMain.handle(CHANNELS.pipelinesDryRun, runPipelineHandler(true))

  ipcMain.handle(CHANNELS.systemInfo, (event): ApiResult<SystemInfo> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    const userDataPath = app.getPath('userData')
    return ok({
      version: app.getVersion(),
      userDataPath,
      agentsPath: join(userDataPath, 'agents.json'),
      logsPath: join(userDataPath, 'logs'),
      dbPath: join(userDataPath, 'aerie.db')
    })
  })

  ipcMain.handle(
    CHANNELS.systemOpenPath,
    async (event, which: unknown): Promise<ApiResult<true>> => {
      if (!isTrustedSender(event)) return fail('Untrusted sender.')
      const userDataPath = app.getPath('userData')
      const targets: Record<OpenTarget, string> = {
        userData: userDataPath,
        agents: join(userDataPath, 'agents.json'),
        logs: join(userDataPath, 'logs')
      }
      // Guard against inherited keys (e.g. "constructor") slipping past the lookup.
      if (typeof which !== 'string' || !Object.prototype.hasOwnProperty.call(targets, which)) {
        return fail('Unknown target.')
      }
      await shell.openPath(targets[which as OpenTarget])
      return ok(true)
    }
  )

  // --- UI settings (close-to-tray, finish notifications) ---------------------
  // Boolean-only, stored as '1'/'0' in the existing key/value settings table. The
  // renderer may only touch this hardcoded allowlist of keys — never an arbitrary
  // settings key (which would expose, e.g., per-agent model state). Defaults are
  // ON for the two behavior toggles and OFF for the one-time hint flag.
  ipcMain.handle(CHANNELS.settingsGet, (event, key: unknown): ApiResult<boolean> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isAllowedSettingKey(key)) return fail('Unknown setting.')
    const value = getSetting(key)
    return ok(value === undefined ? UI_SETTING_DEFAULTS[key] : value === '1')
  })

  ipcMain.handle(CHANNELS.settingsSet, (event, key: unknown, value: unknown): ApiResult<true> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isAllowedSettingKey(key)) return fail('Unknown setting.')
    if (typeof value !== 'boolean') return fail('A boolean value is required.')
    setSetting(key, value ? '1' : '0')
    return ok(true)
  })
}

/** The renderer-writable settings keys and their default (when unset) values. */
const UI_SETTING_DEFAULTS: Record<SettingKey, boolean> = {
  'ui.closeToTray': true,
  'ui.notifyOnFinish': true,
  'ui.closeToTrayHintShown': false,
  'ui.groundReviews': true
}

/** Prototype-safe membership test for the settings allowlist (guards 'constructor' etc.). */
function isAllowedSettingKey(key: unknown): key is SettingKey {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(UI_SETTING_DEFAULTS, key)
}

function rowToPreset(row: PresetRow): Preset {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    model: row.model,
    reasoning: row.reasoning
  }
}

function rowToPrompt(row: PromptRow): Prompt {
  return { id: row.id, name: row.name, body: row.body }
}

/** A syntactically valid GitHub username (1–39 chars, alphanumeric or single hyphens). */
function isGithubLogin(value: string): boolean {
  return /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/.test(value)
}

function rowToMapping(row: RepoRow): RepoMapping {
  return {
    repoId: row.id,
    fullName: row.full_name,
    remoteUrl: row.remote_url,
    userLocalPath: row.user_local_path,
    appClonePath: row.app_clone_path,
    useLocalWorktree: row.use_local_worktree === 1
  }
}

/** Concise, token-free message for a git failure. */
function describeGitError(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Git operation failed.'
  return redactText(raw).split('\n')[0].slice(0, 300)
}

/**
 * Wraps a read-only repo handler with the standard trust + input checks and
 * ApiResult error discipline. The first two args are always (accountId,
 * repoFullName); the rest are passed through.
 */
function guarded<A extends unknown[], R>(
  fn: (accountId: number, repoFullName: string, ...rest: A) => Promise<R>
) {
  return async (
    event: Electron.IpcMainInvokeEvent,
    accountId: unknown,
    repoFullName: unknown,
    ...rest: A
  ): Promise<ApiResult<R>> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isValidId(accountId)) return fail('Invalid account id.')
    if (typeof repoFullName !== 'string' || !repoFullName.includes('/')) {
      return fail('Invalid repository name.')
    }
    try {
      return ok(await fn(accountId, repoFullName, ...rest))
    } catch (error) {
      return fail(describeAuthError(error))
    }
  }
}
