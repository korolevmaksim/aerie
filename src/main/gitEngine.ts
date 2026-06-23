import { join } from 'path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { app } from 'electron'
import simpleGit, { type SimpleGit } from 'simple-git'
import type { PrepareMode, PrepareResult } from '../shared/types'
import { reviewDiffArgs } from './gitDiff'
import { createKeyedMutex } from './keyedMutex'

// Serializes ALL writes to an app-owned clone (fetch / clone / PR-head fetch / worktree add+remove)
// per clone, so concurrent reviews on the SAME repo never race on its ref store (different repos
// run in parallel). NOTE: cleanupCheckout's worktree-remove keys off baseDir, which equals the
// clonePath in app-clone mode — keep that equality so cleanup serializes against worktree adds.
const cloneMutex = createKeyedMutex()

// Kill a git child that produces NO output for this long — a stuck network fetch/clone must not
// hold a clone's mutex (and its run slot) forever, blocking every future review of that repo.
const GIT_BLOCK_TIMEOUT_MS = 120_000

/**
 * Git engine (SPEC §5/§6). Drives the system `git` through simple-git. App-owned
 * clones live under <userData>/clones/<owner>/<repo>; the target SHA is checked
 * out into an isolated detached worktree under <userData>/worktrees/...; a diff
 * file is generated for the agent.
 *
 * The user's own working copies are never touched in the default (app-clone)
 * mode. An opt-in read-only mode runs a worktree off the user's local clone.
 *
 * Token handling (SPEC §4): the GitHub token is injected ONLY into the child git
 * process environment via git's config-env vars (http.extraHeader). It is never
 * written into .git/config, never passed as a command-line arg (so it can't show
 * up in `ps`), and never logged.
 */

function dataDir(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}

function splitFullName(fullName: string): { owner: string; name: string } {
  const slash = fullName.indexOf('/')
  const owner = slash > 0 ? fullName.slice(0, slash) : ''
  const name = slash > 0 ? fullName.slice(slash + 1) : ''
  // Repo identifiers from GitHub are a safe charset; reject anything that could
  // escape the data dir.
  if (!owner || !name || /[/\\]|\.\./.test(`${owner}/${name}`.replace('/', ''))) {
    throw new Error('Invalid repository name.')
  }
  return { owner, name }
}

export function clonePathFor(fullName: string): string {
  const { owner, name } = splitFullName(fullName)
  return dataDir('clones', owner, name)
}

// Per-run worktree dir: a run owns its own directory so concurrent runs on the
// same SHA never share (and destroy) one another's checkout.
function worktreePathFor(fullName: string, sha: string, runTag: string): string {
  const { owner, name } = splitFullName(fullName)
  return dataDir('worktrees', owner, name, `${sha.slice(0, 12)}-${runTag}`)
}

const UNSAFE_INHERITED_GIT_ENV = new Set(['EDITOR', 'PAGER', 'PREFIX', 'SSH_ASKPASS'])

function isUnsafeInheritedGitEnv(key: string): boolean {
  const upper = key.toUpperCase()
  return upper.startsWith('GIT_') || UNSAFE_INHERITED_GIT_ENV.has(upper)
}

/** Builds a git child-process env that authenticates without persisting the token. */
export function authEnv(token?: string): NodeJS.ProcessEnv {
  // Strip inherited git process controls (PAGER, GIT_EDITOR, config paths, etc.) that
  // simple-git blocks or that could change checkout behavior; then set only the git
  // vars Aerie owns. Keeps PATH/HOME/proxy settings intact.
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!isUnsafeInheritedGitEnv(key)) env[key] = value
  }
  env.GIT_TERMINAL_PROMPT = '0'
  if (token) {
    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader'
    env.GIT_CONFIG_VALUE_0 = header
  }
  return env
}

/**
 * A simple-git instance authenticated for network ops. The token is supplied via
 * git config-env (http.extraHeader). simple-git blocks GIT_CONFIG_COUNT by
 * default; we opt in with `allowUnsafeConfigEnvCount` because the injected config
 * is OUR own controlled token (not untrusted user input), and http.extraHeader
 * is not a command-execution vector.
 */
function authedGit(baseDir: string | undefined, token?: string): SimpleGit {
  const options = {
    unsafe: { allowUnsafeConfigEnvCount: true },
    timeout: { block: GIT_BLOCK_TIMEOUT_MS }
  }
  const git = baseDir ? simpleGit(baseDir, options) : simpleGit(options)
  return git.env(authEnv(token))
}

/** A local (no-auth) git instance with the same hung-process timeout — for pack-refs / worktree. */
function localGit(baseDir: string): SimpleGit {
  return simpleGit(baseDir, { timeout: { block: GIT_BLOCK_TIMEOUT_MS } }).env(authEnv())
}

/**
 * Ensures an app-owned clone exists at the target SHA's repo and is up to date.
 * Clones if absent, otherwise fetches. Returns the clone path.
 */
