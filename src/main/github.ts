import type {
  BranchSummary,
  CommitDetail,
  CommitFile,
  CommitSummary,
  Paginated,
  PullRequestDetail,
  PullRequestSummary,
  RepoSummary,
  ReposResult
} from '../shared/types'
import { createOctokit, decryptToken } from './auth'
import { log } from './logger'
import {
  getAccount,
  getEtag,
  listReposForAccount,
  setEtag,
  syncReposForAccount,
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
  options: { branch?: string; page?: number } = {}
): Promise<Paginated<CommitSummary>> {
  const { octokit, owner, repo } = await octokitAndRepo(accountId, repoFullName)
  const page = options.page ?? 1
  const res = await octokit.request('GET /repos/{owner}/{repo}/commits', {
    owner,
    repo,
    per_page: PAGE_SIZE,
    page,
    ...(options.branch ? { sha: options.branch } : {})
  })
  return {
    items: (res.data as RawCommitListItem[]).map(toCommitSummary),
    page,
    hasMore: hasNextPage(res.headers.link)
  }
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
  options: { page?: number } = {}
): Promise<Paginated<PullRequestSummary>> {
  const { octokit, owner, repo } = await octokitAndRepo(accountId, repoFullName)
  const page = options.page ?? 1
  const res = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
    owner,
    repo,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: PAGE_SIZE,
    page
  })
  return {
    items: (res.data as RawPullListItem[]).map(toPrSummary),
    page,
    hasMore: hasNextPage(res.headers.link)
  }
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
