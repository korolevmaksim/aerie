import { existsSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { CHANNELS } from '../shared/channels'
import type {
  AccountSummary,
  AddAccountInput,
  AgentInfo,
  ApiResult,
  BranchSummary,
  CommitDetail,
  CommitSummary,
  Paginated,
  PrepareResult,
  OpenTarget,
  PostResult,
  PostRunParams,
  Preset,
  Prompt,
  PullRequestDetail,
  PullRequestSummary,
  RepoMapping,
  ReposResult,
  RunHistoryItem,
  RunRecord,
  SettingKey,
  StartRunParams,
  SystemInfo
} from '../shared/types'
import {
  getRunTranscript,
  killRun,
  listAgentInfos,
  listAllRunHistory,
  listRunRecords,
  readRunOutput,
  setAgentModel,
  setAgentReasoning,
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
  getCommit,
  getPullRequest,
  listBranches,
  listCommits,
  listPullRequests,
  listRepos,
  reposFromCache
} from './github'
import { clonePathFor, prepareCheckout } from './gitEngine'
import { isTrustedSender } from './security'
import { isValidId, isValidSha } from '../shared/validators'
import {
  deleteAccount,
  findAccountByLogin,
  getAccount,
  getSetting,
  setSetting,
  deletePreset,
  deletePrompt,
  getRepoById,
  getRun,
  hasActiveRun,
  insertAccount,
  insertPreset,
  insertPrompt,
  listAccounts,
  listPresets,
  listPrompts,
  type PresetRow,
  type PromptRow,
  setRepoClonePath,
  setRepoFavorite,
  setRepoLocalPath,
  setRepoUseLocalWorktree,
  setRunPostedUrl,
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

  ipcMain.handle(CHANNELS.runnerStart, (event, params: unknown): ApiResult<RunRecord> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    const p = params as Partial<StartRunParams>
    if (!p || typeof p !== 'object') return fail('Invalid run parameters.')
    if (!isValidId(p.accountId) || !isValidId(p.repoId)) return fail('Invalid account or repo id.')
    if (!isValidSha(p.sha)) return fail('Invalid SHA.')
    if (p.refType !== 'commit' && p.refType !== 'pr') return fail('Invalid ref type.')
    if (typeof p.refId !== 'string' || typeof p.agentId !== 'string')
      return fail('Invalid run parameters.')
    if (p.promptId !== undefined && p.promptId !== null && !isValidId(p.promptId)) {
      return fail('Invalid prompt id.')
    }
    // Only accept a well-formed GitHub login for the @-mention; anything else → none.
    p.authorLogin =
      typeof p.authorLogin === 'string' && isGithubLogin(p.authorLogin) ? p.authorLogin : null
    if (hasActiveRun(p.repoId, p.sha, p.agentId)) {
      return fail('A run for this commit and agent is already in progress.')
    }

    // Output and status now flow through the central run-events hub, which the
    // main process broadcasts to ALL windows (so a re-shown window keeps streaming)
    // and the tray subscribes to. No per-sender wiring here.
    try {
      return ok(startRun(p as StartRunParams))
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Failed to start run.')
    }
  })

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

  // The full console transcript (live for a running run, recorded for a finished
  // one) — for showing progress/logs incl. from History.
  ipcMain.handle(CHANNELS.runnerTranscript, (event, runId: unknown): ApiResult<string> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    if (!isValidId(runId)) return fail('Invalid run id.')
    const run = getRun(runId)
    if (!run) return fail('Run not found.')
    return ok(getRunTranscript(runId, run.output_path))
  })

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
        let url: string
        if (p.kind === 'commitComment') {
          if (!isValidSha(p.sha)) return fail('Invalid SHA.')
          url = await createCommitComment(accountId, repo.full_name, p.sha, body)
        } else if (p.kind === 'prComment') {
          if (typeof p.prNumber !== 'number' || !Number.isInteger(p.prNumber) || p.prNumber <= 0) {
            return fail('Invalid pull request number.')
          }
          url = await createPrComment(accountId, repo.full_name, p.prNumber, body)
        } else if (p.kind === 'issue') {
          const title = typeof p.title === 'string' ? p.title.trim() : ''
          if (!title) return fail('An issue title is required.')
          url = await createIssue(accountId, repo.full_name, title, body)
        } else {
          return fail('Unknown post kind.')
        }
        setRunPostedUrl(p.runId, url)
        return ok({ url })
      } catch (error) {
        return fail(describeAuthError(error))
      }
    }
  )

  // --- hardening: history & settings (Stage 7) -------------------------------

  ipcMain.handle(CHANNELS.runsListAll, (event): ApiResult<RunHistoryItem[]> => {
    if (!isTrustedSender(event)) return fail('Untrusted sender.')
    try {
      return ok(listAllRunHistory())
    } catch {
      return ok([])
    }
  })

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

/** Concise, token-free message for a git failure (tokens never appear in git output). */
function describeGitError(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Git operation failed.'
  return raw.split('\n')[0].slice(0, 300)
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
