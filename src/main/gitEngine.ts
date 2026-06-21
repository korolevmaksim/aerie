import { join } from 'path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { app } from 'electron'
import simpleGit, { type SimpleGit } from 'simple-git'
import type { PrepareMode, PrepareResult } from '../shared/types'

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

/** Builds a git child-process env that authenticates without persisting the token. */
function authEnv(token?: string): NodeJS.ProcessEnv {
  // Strip inherited GIT_* vars (e.g. GIT_EDITOR, which simple-git refuses to
  // forward, and any ambient config that could change git's behavior); then set
  // exactly the vars we need. Keeps PATH/HOME/proxy settings intact.
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value
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
  const options = { unsafe: { allowUnsafeConfigEnvCount: true } }
  const git = baseDir ? simpleGit(baseDir, options) : simpleGit(options)
  return git.env(authEnv(token))
}

/**
 * Ensures an app-owned clone exists at the target SHA's repo and is up to date.
 * Clones if absent, otherwise fetches. Returns the clone path.
 */
export async function ensureClone(
  fullName: string,
  remoteUrl: string,
  token?: string
): Promise<string> {
  const clonePath = clonePathFor(fullName)
  if (existsSync(join(clonePath, '.git'))) {
    await authedGit(clonePath, token).fetch(['--prune', '--tags', 'origin'])
  } else {
    mkdirSync(clonePath, { recursive: true })
    await authedGit(undefined, token).clone(remoteUrl, clonePath)
  }
  return clonePath
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
    const git = simpleGit(args.userLocalPath)
    await addDetachedWorktree(git, worktreePath, args.sha)
    return { mode: 'user-worktree', baseDir: args.userLocalPath, worktreePath }
  }

  const clonePath = await ensureClone(args.fullName, args.remoteUrl, args.token)
  const git = authedGit(clonePath, args.token)
  try {
    await addDetachedWorktree(git, worktreePath, args.sha)
  } catch {
    // The SHA may not be on a fetched branch (e.g. a PR head) — fetch it directly.
    await git.fetch(['origin', args.sha]).catch(() => undefined)
    await addDetachedWorktree(git, worktreePath, args.sha)
  }
  return { mode: 'app-clone', baseDir: clonePath, worktreePath }
}

/** Generates a unified diff for a commit and writes it to a file. Returns the path. */
export async function writeCommitDiff(
  baseDir: string,
  fullName: string,
  sha: string,
  runTag: string
): Promise<string> {
  const git = simpleGit(baseDir)
  let diff: string
  // Diff against the first parent; fall back to the full patch for a root commit.
  const hasParent = await git
    .raw(['rev-parse', '--verify', '--quiet', `${sha}^`])
    .then(() => true)
    .catch(() => false)
  if (hasParent) {
    diff = await git.raw(['diff', `${sha}^`, sha])
  } else {
    diff = await git.raw(['show', '--format=', sha])
  }
  const { owner, name } = splitFullName(fullName)
  const diffDir = dataDir('diffs')
  mkdirSync(diffDir, { recursive: true })
  const diffPath = join(diffDir, `${owner}-${name}-${sha.slice(0, 12)}-${runTag}.diff`)
  writeFileSync(diffPath, diff, 'utf8')
  return diffPath
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
}): Promise<PreparedCheckout> {
  const { mode, baseDir, worktreePath } = await checkoutWorktree(args)
  const diffPath = await writeCommitDiff(baseDir, args.fullName, args.sha, args.runTag)
  return { mode, worktreePath, diffPath, baseDir }
}

/** Removes a run's worktree (off the repo it was added from) and its diff file. */
export async function cleanupCheckout(prepared: PreparedCheckout): Promise<void> {
  try {
    await simpleGit(prepared.baseDir)
      .raw(['worktree', 'remove', '--force', prepared.worktreePath])
      .catch(() => undefined)
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