// NOTE: must be called INSIDE `cloneMutex.run(clonePath, …)` (it mutates the shared clone's refs).
async function ensureClone(fullName: string, remoteUrl: string, token?: string): Promise<string> {
  const clonePath = clonePathFor(fullName)
  if (existsSync(join(clonePath, '.git'))) {
    await fetchWithRefRecovery(clonePath, ['--prune', '--tags', 'origin'], token)
  } else {
    mkdirSync(clonePath, { recursive: true })
    await authedGit(undefined, token).clone(remoteUrl, clonePath)
  }
  return clonePath
}

/**
 * Run a git fetch, healing a stale ref store on failure. A loose-vs-packed ref inconsistency (left
 * by a past interrupted/killed or concurrent fetch, especially when the remote force-updated refs)
 * makes git reject the ref transaction with "incorrect old value provided". `pack-refs --all`
 * reconciles the loose and packed stores (the live ref value wins); retry the fetch once before
 * propagating. Caller serializes per clone (see `cloneMutex`).
 */
async function fetchWithRefRecovery(
  clonePath: string,
  fetchArgs: string[],
  token?: string
): Promise<void> {
  try {
    await authedGit(clonePath, token).fetch(fetchArgs)
  } catch {
    await localGit(clonePath)
      .raw(['pack-refs', '--all'])
      .catch(() => undefined)
    await authedGit(clonePath, token).fetch(fetchArgs)
  }
}

async function addDetachedWorktree(
  git: SimpleGit,
  worktreePath: string,
  sha: string
): Promise<void> {
  // Recreate the worktree clean each run so it is fully isolated.
  if (existsSync(worktreePath)) {
    await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => undefined)
  }
  await git.raw(['worktree', 'prune'])
  mkdirSync(join(worktreePath, '..'), { recursive: true })
  await git.raw(['worktree', 'add', '--detach', '--force', worktreePath, sha])
}

/**
 * Checks the target SHA out into a clean isolated worktree.
 * - default: off the app-owned clone (clones/fetches as needed)
 * - opt-in: off the user's local clone (read-only intent; no fetch)
 */
export async function checkoutWorktree(args: {
  fullName: string
  sha: string
  remoteUrl: string
  runTag: string
  token?: string
  userLocalPath?: string | null
  useLocalWorktree?: boolean
}): Promise<{ mode: PrepareMode; baseDir: string; worktreePath: string }> {
  const worktreePath = worktreePathFor(args.fullName, args.sha, args.runTag)

  if (args.useLocalWorktree && args.userLocalPath) {
    if (!existsSync(join(args.userLocalPath, '.git'))) {
      throw new Error('Mapped local path is not a git repository.')
    }
    const git = localGit(args.userLocalPath)
    await addDetachedWorktree(git, worktreePath, args.sha)
    return { mode: 'user-worktree', baseDir: args.userLocalPath, worktreePath }
  }

  const clonePath = clonePathFor(args.fullName)
  // Serialize the WHOLE app-clone path per clone: ensureClone's fetch, the PR-head fetch, and the
  // worktree add/remove all mutate the shared clone's ref store — a second concurrent review on
  // the same repo must wait, not race (the "incorrect old value provided" race). Different repos
  // (different clonePath) still run in parallel.
  return cloneMutex.run(clonePath, async () => {
    await ensureClone(args.fullName, args.remoteUrl, args.token)
    const git = authedGit(clonePath, args.token)
    try {
      await addDetachedWorktree(git, worktreePath, args.sha)
    } catch {
      // The SHA may not be on a fetched branch (e.g. a PR head) — fetch it directly (best-effort,
      // with the same ref-store recovery), then retry the worktree add.
      await fetchWithRefRecovery(clonePath, ['origin', args.sha], args.token).catch(() => undefined)
      await addDetachedWorktree(git, worktreePath, args.sha)
    }
    return { mode: 'app-clone' as const, baseDir: clonePath, worktreePath }
  })
}

/** Diffs a commit against its first parent; full patch for a root commit. */
async function diffAgainstFirstParent(git: SimpleGit, sha: string): Promise<string> {
  const hasParent = await git
    .raw(['rev-parse', '--verify', '--quiet', `${sha}^`])
    .then(() => true)
    .catch(() => false)
  return hasParent ? git.raw(reviewDiffArgs(sha)) : git.raw(['show', '--format=', sha])
}

/**
 * Generates the review unified diff and writes it to a file. Returns the path.
 * - PR runs (`baseSha` set): the WHOLE PR via a three-dot `base...head` diff
 *   (changes since the merge-base), not just the head commit.
 * - Commit runs: the commit vs its first parent.
 * Falls back to the first-parent diff if the base is unreachable in the clone.
 */
