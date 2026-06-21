import { join } from 'path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import type { AccountKind } from '../shared/types'
import {
  DEFAULT_REVIEW_INSTRUCTIONS,
  LEGACY_DEFAULT_REVIEW_INSTRUCTIONS,
  SEED_PROMPTS
} from './agentConfig'

/**
 * SQLite store for Aerie. Lives in the main process only. The DB file sits under
 * the app's userData dir. Schema changes go through the ordered `MIGRATIONS`
 * list keyed off SQLite's `user_version` pragma, so upgrades are deterministic.
 */

export interface AccountRow {
  id: number
  label: string
  login: string
  kind: AccountKind
  token_blob: Buffer
  created_at: string
}

export interface NewAccount {
  label: string
  login: string
  kind: AccountKind
  tokenBlob: Buffer
  createdAt: string
}

const MIGRATIONS: ReadonlyArray<(db: Database.Database) => void> = [
  // v1 — accounts (SPEC §8)
  (db) => {
    db.exec(`
      CREATE TABLE accounts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        label      TEXT    NOT NULL,
        kind       TEXT    NOT NULL CHECK (kind IN ('user', 'org')),
        login      TEXT    NOT NULL UNIQUE,
        token_blob BLOB    NOT NULL,
        created_at TEXT    NOT NULL
      );
    `)
  },
  // v2 — repos cache + conditional-request (ETag) store (SPEC §8)
  (db) => {
    db.exec(`
      CREATE TABLE repos (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        full_name       TEXT    NOT NULL,
        default_branch  TEXT,
        remote_url      TEXT,
        html_url        TEXT,
        is_private      INTEGER NOT NULL DEFAULT 0,
        pushed_at       TEXT,
        user_local_path TEXT,
        app_clone_path  TEXT,
        last_synced_at  TEXT,
        UNIQUE (account_id, full_name)
      );
      CREATE INDEX idx_repos_account ON repos (account_id);

      CREATE TABLE http_cache (
        key        TEXT PRIMARY KEY,
        etag       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  },
  // v3 — opt-in read-only worktree flag per repo (SPEC §6, default OFF)
  (db) => {
    db.exec(`ALTER TABLE repos ADD COLUMN use_local_worktree INTEGER NOT NULL DEFAULT 0;`)
  },
  // v4 — agent runs (SPEC §8)
  (db) => {
    db.exec(`
      CREATE TABLE runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        ref_type    TEXT    NOT NULL CHECK (ref_type IN ('commit', 'pr')),
        ref_id      TEXT    NOT NULL,
        head_sha    TEXT    NOT NULL,
        agent_id    TEXT    NOT NULL,
        status      TEXT    NOT NULL CHECK (status IN ('queued','running','done','error','killed')),
        exit_code   INTEGER,
        started_at  TEXT    NOT NULL,
        finished_at TEXT,
        output_path TEXT,
        posted_url  TEXT
      );
      CREATE INDEX idx_runs_repo ON runs (repo_id);
    `)
  },
  // v5 — settings key/value (SPEC §8)
  (db) => {
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  },
  // v6 — review presets (quick agent+model+reasoning bundles)
  (db) => {
    db.exec(`
      CREATE TABLE presets (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL,
        agent_id   TEXT    NOT NULL,
        model      TEXT    NOT NULL DEFAULT '',
        reasoning  TEXT    NOT NULL DEFAULT '',
        created_at TEXT    NOT NULL
      );
    `)
  },
  // v7 — remember the reviewed commit/PR author (so a comment can @-mention them)
  (db) => {
    db.exec(`ALTER TABLE runs ADD COLUMN author_login TEXT;`)
  },
  // v8 — editable, selectable review prompts (seed the original default).
  // NOTE: this seeds the LEGACY default verbatim (a frozen migration anchor);
  // v9 upgrades it to the current text if the user hasn't edited it.
  (db) => {
    db.exec(`
      CREATE TABLE prompts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL,
        body       TEXT    NOT NULL,
        created_at TEXT    NOT NULL
      );
    `)
    db.prepare(`INSERT INTO prompts (name, body, created_at) VALUES (?, ?, ?)`).run(
      'Default review',
      LEGACY_DEFAULT_REVIEW_INSTRUCTIONS,
      new Date().toISOString()
    )
  },
  // v9 — ship the curated review-prompt set out of the box (security, tests,
  // performance, architecture, quick triage) and upgrade the default to the
  // improved text, but only when it still equals the legacy seed (never clobber
  // a user's edit). Insert each curated prompt only if its name is not present.
  (db) => {
    const now = new Date().toISOString()
    const exists = db.prepare(`SELECT 1 FROM prompts WHERE name = ?`)
    const insert = db.prepare(`INSERT INTO prompts (name, body, created_at) VALUES (?, ?, ?)`)
    for (const p of SEED_PROMPTS) {
      if (!exists.get(p.name)) insert.run(p.name, p.body, now)
    }
    db.prepare(`UPDATE prompts SET body = ? WHERE name = 'Default review' AND body = ?`).run(
      DEFAULT_REVIEW_INSTRUCTIONS,
      LEGACY_DEFAULT_REVIEW_INSTRUCTIONS
    )
  },
  // v10 — local-only repo favorites (pin to the top of the list; not GitHub stars)
  (db) => {
    db.exec(`ALTER TABLE repos ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;`)
  }
]

let db: Database.Database | null = null

function migrate(database: Database.Database): void {
  const current = database.pragma('user_version', { simple: true }) as number
  for (let version = current; version < MIGRATIONS.length; version++) {
    const run = MIGRATIONS[version]
    const next = version + 1
    const tx = database.transaction(() => {
      run(database)
      database.pragma(`user_version = ${next}`)
    })
    tx()
  }
}

/** Opens (and migrates) the database. Must be called after `app` is ready. */
export function initStore(dbPath = join(app.getPath('userData'), 'aerie.db')): Database.Database {
  if (db) return db
  const database = new Database(dbPath)
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  migrate(database)
  db = database
  reconcileInterruptedRuns()
  return db
}

/**
 * On startup no run can still be live (fresh process), so any row left
 * 'running'/'queued' was interrupted (crash/quit) — mark it 'error' so the UI
 * never shows a permanent ghost run.
 */
export function reconcileInterruptedRuns(): number {
  return requireDb()
    .prepare(
      `UPDATE runs SET status = 'error', finished_at = ? WHERE status IN ('running','queued')`
    )
    .run(new Date().toISOString()).changes
}

function requireDb(): Database.Database {
  if (!db) throw new Error('Store not initialized — call initStore() first.')
  return db
}

export function insertAccount(account: NewAccount): AccountRow {
  const result = requireDb()
    .prepare(
      `INSERT INTO accounts (label, kind, login, token_blob, created_at)
       VALUES (@label, @kind, @login, @tokenBlob, @createdAt)`
    )
    .run({
      label: account.label,
      kind: account.kind,
      login: account.login,
      tokenBlob: account.tokenBlob,
      createdAt: account.createdAt
    })
  return getAccount(Number(result.lastInsertRowid))!
}

export function listAccounts(): AccountRow[] {
  return requireDb()
    .prepare(`SELECT * FROM accounts ORDER BY created_at ASC, id ASC`)
    .all() as AccountRow[]
}

export function getAccount(id: number): AccountRow | undefined {
  return requireDb().prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as
    | AccountRow
    | undefined
}

export function findAccountByLogin(login: string): AccountRow | undefined {
  return requireDb().prepare(`SELECT * FROM accounts WHERE login = ?`).get(login) as
    | AccountRow
    | undefined
}

/** Replaces an account's encrypted token (re-auth on token expiry). */
export function updateAccountToken(id: number, tokenBlob: Buffer): void {
  requireDb().prepare(`UPDATE accounts SET token_blob = ? WHERE id = ?`).run(tokenBlob, id)
}

/** Deletes an account (and with it the encrypted token). Returns true if a row was removed. */
export function deleteAccount(id: number): boolean {
  return requireDb().prepare(`DELETE FROM accounts WHERE id = ?`).run(id).changes > 0
}

/** Test/maintenance helper — closes the handle so a fresh store can be opened. */
export function closeStore(): void {
  db?.close()
  db = null
}

// --- repos (Stage 2) ----------------------------------------------------------

export interface RepoRow {
  id: number
  account_id: number
  full_name: string
  default_branch: string | null
  remote_url: string | null
  html_url: string | null
  is_private: number
  pushed_at: string | null
  user_local_path: string | null
  app_clone_path: string | null
  last_synced_at: string | null
  use_local_worktree: number
  favorite: number
}

export interface NewRepo {
  fullName: string
  defaultBranch: string | null
  remoteUrl: string | null
  htmlUrl: string | null
  isPrivate: boolean
  pushedAt: string | null
}

export function listReposForAccount(accountId: number): RepoRow[] {
  return requireDb()
    .prepare(
      // Local favorites pin to the top; the rest keep the default pushed-desc order.
      `SELECT * FROM repos WHERE account_id = ?
       ORDER BY favorite DESC, pushed_at DESC, full_name ASC`
    )
    .all(accountId) as RepoRow[]
}

/** Sets/clears a repo's local favorite flag (pins it to the top; not a GitHub star). */
export function setRepoFavorite(id: number, value: boolean): void {
  requireDb()
    .prepare(`UPDATE repos SET favorite = ? WHERE id = ?`)
    .run(value ? 1 : 0, id)
}

export function getRepoById(id: number): RepoRow | undefined {
  return requireDb().prepare(`SELECT * FROM repos WHERE id = ?`).get(id) as RepoRow | undefined
}

export function setRepoLocalPath(id: number, userLocalPath: string | null): void {
  requireDb().prepare(`UPDATE repos SET user_local_path = ? WHERE id = ?`).run(userLocalPath, id)
}

export function setRepoUseLocalWorktree(id: number, value: boolean): void {
  requireDb()
    .prepare(`UPDATE repos SET use_local_worktree = ? WHERE id = ?`)
    .run(value ? 1 : 0, id)
}

export function setRepoClonePath(id: number, appClonePath: string): void {
  requireDb().prepare(`UPDATE repos SET app_clone_path = ? WHERE id = ?`).run(appClonePath, id)
}

/**
 * Replaces an account's cached repo set with the freshly fetched list in one
 * transaction: upserts each repo and removes repos that no longer exist remotely.
 *
 * IMPORTANT: the upsert below intentionally lists ONLY GitHub-sourced columns. The
 * local-only columns — `favorite`, `use_local_worktree`, `user_local_path`,
 * `app_clone_path` — are deliberately excluded from both the INSERT list and the
 * ON CONFLICT DO UPDATE SET clause so a refresh never clobbers them (a new repo
 * gets their DEFAULTs; an existing repo keeps its values). Do NOT add them here.
 */
export function syncReposForAccount(accountId: number, repos: NewRepo[], syncedAt: string): void {
  const database = requireDb()
  const upsert = database.prepare(`
    INSERT INTO repos (account_id, full_name, default_branch, remote_url, html_url,
                       is_private, pushed_at, last_synced_at)
    VALUES (@accountId, @fullName, @defaultBranch, @remoteUrl, @htmlUrl,
            @isPrivate, @pushedAt, @syncedAt)
    ON CONFLICT (account_id, full_name) DO UPDATE SET
      default_branch = excluded.default_branch,
      remote_url     = excluded.remote_url,
      html_url       = excluded.html_url,
      is_private     = excluded.is_private,
      pushed_at      = excluded.pushed_at,
      last_synced_at = excluded.last_synced_at
  `)
  const deleteGone = database.prepare(
    `DELETE FROM repos WHERE account_id = @accountId AND last_synced_at IS NOT @syncedAt`
  )
  const tx = database.transaction(() => {
    for (const repo of repos) {
      upsert.run({
        accountId,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        remoteUrl: repo.remoteUrl,
        htmlUrl: repo.htmlUrl,
        isPrivate: repo.isPrivate ? 1 : 0,
        pushedAt: repo.pushedAt,
        syncedAt
      })
    }
    // Only prune when we actually fetched repos. An empty result (transient API
    // hiccup, or a token that lost access) must NOT silently wipe the cache.
    if (repos.length > 0) {
      deleteGone.run({ accountId, syncedAt })
    }
  })
  tx()
}

// --- conditional-request (ETag) cache ----------------------------------------

export function getEtag(key: string): string | undefined {
  const row = requireDb().prepare(`SELECT etag FROM http_cache WHERE key = ?`).get(key) as
    | { etag: string }
    | undefined
  return row?.etag
}

export function setEtag(key: string, etag: string, updatedAt: string): void {
  requireDb()
    .prepare(
      `INSERT INTO http_cache (key, etag, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET etag = excluded.etag, updated_at = excluded.updated_at`
    )
    .run(key, etag, updatedAt)
}

// --- agent runs (Stage 5) ----------------------------------------------------

export type RunStatusValue = 'queued' | 'running' | 'done' | 'error' | 'killed'

export interface RunRow {
  id: number
  repo_id: number
  ref_type: 'commit' | 'pr'
  ref_id: string
  head_sha: string
  agent_id: string
  status: RunStatusValue
  exit_code: number | null
  started_at: string
  finished_at: string | null
  output_path: string | null
  posted_url: string | null
  author_login: string | null
}

export interface NewRun {
  repoId: number
  refType: 'commit' | 'pr'
  refId: string
  headSha: string
  agentId: string
  startedAt: string
  authorLogin?: string | null
}

export function insertRun(run: NewRun): RunRow {
  const result = requireDb()
    .prepare(
      `INSERT INTO runs (repo_id, ref_type, ref_id, head_sha, agent_id, status, started_at, author_login)
       VALUES (@repoId, @refType, @refId, @headSha, @agentId, 'queued', @startedAt, @authorLogin)`
    )
    .run({ ...run, authorLogin: run.authorLogin ?? null })
  return getRun(Number(result.lastInsertRowid))!
}

export function updateRunStatus(
  id: number,
  patch: {
    status: RunStatusValue
    exitCode?: number | null
    finishedAt?: string | null
    outputPath?: string | null
  }
): void {
  requireDb()
    .prepare(
      `UPDATE runs SET
         status = @status,
         exit_code = COALESCE(@exitCode, exit_code),
         finished_at = COALESCE(@finishedAt, finished_at),
         output_path = COALESCE(@outputPath, output_path)
       WHERE id = @id`
    )
    .run({
      id,
      status: patch.status,
      exitCode: patch.exitCode ?? null,
      finishedAt: patch.finishedAt ?? null,
      outputPath: patch.outputPath ?? null
    })
}

export function setRunPostedUrl(id: number, url: string): void {
  requireDb().prepare(`UPDATE runs SET posted_url = ? WHERE id = ?`).run(url, id)
}

export function getRun(id: number): RunRow | undefined {
  return requireDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined
}

export function listRunsForRepo(repoId: number): RunRow[] {
  return requireDb()
    .prepare(`SELECT * FROM runs WHERE repo_id = ? ORDER BY started_at DESC, id DESC`)
    .all(repoId) as RunRow[]
}

export interface RunRowWithRepo extends RunRow {
  full_name: string
}

/** True if a run for this repo/sha/agent is already queued or running. */
export function hasActiveRun(repoId: number, sha: string, agentId: string): boolean {
  return !!requireDb()
    .prepare(
      `SELECT 1 FROM runs WHERE repo_id = ? AND head_sha = ? AND agent_id = ?
       AND status IN ('queued','running') LIMIT 1`
    )
    .get(repoId, sha, agentId)
}

/** All runs across repos, newest first, with the repo's full name (history view). */
export function listAllRuns(limit = 200): RunRowWithRepo[] {
  return requireDb()
    .prepare(
      `SELECT runs.*, repos.full_name FROM runs
       JOIN repos ON repos.id = runs.repo_id
       ORDER BY runs.started_at DESC, runs.id DESC
       LIMIT ?`
    )
    .all(limit) as RunRowWithRepo[]
}

// --- settings (Stage 7) ------------------------------------------------------
// NOTE: this is a generic key/value table shared with main-only keys (e.g.
// `agent.model:*`). The renderer can only reach it through the settings IPC
// handlers, which restrict access to a hardcoded `ui.*` allowlist — that IPC
// allowlist, not this layer, is the trust boundary. Do not add a renderer path
// that reads/writes arbitrary keys.

export function getSetting(key: string): string | undefined {
  const row = requireDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function setSetting(key: string, value: string): void {
  requireDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value)
}

// --- review presets ----------------------------------------------------------

export interface PresetRow {
  id: number
  name: string
  agent_id: string
  model: string
  reasoning: string
  created_at: string
}

export function listPresets(): PresetRow[] {
  return requireDb()
    .prepare(`SELECT * FROM presets ORDER BY created_at ASC, id ASC`)
    .all() as PresetRow[]
}

export function insertPreset(p: {
  name: string
  agentId: string
  model: string
  reasoning: string
  createdAt: string
}): PresetRow {
  const result = requireDb()
    .prepare(
      `INSERT INTO presets (name, agent_id, model, reasoning, created_at)
       VALUES (@name, @agentId, @model, @reasoning, @createdAt)`
    )
    .run(p)
  return requireDb()
    .prepare(`SELECT * FROM presets WHERE id = ?`)
    .get(result.lastInsertRowid) as PresetRow
}

export function deletePreset(id: number): boolean {
  return requireDb().prepare(`DELETE FROM presets WHERE id = ?`).run(id).changes > 0
}

// --- review prompts (editable, selectable instructions) ----------------------

export interface PromptRow {
  id: number
  name: string
  body: string
  created_at: string
}

export function listPrompts(): PromptRow[] {
  return requireDb()
    .prepare(`SELECT * FROM prompts ORDER BY created_at ASC, id ASC`)
    .all() as PromptRow[]
}

export function getPrompt(id: number): PromptRow | undefined {
  return requireDb().prepare(`SELECT * FROM prompts WHERE id = ?`).get(id) as PromptRow | undefined
}

export function insertPrompt(p: { name: string; body: string; createdAt: string }): PromptRow {
  const result = requireDb()
    .prepare(`INSERT INTO prompts (name, body, created_at) VALUES (@name, @body, @createdAt)`)
    .run(p)
  return getPrompt(Number(result.lastInsertRowid))!
}

export function updatePrompt(id: number, patch: { name: string; body: string }): boolean {
  return (
    requireDb()
      .prepare(`UPDATE prompts SET name = @name, body = @body WHERE id = @id`)
      .run({ id, name: patch.name, body: patch.body }).changes > 0
  )
}

export function deletePrompt(id: number): boolean {
  return requireDb().prepare(`DELETE FROM prompts WHERE id = ?`).run(id).changes > 0
}
