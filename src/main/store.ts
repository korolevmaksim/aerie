import { join } from 'path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import type {
  AccountKind,
  PipelineActionKind,
  PipelineDraft,
  PipelineRunStatus,
  PipelineTrigger,
  RefType,
  RunLocalStatus
} from '../shared/types'
import {
  DEFAULT_PROJECT_REVIEW_INSTRUCTIONS,
  DEFAULT_REVIEW_INSTRUCTIONS,
  LEGACY_DEFAULT_REVIEW_INSTRUCTIONS,
  SEED_PROMPTS
} from './agentConfig'
import type { Finding } from './findings'

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
  },
  // v11 — structured findings per run (M4): normalized tool/agent findings, scoped
  // to the change. Cascades away with the run.
  (db) => {
    db.exec(`
      CREATE TABLE findings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        tool        TEXT    NOT NULL,
        rule_id     TEXT,
        severity    TEXT    NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
        file        TEXT    NOT NULL,
        line        INTEGER,
        message     TEXT    NOT NULL,
        fingerprint TEXT    NOT NULL
      );
      CREATE INDEX idx_findings_run ON findings (run_id);
    `)
  },
  // v12 — allow working-tree runs (M7): relax the runs.ref_type CHECK to include
  // 'working-tree'. SQLite can't ALTER a CHECK, so rebuild the table (the standard
  // 12-step procedure). `migrate()` runs each migration with foreign_keys OFF, so
  // dropping `runs` here does NOT cascade-delete `findings`; the child FK re-binds
  // to the rebuilt `runs` by name. Column order/values are preserved exactly.
  (db) => {
    db.exec(`
      CREATE TABLE runs_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        ref_type    TEXT    NOT NULL CHECK (ref_type IN ('commit', 'pr', 'working-tree')),
        ref_id      TEXT    NOT NULL,
        head_sha    TEXT    NOT NULL,
        agent_id    TEXT    NOT NULL,
        status      TEXT    NOT NULL CHECK (status IN ('queued','running','done','error','killed')),
        exit_code   INTEGER,
        started_at  TEXT    NOT NULL,
        finished_at TEXT,
        output_path TEXT,
        posted_url  TEXT,
        author_login TEXT
      );
      INSERT INTO runs_new (id, repo_id, ref_type, ref_id, head_sha, agent_id, status,
                            exit_code, started_at, finished_at, output_path, posted_url, author_login)
        SELECT id, repo_id, ref_type, ref_id, head_sha, agent_id, status,
               exit_code, started_at, finished_at, output_path, posted_url, author_login
        FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_new RENAME TO runs;
      CREATE INDEX idx_runs_repo ON runs (repo_id);
    `)
    // Guard against the rebuild leaving any dangling child FK (findings → runs).
    const violations = db.pragma('foreign_key_check') as unknown[]
    if (Array.isArray(violations) && violations.length > 0) {
      throw new Error('v12 migration left dangling foreign keys')
    }
  },
  // v13 — automation polling foundation (M8): give the conditional-request cache an
  // optional JSON payload (so commit/PR list pages can be served straight from a 304,
  // not just repo rows), and add a `watches` table tracking the last-seen head SHA /
  // PR head per watched repo ref. The poller (M9a) reads/advances these; M8 only lays
  // the store + ETag plumbing. `ref` is the branch name for 'commit' watches and
  // `pr:<number>` for 'pr' watches; last_seen_sha is advanced ONLY after a delta is
  // processed (never on a bare poll), so no unprocessed commit is ever skipped.
  (db) => {
    db.exec(`
      ALTER TABLE http_cache ADD COLUMN payload TEXT;

      CREATE TABLE watches (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id        INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        ref_type       TEXT    NOT NULL CHECK (ref_type IN ('commit', 'pr')),
        ref            TEXT    NOT NULL,
        last_seen_sha  TEXT,
        last_polled_at TEXT,
        UNIQUE (repo_id, ref_type, ref)
      );
      CREATE INDEX idx_watches_repo ON watches (repo_id);
    `)
  },
  // v14 — automation pipelines (M9a): a `pipelines` config table (per repo) and a
  // `pipeline_runs` execution-history table. The full authored config lives as JSON
  // in `pipelines.config`; a few columns are PROMOTED for querying + defense-in-depth:
  // `enabled` (the poller only runs enabled rows) and `auto_post` (a hard opt-in — the
  // engine asserts it in code AND can scope writes at the SQL layer). `pipeline_runs`
  // carries the `dedupe_key` (indexed) so the poller never re-runs identical work, and
  // `posted` flags the runs that actually wrote to GitHub.
  (db) => {
    db.exec(`
      CREATE TABLE pipelines (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        name        TEXT    NOT NULL,
        trigger     TEXT    NOT NULL CHECK (trigger IN ('commit','pr','schedule','manual')),
        enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        action_kind TEXT    NOT NULL CHECK (action_kind IN ('notify','stage','post')),
        auto_post   INTEGER NOT NULL DEFAULT 0 CHECK (auto_post IN (0, 1)),
        config      TEXT    NOT NULL,
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL,
        -- Belt-and-suspenders: a row can carry auto_post=1 ONLY when it is a 'post'
        -- action, so the DB itself can never hold an "auto-post a non-post" config.
        CHECK (auto_post = 0 OR action_kind = 'post')
      );
      CREATE INDEX idx_pipelines_repo ON pipelines (repo_id);

      CREATE TABLE pipeline_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_id INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
        trigger     TEXT    NOT NULL CHECK (trigger IN ('commit','pr','schedule','manual')),
        ref_type    TEXT    NOT NULL CHECK (ref_type IN ('commit','pr','working-tree')),
        ref         TEXT    NOT NULL,
        head_sha    TEXT    NOT NULL,
        status      TEXT    NOT NULL CHECK (status IN ('pending','running','done','error','skipped')),
        action      TEXT    NOT NULL CHECK (action IN ('notify','stage','post')),
        posted      INTEGER NOT NULL DEFAULT 0,
        dedupe_key  TEXT    NOT NULL,
        started_at  TEXT    NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX idx_pipeline_runs_pipeline ON pipeline_runs (pipeline_id);
      CREATE INDEX idx_pipeline_runs_dedupe ON pipeline_runs (dedupe_key);
    `)
  },
  // v15 — allow project-wide runs. These are normal run records but their ref_id is
  // the audited branch/ref name, and the run artifact is a bounded project audit brief
  // instead of a unified diff. Rebuild only `runs`; automation pipeline runs remain
  // commit/PR/working-tree scoped.
  (db) => {
    db.exec(`
      CREATE TABLE runs_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        ref_type    TEXT    NOT NULL CHECK (ref_type IN ('commit', 'pr', 'working-tree', 'project')),
        ref_id      TEXT    NOT NULL,
        head_sha    TEXT    NOT NULL,
        agent_id    TEXT    NOT NULL,
        status      TEXT    NOT NULL CHECK (status IN ('queued','running','done','error','killed')),
        exit_code   INTEGER,
        started_at  TEXT    NOT NULL,
        finished_at TEXT,
        output_path TEXT,
        posted_url  TEXT,
        author_login TEXT
      );
      INSERT INTO runs_new (id, repo_id, ref_type, ref_id, head_sha, agent_id, status,
                            exit_code, started_at, finished_at, output_path, posted_url, author_login)
        SELECT id, repo_id, ref_type, ref_id, head_sha, agent_id, status,
               exit_code, started_at, finished_at, output_path, posted_url, author_login
        FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_new RENAME TO runs;
      CREATE INDEX idx_runs_repo ON runs (repo_id);
    `)
    const violations = db.pragma('foreign_key_check') as unknown[]
    if (Array.isArray(violations) && violations.length > 0) {
      throw new Error('v15 migration left dangling foreign keys')
    }
    const exists = db.prepare(`SELECT 1 FROM prompts WHERE name = ?`)
    if (!exists.get('Project audit')) {
      db.prepare(`INSERT INTO prompts (name, body, created_at) VALUES (?, ?, ?)`).run(
        'Project audit',
        DEFAULT_PROJECT_REVIEW_INSTRUCTIONS,
        new Date().toISOString()
      )
    }
  },
  // v16 — private local run disposition. This lets a solo operator mark an
  // audit as handled/verified without pretending it was posted to GitHub.
  (db) => {
    db.exec(`
      ALTER TABLE runs
        ADD COLUMN local_status TEXT NOT NULL DEFAULT 'open'
          CHECK (local_status IN ('open','handled','verified'));
      ALTER TABLE runs ADD COLUMN local_status_at TEXT;
    `)
  },
  // v17 — allow scheduled pipeline runs to record project-wide audit targets.
  // Automation still watches commit heads, but a pipeline may now review the whole
  // project snapshot at that head, so pipeline_runs.ref_type needs to accept 'project'.
  (db) => {
    db.exec(`
      CREATE TABLE pipeline_runs_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_id INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
        trigger     TEXT    NOT NULL CHECK (trigger IN ('commit','pr','schedule','manual')),
        ref_type    TEXT    NOT NULL CHECK (ref_type IN ('commit','pr','working-tree','project')),
        ref         TEXT    NOT NULL,
        head_sha    TEXT    NOT NULL,
        status      TEXT    NOT NULL CHECK (status IN ('pending','running','done','error','skipped')),
        action      TEXT    NOT NULL CHECK (action IN ('notify','stage','post')),
        posted      INTEGER NOT NULL DEFAULT 0,
        dedupe_key  TEXT    NOT NULL,
        started_at  TEXT    NOT NULL,
        finished_at TEXT
      );
      INSERT INTO pipeline_runs_new (id, pipeline_id, trigger, ref_type, ref, head_sha,
                                     status, action, posted, dedupe_key, started_at, finished_at)
        SELECT id, pipeline_id, trigger, ref_type, ref, head_sha,
               status, action, posted, dedupe_key, started_at, finished_at
        FROM pipeline_runs;
      DROP TABLE pipeline_runs;
      ALTER TABLE pipeline_runs_new RENAME TO pipeline_runs;
      CREATE INDEX idx_pipeline_runs_pipeline ON pipeline_runs (pipeline_id);
      CREATE INDEX idx_pipeline_runs_dedupe ON pipeline_runs (dedupe_key);
    `)
    const violations = db.pragma('foreign_key_check') as unknown[]
    if (Array.isArray(violations) && violations.length > 0) {
      throw new Error('v17 migration left dangling foreign keys')
    }
  },
  // v18 — persisted panel reviews. A panel owns several normal child runs on the
  // same target, so History/Cockpit can show one consolidated review while each
  // child still keeps its transcript, output, findings, kill/status lifecycle, and
  // GitHub-write safety boundaries.
  (db) => {
    db.exec(`
      CREATE TABLE run_groups (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id         INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        ref_type        TEXT    NOT NULL CHECK (ref_type IN ('commit','pr','working-tree','project')),
        ref_id          TEXT    NOT NULL,
        head_sha        TEXT    NOT NULL,
        started_at      TEXT    NOT NULL,
        posted_url      TEXT,
        local_status    TEXT    NOT NULL DEFAULT 'open'
          CHECK (local_status IN ('open','handled','verified')),
        local_status_at TEXT,
        author_login    TEXT
      );
      CREATE INDEX idx_run_groups_repo ON run_groups (repo_id);
      CREATE INDEX idx_run_groups_target ON run_groups (repo_id, ref_type, ref_id, head_sha);

      CREATE TABLE run_group_items (
        group_id INTEGER NOT NULL REFERENCES run_groups(id) ON DELETE CASCADE,
        run_id   INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        agent_id TEXT    NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (group_id, run_id),
        UNIQUE (run_id)
      );
      CREATE INDEX idx_run_group_items_group ON run_group_items (group_id, position);
    `)
  }
]