export async function writeCommitDiff(
  baseDir: string,
  fullName: string,
  sha: string,
  runTag: string,
  baseSha?: string | null
): Promise<string> {
  const git = localGit(baseDir)
  let diff: string
  if (baseSha) {
    diff = await git.raw(reviewDiffArgs(sha, baseSha)).catch(() => diffAgainstFirstParent(git, sha))
  } else {
    diff = await diffAgainstFirstParent(git, sha)
  }
  const { owner, name } = splitFullName(fullName)
  const diffDir = dataDir('diffs')
  mkdirSync(diffDir, { recursive: true })
  const diffPath = join(diffDir, `${owner}-${name}-${sha.slice(0, 12)}-${runTag}.diff`)
  writeFileSync(diffPath, diff, 'utf8')
  return diffPath
}

/**
 * Resolves the HEAD commit SHA of a local clone (read-only `rev-parse`; no fetch,
 * no checkout, no mutation). Used by working-tree runs to record the commit the
 * uncommitted changes sit on. Throws if the path is not a git repo or HEAD is
 * unborn (a repo with no commits yet).
 */
export async function headShaOf(localPath: string): Promise<string> {
  if (!existsSync(join(localPath, '.git'))) {
    throw new Error('Mapped local path is not a git repository.')
  }
  const sha = (await localGit(localPath).revparse(['HEAD'])).trim()
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error('Could not resolve the local clone HEAD (no commits yet?).')
  }
  return sha
}

/**
 * Prepares a working-tree review (M7): writes a diff of the UNCOMMITTED changes in
 * the user's mapped clone to a file. Creates NO worktree and NEVER mutates the
 * working copy — only read-only `git diff` runs. The agent later runs with
 * cwd = the user's clone (uncommitted changes exist only there), zero GitHub calls.
 *   - staged=false → `git diff HEAD`    (all uncommitted tracked changes)
 *   - staged=true  → `git diff --staged` (only what is staged for the next commit)
 */
export async function prepareWorkingTree(args: {
  fullName: string
  userLocalPath: string
  runTag: string
  staged: boolean
}): Promise<PreparedCheckout> {
  if (!existsSync(join(args.userLocalPath, '.git'))) {
    throw new Error('Mapped local path is not a git repository.')
  }
  const git = localGit(args.userLocalPath)
  const diff = await git.raw(args.staged ? ['diff', '--staged'] : ['diff', 'HEAD'])
  const { owner, name } = splitFullName(args.fullName)
  const diffDir = dataDir('diffs')
  mkdirSync(diffDir, { recursive: true })
  const tag = args.staged ? 'staged' : 'worktree'
  const diffPath = join(diffDir, `${owner}-${name}-${tag}-${args.runTag}.diff`)
  writeFileSync(diffPath, diff, 'utf8')
  return {
    mode: 'working-tree',
    worktreePath: args.userLocalPath,
    diffPath,
    baseDir: args.userLocalPath
  }
}

/** Internal prepare result, carrying baseDir for cleanup (not exposed to the renderer). */
export interface PreparedCheckout extends PrepareResult {
  baseDir: string
}

/** Full prepare: checkout the SHA into a worktree and produce a diff file. */
export async function prepareCheckout(args: {
  fullName: string
  sha: string
  remoteUrl: string
  runTag: string
  token?: string
  userLocalPath?: string | null
  useLocalWorktree?: boolean
  /** PR base SHA — when set, the diff covers the whole PR (merge-base..head). */
  baseSha?: string | null
}): Promise<PreparedCheckout> {
  const { mode, baseDir, worktreePath } = await checkoutWorktree(args)
  const diffPath = await writeCommitDiff(
    baseDir,
    args.fullName,
    args.sha,
    args.runTag,
    args.baseSha
  )
  return { mode, worktreePath, diffPath, baseDir }
}

/** Removes a run's worktree (off the repo it was added from) and its diff file. */
export async function cleanupCheckout(prepared: PreparedCheckout): Promise<void> {
  try {
    // A working-tree review runs IN the user's own clone — there is no worktree to
    // remove and `worktreePath` IS their clone, so never run `worktree remove` on it.
    // Only drop the generated diff file.
    if (prepared.mode !== 'working-tree') {
      // Serialize the worktree remove with concurrent worktree adds on the same clone (same key).
      await cloneMutex.run(prepared.baseDir, () =>
        localGit(prepared.baseDir)
          .raw(['worktree', 'remove', '--force', prepared.worktreePath])
          .catch(() => undefined)
      )
    }
    rmSync(prepared.diffPath, { force: true })
  } catch {
    // cleanup must never throw
  }
}

/**
 * Startup sweep: with no run active in a fresh process, drop all worktrees and
 * diff files (regenerated per run; the durable review lives in runs/*.out). Stale
 * worktree refs left in the clones are pruned lazily on the next checkout.
 */
export function pruneAllWorktreesAndDiffs(): void {
  rmSync(dataDir('worktrees'), { recursive: true, force: true })
  rmSync(dataDir('diffs'), { recursive: true, force: true })
}
