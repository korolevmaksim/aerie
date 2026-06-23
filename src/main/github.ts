import type {
  BranchSummary,
  CommitDetail,
  CommitFile,
  CommitSummary,
  Paginated,
  PollResult,
  PullRequestDetail,
  PullRequestSummary,
  RepoSummary,
  ReposResult
} from '../shared/types'
import { createOctokit, decryptToken } from './auth'
import { log } from './logger'
import { nextPollDelayMs, parseRateLimit, type RateLimit } from './rateLimit'
import {
  getAccount,
  getCacheEntry,
  getEtag,
  listReposForAccount,
  setCacheEntry,
  setEtag,
  syncReposForAccount,
  touchWatchPolled,
  upsertWatch,
  type NewRepo,
  type RepoRow
} from './store'

/**
 * GitHub read operations for an account. Runs in the main process; uses the
 * account's decrypted token (never exposed to the renderer). Repo lists are
 * cached in SQLite and re-fetched with a conditional request (ETag), so an
 * unchanged re-list costs ~0 rate limit (SPEC §2 / Stage 2).
 */

type Octokit = Awaited<ReturnType<typeof createOctokit>>

async function octokitForAccount(accountId: number): Promise<Octokit> {
  const row = getAccount(accountId)
  if (!row) throw new Error('Account not found.')
  return createOctokit(decryptToken(row.token_blob))
}

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { status?: number }).status === status
  )
}

// Repos accessible to the token across the user and their orgs.
const LIST_PARAMS = {
  per_page: 100,
  affiliation: 'owner,collaborator,organization_member',
  sort: 'pushed',
  direction: 'desc'
} as const

function toNewRepo(repo: {
  full_name: string
  default_branch?: string
  clone_url?: string
  html_url?: string
  private?: boolean
  pushed_at?: string | null
}): NewRepo {
  return {
    fullName: repo.full_name,
    defaultBranch: repo.default_branch ?? null,
    remoteUrl: repo.clone_url ?? null,
    htmlUrl: repo.html_url ?? null,
    isPrivate: Boolean(repo.private),
    pushedAt: repo.pushed_at ?? null
  }
}

function rowToSummary(row: RepoRow): RepoSummary {
  return {
    id: row.id,
    fullName: row.full_name,
    defaultBranch: row.default_branch,
    remoteUrl: row.remote_url,
    htmlUrl: row.html_url,
    isPrivate: row.is_private === 1,
    pushedAt: row.pushed_at,
    isFavorite: row.favorite === 1
  }
}

function cachedResult(accountId: number, fromCache: boolean): ReposResult {
  return { repos: listReposForAccount(accountId).map(rowToSummary), fromCache }
}

/** The account's repos straight from the local cache (re-sorted), no network call. */
export function reposFromCache(accountId: number): ReposResult {
  return cachedResult(accountId, true)
}

/**
 * Lists repos for an account. Probes page 1 with the stored ETag; on 304 serves
 * the cache, otherwise paginates the full set, refreshes the cache + ETag, and
 * returns the merged rows. `force` bypasses the conditional probe.
 */
export async function listRepos(
  accountId: number,
  options: { force?: boolean } = {}
): Promise<ReposResult> {
  const octokit = await octokitForAccount(accountId)
  const cacheKey = `repos:list:${accountId}`
  const etag = options.force ? undefined : getEtag(cacheKey)

  try {
    const probe = await octokit.request('GET /user/repos', {
      ...LIST_PARAMS,
      page: 1,
      headers: etag ? { 'if-none-match': etag } : {}
    })

    // 200 → the list changed (or first load): fetch every page and refresh cache.
    const all = (await octokit.paginate('GET /user/repos', LIST_PARAMS)) as Array<
      Parameters<typeof toNewRepo>[0]
    >
    const newEtag = probe.headers.etag
    const now = new Date().toISOString()
    syncReposForAccount(accountId, all.map(toNewRepo), now)
    if (newEtag) setEtag(cacheKey, newEtag, now)
    log.info('repos fetched', { accountId, count: all.length })
    return cachedResult(accountId, false)
  } catch (error) {
    if (hasStatus(error, 304)) {
      const result = cachedResult(accountId, true)
      log.info('repos served from cache (304)', { accountId, count: result.repos.length })
      return result
    }
    throw error
  }
}