let db: Database.Database | null = null

function migrate(database: Database.Database): void {
  const current = database.pragma('user_version', { simple: true }) as number
  for (let version = current; version < MIGRATIONS.length; version++) {
    const run = MIGRATIONS[version]
    const next = version + 1
    // Disable FK enforcement around the migration. PRAGMA foreign_keys is a no-op
    // inside a transaction, so it MUST be toggled out here. A migration that rebuilds
    // a referenced table (e.g. v12 relaxing a CHECK) relies on this so DROP TABLE
    // doesn't cascade-delete child rows; for every other migration it's harmless
    // (migrations are trusted DDL). FK enforcement is restored after each step.
    database.pragma('foreign_keys = OFF')
    try {
      const tx = database.transaction(() => {
        run(database)
        database.pragma(`user_version = ${next}`)
      })
      tx()
    } finally {
      database.pragma('foreign_keys = ON')
    }
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
  reconcileInterruptedPipelineRuns()
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

/**
 * Pipeline-run crash recovery (M9a): on startup no pipeline run can still be live, so
 * any row left 'pending'/'running' was interrupted (crash/quit) — mark it 'error'. This
 * does NOT touch `watches.last_seen_sha`, so an interrupted delta stays unprocessed and
 * the poller re-detects it (no delta is skipped past an unfinished run).
 */
export function reconcileInterruptedPipelineRuns(): number {
  return requireDb()
    .prepare(
      `UPDATE pipeline_runs SET status = 'error', finished_at = ?
       WHERE status IN ('pending','running')`
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

/** A cached conditional-GET response: its ETag plus the serialized body to replay on a 304. */
export interface CacheEntry {
  etag: string
  payload: string | null
}

/** Reads a cached ETag + payload (M8 commit/PR list caching). Undefined if never stored. */
export function getCacheEntry(key: string): CacheEntry | undefined {
  return requireDb().prepare(`SELECT etag, payload FROM http_cache WHERE key = ?`).get(key) as
    | CacheEntry
    | undefined
}

/** Stores an ETag together with the JSON body to serve on the next 304 (M8). */
export function setCacheEntry(key: string, etag: string, payload: string, updatedAt: string): void {
  requireDb()
    .prepare(
      `INSERT INTO http_cache (key, etag, payload, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         etag = excluded.etag, payload = excluded.payload, updated_at = excluded.updated_at`
    )
    .run(key, etag, payload, updatedAt)
}

// --- automation watches (M8) -------------------------------------------------
// Tracks the last-seen head SHA / PR head per watched repo ref so the poller can
// report a delta only when it actually changes. last_seen_sha advances exclusively
// via markWatchSeen (after a delta is processed), never on a bare poll.

export type WatchRefType = 'commit' | 'pr'

export interface WatchRow {
  id: number
  repo_id: number
  ref_type: WatchRefType
  ref: string
  last_seen_sha: string | null
  last_polled_at: string | null
}

export function getWatch(repoId: number, refType: WatchRefType, ref: string): WatchRow | undefined {
  return requireDb()
    .prepare(`SELECT * FROM watches WHERE repo_id = ? AND ref_type = ? AND ref = ?`)
    .get(repoId, refType, ref) as WatchRow | undefined
}

/** Creates the watch row if absent (idempotent); returns the current row. */
export function upsertWatch(repoId: number, refType: WatchRefType, ref: string): WatchRow {
  requireDb()
    .prepare(
      `INSERT INTO watches (repo_id, ref_type, ref) VALUES (?, ?, ?)
       ON CONFLICT (repo_id, ref_type, ref) DO NOTHING`
    )
    .run(repoId, refType, ref)
  return getWatch(repoId, refType, ref)!
}

/** Records that a poll happened (without consuming the delta — last_seen_sha untouched). */
export function touchWatchPolled(
  repoId: number,
  refType: WatchRefType,
  ref: string,
  polledAt: string
): void {
  requireDb()
    .prepare(`UPDATE watches SET last_polled_at = ? WHERE repo_id = ? AND ref_type = ? AND ref = ?`)
    .run(polledAt, repoId, refType, ref)
}

/** Advances the last-seen head SHA after a delta has been processed (consumes it). */
export function markWatchSeen(
  repoId: number,
  refType: WatchRefType,
  ref: string,
  sha: string,
  polledAt: string
): void {
  requireDb()
    .prepare(
      `UPDATE watches SET last_seen_sha = ?, last_polled_at = ?
       WHERE repo_id = ? AND ref_type = ? AND ref = ?`
    )
    .run(sha, polledAt, repoId, refType, ref)
}

export function listWatchesForRepo(repoId: number): WatchRow[] {
  return requireDb()
    .prepare(`SELECT * FROM watches WHERE repo_id = ? ORDER BY ref_type ASC, ref ASC`)
    .all(repoId) as WatchRow[]
}

// --- agent runs (Stage 5) ----------------------------------------------------

export type RunStatusValue = 'queued' | 'running' | 'done' | 'error' | 'killed'

export interface RunRow {
  id: number
  repo_id: number
  ref_type: RefType
  ref_id: string
  head_sha: string
  agent_id: string
  status: RunStatusValue
  exit_code: number | null
  started_at: string
  finished_at: string | null
  output_path: string | null
  posted_url: string | null
  local_status: RunLocalStatus
  local_status_at: string | null
  author_login: string | null
}

export interface NewRun {
  repoId: number
  refType: RefType
  refId: string
  headSha: string
  agentId: string
  startedAt: string
  authorLogin?: string | null
}

export interface RunGroupRow {
  id: number
  repo_id: number
  ref_type: RefType
  ref_id: string
  head_sha: string
  started_at: string
  posted_url: string | null
  local_status: RunLocalStatus
  local_status_at: string | null
  author_login: string | null
}

export interface RunGroupRowWithRepo extends RunGroupRow {
  full_name: string
  account_id: number
}

export interface RunGroupItemRow {
  group_id: number
  run_id: number
  agent_id: string
  position: number
}

export interface NewRunGroup {
  repoId: number
  refType: RefType
  refId: string
  headSha: string
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

export function insertRunGroup(group: NewRunGroup): RunGroupRow {
  const result = requireDb()
    .prepare(
      `INSERT INTO run_groups (repo_id, ref_type, ref_id, head_sha, started_at, author_login)
       VALUES (@repoId, @refType, @refId, @headSha, @startedAt, @authorLogin)`
    )
    .run({ ...group, authorLogin: group.authorLogin ?? null })
  return getRunGroup(Number(result.lastInsertRowid))!
}

export function addRunToGroup(
  groupId: number,
  runId: number,
  agentId: string,
  position: number
): void {
  requireDb()
    .prepare(
      `INSERT INTO run_group_items (group_id, run_id, agent_id, position)
       VALUES (?, ?, ?, ?)`
    )
    .run(groupId, runId, agentId, position)
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

export function setRunGroupPostedUrl(id: number, url: string): void {
  requireDb().prepare(`UPDATE run_groups SET posted_url = ? WHERE id = ?`).run(url, id)
}

export function updateRunLocalStatus(
  id: number,
  localStatus: RunLocalStatus,
  localStatusAt: string | null
): void {
  requireDb()
    .prepare(`UPDATE runs SET local_status = ?, local_status_at = ? WHERE id = ?`)
    .run(localStatus, localStatusAt, id)
}

export function updateRunGroupLocalStatus(
  id: number,
  localStatus: RunLocalStatus,
  localStatusAt: string | null
): void {
  requireDb()
    .prepare(`UPDATE run_groups SET local_status = ?, local_status_at = ? WHERE id = ?`)
    .run(localStatus, localStatusAt, id)
}

export function getRun(id: number): RunRow | undefined {
  return requireDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined
}

export function getRunGroup(id: number): RunGroupRow | undefined {
  return requireDb().prepare(`SELECT * FROM run_groups WHERE id = ?`).get(id) as
    | RunGroupRow
    | undefined
}

export function getRunGroupWithRepo(id: number): RunGroupRowWithRepo | undefined {
  return requireDb()
    .prepare(
      `SELECT run_groups.*, repos.full_name, repos.account_id FROM run_groups
       JOIN repos ON repos.id = run_groups.repo_id
       WHERE run_groups.id = ?`
    )
    .get(id) as RunGroupRowWithRepo | undefined
}

export function listRunsForRepo(repoId: number): RunRow[] {
  return requireDb()
    .prepare(`SELECT * FROM runs WHERE repo_id = ? ORDER BY started_at DESC, id DESC`)
    .all(repoId) as RunRow[]
}

export function listRunGroupsForRepo(repoId: number): RunGroupRow[] {
  return requireDb()
    .prepare(`SELECT * FROM run_groups WHERE repo_id = ? ORDER BY started_at DESC, id DESC`)
    .all(repoId) as RunGroupRow[]
}

export function listRunGroupItems(groupId: number): RunGroupItemRow[] {
  return requireDb()
    .prepare(`SELECT * FROM run_group_items WHERE group_id = ? ORDER BY position ASC, run_id ASC`)
    .all(groupId) as RunGroupItemRow[]
}

export function listRunsForGroup(groupId: number): RunRow[] {
  return requireDb()
    .prepare(
      `SELECT runs.* FROM run_group_items
       JOIN runs ON runs.id = run_group_items.run_id
       WHERE run_group_items.group_id = ?
       ORDER BY run_group_items.position ASC, runs.id ASC`
    )
    .all(groupId) as RunRow[]
}

export function listRunsForGroupWithRepo(groupId: number): RunRowWithRepo[] {
  return requireDb()
    .prepare(
      `SELECT runs.*, repos.full_name, repos.account_id FROM run_group_items
       JOIN runs ON runs.id = run_group_items.run_id
       JOIN repos ON repos.id = runs.repo_id
       WHERE run_group_items.group_id = ?
       ORDER BY run_group_items.position ASC, runs.id ASC`
    )
    .all(groupId) as RunRowWithRepo[]
}

export function getRunGroupForRun(runId: number): RunGroupRow | undefined {
  return requireDb()
    .prepare(
      `SELECT run_groups.* FROM run_group_items
       JOIN run_groups ON run_groups.id = run_group_items.group_id
       WHERE run_group_items.run_id = ?`
    )
    .get(runId) as RunGroupRow | undefined
}

export interface RunRowWithRepo extends RunRow {
  full_name: string
  account_id: number
}

/**
 * True if an equivalent run is already queued/running. Keyed on (repo, head SHA,
 * ref type, ref id, agent), so a project audit and a commit review on the same SHA
 * are not treated as duplicates.
 */
export function hasActiveRun(
  repoId: number,
  refType: RefType,
  refId: string,
  sha: string,
  agentId: string
): boolean {
  return !!requireDb()
    .prepare(
      `SELECT 1 FROM runs
       WHERE repo_id = ? AND ref_type = ? AND ref_id = ? AND head_sha = ? AND agent_id = ?
       AND status IN ('queued','running') LIMIT 1`
    )
    .get(repoId, refType, refId, sha, agentId)
}

/**
 * All runs across repos, newest first, with the repo's full name and owning
 * account id (the latter lets the history view scope runs per account).
 */
export function listAllRuns(limit = 200): RunRowWithRepo[] {
  return requireDb()
    .prepare(
      `SELECT runs.*, repos.full_name, repos.account_id FROM runs
       JOIN repos ON repos.id = runs.repo_id
       ORDER BY runs.started_at DESC, runs.id DESC
       LIMIT ?`
    )
    .all(limit) as RunRowWithRepo[]
}

export function listAllUngroupedRuns(limit = 200): RunRowWithRepo[] {
  return requireDb()
    .prepare(
      `SELECT runs.*, repos.full_name, repos.account_id FROM runs
       JOIN repos ON repos.id = runs.repo_id
       LEFT JOIN run_group_items ON run_group_items.run_id = runs.id
       WHERE run_group_items.group_id IS NULL
       ORDER BY runs.started_at DESC, runs.id DESC
       LIMIT ?`
    )
    .all(limit) as RunRowWithRepo[]
}

export function listAllRunGroups(limit = 200): RunGroupRowWithRepo[] {
  return requireDb()
    .prepare(
      `SELECT run_groups.*, repos.full_name, repos.account_id FROM run_groups
       JOIN repos ON repos.id = run_groups.repo_id
       ORDER BY run_groups.started_at DESC, run_groups.id DESC
       LIMIT ?`
    )
    .all(limit) as RunGroupRowWithRepo[]
}

// --- structured findings (M4) ------------------------------------------------

export interface FindingRow {
  id: number
  run_id: number
  tool: string
  rule_id: string | null
  severity: string
  file: string
  line: number | null
  message: string
  fingerprint: string
}

/** Persists a run's normalized findings (one transaction). No-op for an empty set. */
export function insertFindings(runId: number, findings: Finding[]): void {
  if (findings.length === 0) return
  const database = requireDb()
  const stmt = database.prepare(
    `INSERT INTO findings (run_id, tool, rule_id, severity, file, line, message, fingerprint)
     VALUES (@runId, @tool, @ruleId, @severity, @file, @line, @message, @fingerprint)`
  )
  const tx = database.transaction((fs: Finding[]) => {
    for (const f of fs) {
      stmt.run({
        runId,
        tool: f.tool,
        ruleId: f.ruleId,
        severity: f.severity,
        file: f.file,
        line: f.line,
        message: f.message,
        fingerprint: f.fingerprint
      })
    }
  })
  tx(findings)
}

export function listFindingsForRun(runId: number): FindingRow[] {
  return requireDb()
    .prepare(`SELECT * FROM findings WHERE run_id = ? ORDER BY id ASC`)
    .all(runId) as FindingRow[]
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

/** Removes a setting key (e.g. clearing a stale discovered-models cache). */
export function deleteSetting(key: string): void {
  requireDb().prepare(`DELETE FROM settings WHERE key = ?`).run(key)
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

// --- automation pipelines (M9a) ----------------------------------------------
// The authored config is the source of truth, persisted as JSON in `config`. The
// promoted columns (enabled, action_kind, auto_post) are DERIVED from the draft on
// every write and used for cheap querying + a SQL-level auto-post guard; never set
// them out of sync with the JSON. Row→Pipeline reconstruction lives in the engine
// layer (it parses `config` and overlays the row id).

export interface PipelineRow {
  id: number
  repo_id: number
  name: string
  trigger: PipelineTrigger
  enabled: number
  action_kind: PipelineActionKind
  auto_post: number
  config: string
  created_at: string
  updated_at: string
}

export function insertPipeline(draft: PipelineDraft, now: string): PipelineRow {
  const result = requireDb()
    .prepare(
      `INSERT INTO pipelines (repo_id, name, trigger, enabled, action_kind, auto_post, config,
                              created_at, updated_at)
       VALUES (@repoId, @name, @trigger, @enabled, @actionKind, @autoPost, @config, @now, @now)`
    )
    .run({
      repoId: draft.repoId,
      name: draft.name,
      trigger: draft.trigger,
      enabled: draft.enabled ? 1 : 0,
      actionKind: draft.action.kind,
      autoPost: draft.action.autoPost ? 1 : 0,
      config: JSON.stringify(draft),
      now
    })
  return getPipelineRow(Number(result.lastInsertRowid))!
}

/** Replaces a pipeline's config (and the derived promoted columns). */
export function updatePipeline(id: number, draft: PipelineDraft, now: string): boolean {
  return (
    requireDb()
      .prepare(
        `UPDATE pipelines SET
           name = @name, trigger = @trigger, enabled = @enabled, action_kind = @actionKind,
           auto_post = @autoPost, config = @config, updated_at = @now
         WHERE id = @id`
      )
      .run({
        id,
        name: draft.name,
        trigger: draft.trigger,
        enabled: draft.enabled ? 1 : 0,
        actionKind: draft.action.kind,
        autoPost: draft.action.autoPost ? 1 : 0,
        config: JSON.stringify(draft),
        now
      }).changes > 0
  )
}

function syncPipelineConfigEnabled(config: string, enabled: boolean): string {
  try {
    const parsed = JSON.parse(config) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, enabled })
    }
  } catch {
    // Leave malformed config untouched; parsePipelineRow will reject it on read.
  }
  return config
}

/** Toggles a pipeline's enabled flag; returns false if no such pipeline exists. */
export function setPipelineEnabled(id: number, enabled: boolean): boolean {
  const database = requireDb()
  const row = database.prepare(`SELECT config FROM pipelines WHERE id = ?`).get(id) as
    | { config: string }
    | undefined
  if (!row) return false
  return (
    database
      .prepare(`UPDATE pipelines SET enabled = ?, config = ?, updated_at = ? WHERE id = ?`)
      .run(
        enabled ? 1 : 0,
        syncPipelineConfigEnabled(row.config, enabled),
        new Date().toISOString(),
        id
      ).changes > 0
  )
}

export function deletePipeline(id: number): boolean {
  return requireDb().prepare(`DELETE FROM pipelines WHERE id = ?`).run(id).changes > 0
}

export function getPipelineRow(id: number): PipelineRow | undefined {
  return requireDb().prepare(`SELECT * FROM pipelines WHERE id = ?`).get(id) as
    | PipelineRow
    | undefined
}

export function listPipelineRows(): PipelineRow[] {
  return requireDb()
    .prepare(`SELECT * FROM pipelines ORDER BY created_at ASC, id ASC`)
    .all() as PipelineRow[]
}

export function listPipelineRowsForRepo(repoId: number): PipelineRow[] {
  return requireDb()
    .prepare(`SELECT * FROM pipelines WHERE repo_id = ? ORDER BY created_at ASC, id ASC`)
    .all(repoId) as PipelineRow[]
}

/** Enabled pipelines only — what the poller schedules (saves a parse of disabled rows). */
export function listEnabledPipelineRows(): PipelineRow[] {
  return requireDb()
    .prepare(`SELECT * FROM pipelines WHERE enabled = 1 ORDER BY id ASC`)
    .all() as PipelineRow[]
}

// --- pipeline runs (execution history + dedupe) ------------------------------

export interface PipelineRunRow {
  id: number
  pipeline_id: number
  trigger: PipelineTrigger
  ref_type: RefType
  ref: string
  head_sha: string
  status: PipelineRunStatus
  action: PipelineActionKind
  posted: number
  dedupe_key: string
  started_at: string
  finished_at: string | null
}

export interface NewPipelineRun {
  pipelineId: number
  trigger: PipelineTrigger
  refType: RefType
  ref: string
  headSha: string
  action: PipelineActionKind
  dedupeKey: string
  startedAt: string
}

export function insertPipelineRun(run: NewPipelineRun): PipelineRunRow {
  const result = requireDb()
    .prepare(
      `INSERT INTO pipeline_runs (pipeline_id, trigger, ref_type, ref, head_sha, status, action,
                                  dedupe_key, started_at)
       VALUES (@pipelineId, @trigger, @refType, @ref, @headSha, 'pending', @action,
               @dedupeKey, @startedAt)`
    )
    .run(run)
  return getPipelineRun(Number(result.lastInsertRowid))!
}

export function updatePipelineRunStatus(
  id: number,
  status: PipelineRunStatus,
  finishedAt?: string | null
): void {
  requireDb()
    .prepare(
      `UPDATE pipeline_runs SET status = @status, finished_at = COALESCE(@finishedAt, finished_at)
       WHERE id = @id`
    )
    .run({ id, status, finishedAt: finishedAt ?? null })
}

/** Flags a run as having actually written to GitHub (an enabled auto-post). */
export function setPipelineRunPosted(id: number): void {
  requireDb().prepare(`UPDATE pipeline_runs SET posted = 1 WHERE id = ?`).run(id)
}

export function getPipelineRun(id: number): PipelineRunRow | undefined {
  return requireDb().prepare(`SELECT * FROM pipeline_runs WHERE id = ?`).get(id) as
    | PipelineRunRow
    | undefined
}

export function listPipelineRunsForPipeline(pipelineId: number, limit = 100): PipelineRunRow[] {
  return requireDb()
    .prepare(
      `SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`
    )
    .all(pipelineId, limit) as PipelineRunRow[]
}

/**
 * The most recent COMPLETED run for a dedupe key, or undefined. The poller consults
 * this to skip identical work on an unchanged head — only a 'done' run counts as
 * "already processed" (an errored/skipped run should be retried). The key deliberately
 * excludes pipeline identity (see `pipelineConfigHash`), so two pipelines whose work is
 * byte-identical share this cache — intentional, not a per-pipeline lookup.
 */
export function findCompletedPipelineRunByDedupe(dedupeKey: string): PipelineRunRow | undefined {
  return requireDb()
    .prepare(
      `SELECT * FROM pipeline_runs WHERE dedupe_key = ? AND status = 'done'
       ORDER BY id DESC LIMIT 1`
    )
    .get(dedupeKey) as PipelineRunRow | undefined
}

// --- guardrail inputs (M9a engine) -------------------------------------------
// These feed the pure `checkGuardrails` via `assembleGuardrailState`.

/** Runs this pipeline currently has in flight (pending/running) — the concurrency cap input. */
export function countActivePipelineRuns(pipelineId: number): number {
  return (
    requireDb()
      .prepare(
        `SELECT COUNT(*) c FROM pipeline_runs WHERE pipeline_id = ? AND status IN ('pending','running')`
      )
      .get(pipelineId) as { c: number }
  ).c
}

/**
 * This pipeline's run-start timestamps at/after `sinceIso` — the runs-per-hour input. The
 * lexical `started_at >= sinceIso` compare is valid because every timestamp is a fixed-width
 * `Date.toISOString()` (ms precision), so lexical order == chronological order.
 */
export function recentPipelineRunStarts(pipelineId: number, sinceIso: string): string[] {
  return (
    requireDb()
      .prepare(
        `SELECT started_at FROM pipeline_runs WHERE pipeline_id = ? AND started_at >= ?
         ORDER BY started_at DESC`
      )
      .all(pipelineId, sinceIso) as { started_at: string }[]
  ).map((r) => r.started_at)
}

/** Most recent pipeline-run start for ANY pipeline of this repo — the per-repo cooldown input. */
export function lastRepoPipelineRunStart(repoId: number): string | null {
  const row = requireDb()
    .prepare(
      `SELECT pr.started_at FROM pipeline_runs pr JOIN pipelines p ON p.id = pr.pipeline_id
       WHERE p.repo_id = ? ORDER BY pr.started_at DESC LIMIT 1`
    )
    .get(repoId) as { started_at: string } | undefined
  return row?.started_at ?? null
}