// --- commit / PR drill-in (Stage 3, read-only) -------------------------------

const PAGE_SIZE = 30

// Default poll cadence bounds (M8). The poller (M9a) may override per pipeline.
const POLL_BASE_INTERVAL_MS = 60_000
const POLL_MAX_INTERVAL_MS = 15 * 60_000

/** The serialized body cached for a list page, replayed verbatim on a 304. */
interface CachedPage<T> {
  items: T[]
  hasMore: boolean
}

/**
 * Runs a conditional list request: sends the stored ETag, and on a 304 (which GitHub
 * does NOT charge against the rate budget) replays the cached page. On 200 it caches
 * the fresh page + ETag. `force` skips the conditional probe. Mirrors `listRepos`.
 */
async function conditionalListPage<T>(
  cacheKey: string,
  force: boolean,
  fetchPage: (etag: string | undefined) => Promise<{ items: T[]; hasMore: boolean; etag?: string }>
): Promise<Paginated<T> & { page: number }> {
  const cached = force ? undefined : getCacheEntry(cacheKey)
  try {
    const { items, hasMore, etag } = await fetchPage(cached?.etag)
    if (etag) {
      setCacheEntry(cacheKey, etag, JSON.stringify({ items, hasMore }), new Date().toISOString())
    }
    return { items, hasMore, page: 0, fromCache: false }
  } catch (error) {
    if (hasStatus(error, 304) && cached?.payload) {
      const body = JSON.parse(cached.payload) as CachedPage<T>
      return { items: body.items, hasMore: body.hasMore, page: 0, fromCache: true }
    }
    throw error
  }
}

async function octokitAndRepo(
  accountId: number,
  repoFullName: string
): Promise<{ octokit: Octokit; owner: string; repo: string }> {
  const octokit = await octokitForAccount(accountId)
  const slash = repoFullName.indexOf('/')
  const owner = slash > 0 ? repoFullName.slice(0, slash) : ''
  const repo = slash > 0 ? repoFullName.slice(slash + 1) : ''
  if (!owner || !repo) throw new Error('Invalid repository name.')
  return { octokit, owner, repo }
}

function hasNextPage(link: string | undefined): boolean {
  return typeof link === 'string' && /rel="next"/.test(link)
}

type RawCommitListItem = {
  sha: string
  commit: { message: string; author: { name?: string; date?: string } | null }
  author: { login?: string } | null
}

function toCommitSummary(c: RawCommitListItem): CommitSummary {
  return {
    sha: c.sha,
    message: c.commit.message,
    authorName: c.commit.author?.name ?? null,
    authorLogin: c.author?.login ?? null,
    authoredAt: c.commit.author?.date ?? null
  }
}

function toCommitFile(f: {
  filename: string
  status: string
  additions: number
  deletions: number
  patch?: string
  previous_filename?: string
}): CommitFile {
  return {
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch ?? null,
    previousFilename: f.previous_filename ?? null
  }
}

export async function listBranches(
  accountId: number,
  repoFullName: string
): Promise<BranchSummary[]> {
  const { octokit, owner, repo } = await octokitAndRepo(accountId, repoFullName)
  const data = (await octokit.paginate('GET /repos/{owner}/{repo}/branches', {
    owner,
    repo,
    per_page: 100
  })) as Array<{ name: string; commit: { sha: string } }>
  return data.map((b) => ({ name: b.name, commitSha: b.commit.sha }))
}

export async function listCommits(
  accountId: number,
  repoFullName: string,
  options: { branch?: string; page?: number; force?: boolean } = {}
): Promise<Paginated<CommitSummary>> {
  const { octokit, owner, repo } = await octokitAndRepo(accountId, repoFullName)
  const page = options.page ?? 1
  const branch = options.branch ?? ''
  const cacheKey = `commits:${accountId}:${repoFullName}:${branch}:${page}`
  const result = await conditionalListPage<CommitSummary>(
    cacheKey,
    options.force ?? false,
    async (etag) => {
      const res = await octokit.request('GET /repos/{owner}/{repo}/commits', {
        owner,
        repo,
        per_page: PAGE_SIZE,
        page,
        ...(branch ? { sha: branch } : {}),
        headers: etag ? { 'if-none-match': etag } : {}
      })
      return {
        items: (res.data as RawCommitListItem[]).map(toCommitSummary),
        hasMore: hasNextPage(res.headers.link),
        etag: res.headers.etag
      }
    }
  )
  return { ...result, page }
}

/** Resolves the current head SHA for a branch/ref. Used by project-wide reviews. */
export async function getBranchHeadSha(
  accountId: number,
  repoFullName: string,
  branch: string
): Promise<string> {
  const page = await listCommits(accountId, repoFullName, { branch, page: 1, force: true })
  const sha = page.items[0]?.sha
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`Could not resolve the current head for "${branch || 'default branch'}".`)
  }
  return sha
}

export async function getCommit(
  accountId: number,
  repoFullName: string,
  sha: string
): Promise<CommitDetail> {
  const { octokit, owner, repo } = await octokitAndRepo(accountId, repoFullName)
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
    owner,
    repo,
    ref: sha
  })
  return {
    ...toCommitSummary(data as RawCommitListItem),
    htmlUrl: data.html_url ?? null,
    stats: data.stats
      ? {
          additions: data.stats.additions ?? 0,
          deletions: data.stats.deletions ?? 0,
          total: data.stats.total ?? 0
        }
      : null,
    files: (data.files ?? []).map(toCommitFile)
  }
}

type RawPullListItem = {
  number: number
  title: string
  state: string
  user: { login?: string } | null
  created_at: string
  head: { ref: string }
  base: { ref: string }
  html_url: string
}

function toPrSummary(p: RawPullListItem): PullRequestSummary {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    authorLogin: p.user?.login ?? null,
    createdAt: p.created_at ?? null,
    headRef: p.head.ref,
    baseRef: p.base.ref,
    htmlUrl: p.html_url ?? null
  }
}

export async function listPullRequests(
  accountId: number,
  repoFullName: string,
  options: { page?: number; force?: boolean } = {}
): Promise<Paginated<PullRequestSummary>> {
  const { octokit, owner, repo } = await octokitAndRepo(accountId, repoFullName)
  const page = options.page ?? 1
  const cacheKey = `pulls:${accountId}:${repoFullName}:${page}`
  const result = await conditionalListPage<PullRequestSummary>(
    cacheKey,
    options.force ?? false,
    async (etag) => {
      const res = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: PAGE_SIZE,
        page,
        headers: etag ? { 'if-none-match': etag } : {}
      })
      return {
        items: (res.data as RawPullListItem[]).map(toPrSummary),
        hasMore: hasNextPage(res.headers.link),
        etag: res.headers.etag
      }
    }
  )
  return { ...result, page }
}

export async function getPullRequest(
  accountId: number,
  repoFullName: string,
  pullNumber: number
): Promise<PullRequestDetail> {
  const { octokit, owner, repo } = await octokitAndRepo(accountId, repoFullName)
  const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner,
    repo,
    pull_number: pullNumber
  })
  const commits = (await octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100
  })) as RawCommitListItem[]
  return {
    ...toPrSummary(pr as RawPullListItem),
    body: pr.body ?? null,
    commits: commits.map(toCommitSummary)
  }
}

/**
 * The base-branch SHA of a PR, used to diff the WHOLE PR (merge-base..head)
 * rather than only its head commit. Resolved authoritatively from GitHub in the
 * main process — the renderer never supplies the diff range (integrity).
 */
export async function getPullRequestBaseSha(
  accountId: number,
  repoFullName: string,
  pullNumber: number
): Promise<string> {
  const { octokit, owner, repo } = await octokitAndRepo(accountId, repoFullName)
  const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner,
    repo,
    pull_number: pullNumber
  })
  return pr.base.sha
}

// --- automation polling (M8) -------------------------------------------------

/**
 * Cheaply checks whether a watched branch's head moved since the watch last *saw* a
 * commit. Sends a conditional 1-item commit probe with the stored ETag: a 304 (free,
 * not charged against the rate budget) replays the cached head SHA; a 200 reads the
 * fresh head. `changed` is true when that head differs from `watch.last_seen_sha`
 * (true on a brand-new watch — there's an unprocessed head). The poll only records
 * `last_polled_at`; the caller advances `last_seen_sha` via `markWatchSeen` AFTER the
 * delta is processed, so no commit is ever skipped. Returns the current rate budget
 * and the rate-aware delay before the next poll.
 *
 * `branch` should be a concrete branch name (the M9a poller resolves the repo's
 * default branch before watching it); an empty string falls back to the repo default
 * for the probe — matching `listCommits` — and keys the watch on ''.
 */
export async function pollCommitHead(
  accountId: number,
  repoId: number,
  repoFullName: string,
  branch: string
): Promise<PollResult> {
  const { octokit, owner, repo } = await octokitAndRepo(accountId, repoFullName)
  const watch = upsertWatch(repoId, 'commit', branch)
  const cacheKey = `pollhead:${accountId}:${repoFullName}:${branch}`
  const cached = getCacheEntry(cacheKey)
  const now = new Date().toISOString()

  let headSha: string | null = null
  let fromCache = false
  let rate: RateLimit = { remaining: null, limit: null, resetAt: null }
  try {
    const res = await octokit.request('GET /repos/{owner}/{repo}/commits', {
      owner,
      repo,
      per_page: 1,
      ...(branch ? { sha: branch } : {}),
      headers: cached?.etag ? { 'if-none-match': cached.etag } : {}
    })
    headSha = (res.data as RawCommitListItem[])[0]?.sha ?? null
    rate = parseRateLimit(res.headers as Record<string, unknown>)
    if (res.headers.etag) {
      setCacheEntry(cacheKey, res.headers.etag, JSON.stringify({ sha: headSha }), now)
    }
  } catch (error) {
    if (hasStatus(error, 304) && cached?.payload) {
      headSha = (JSON.parse(cached.payload) as { sha: string | null }).sha
      fromCache = true
      const headers = (error as { response?: { headers?: Record<string, unknown> } }).response
        ?.headers
      rate = parseRateLimit(headers)
    } else {
      throw error
    }
  }

  touchWatchPolled(repoId, 'commit', branch, now)
  const lastSeenSha = watch.last_seen_sha
  const changed = headSha !== null && headSha !== lastSeenSha
  const nextDelay = nextPollDelayMs({
    rate,
    nowMs: Date.now(),
    baseIntervalMs: POLL_BASE_INTERVAL_MS,
    maxIntervalMs: POLL_MAX_INTERVAL_MS
  })
  log.info('poll commit head', { repoId, branch, headSha, changed, fromCache })
  return { headSha, lastSeenSha, changed, fromCache, rate, nextPollDelayMs: nextDelay }
}

// --- writes (Stage 6) — every caller is behind an in-app confirm -------------

export async function createCommitComment(
  accountId: number,
  repoFullName: string,
  sha: string,
  body: string
): Promise<string> {
  const { octokit, owner, repo } = await octokitAndRepo(accountId, repoFullName)
  const { data } = await octokit.request(
    'POST /repos/{owner}/{repo}/commits/{commit_sha}/comments',
    { owner, repo, commit_sha: sha, body }
  )
  return data.html_url
}

export async function createPrComment(
  accountId: number,
  repoFullName: string,
  prNumber: number,
  body: string
): Promise<string> {
  const { octokit, owner, repo } = await octokitAndRepo(accountId, repoFullName)
  // A PR's conversation comments are issue comments on the same number.
  const { data } = await octokit.request(
    'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    {
      owner,
      repo,
      issue_number: prNumber,
      body
    }
  )
  return data.html_url
}

export async function createIssue(
  accountId: number,
  repoFullName: string,
  title: string,
  body: string
): Promise<string> {
  const { octokit, owner, repo } = await octokitAndRepo(accountId, repoFullName)
  const { data } = await octokit.request('POST /repos/{owner}/{repo}/issues', {
    owner,
    repo,
    title,
    body
  })
  return data.html_url
}
