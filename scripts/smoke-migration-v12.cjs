#!/usr/bin/env node
// Stage smoke for the runs.ref_type rebuild migrations: runs INSIDE Electron
// (real better-sqlite3 ABI) and proves the runs-table CHECK relaxations are safe:
//   1. existing 'commit'/'pr' runs survive the rebuild (rows + values preserved);
//   2. a pre-existing finding survives — dropping `runs` with FK enforcement OFF does
//      NOT cascade-delete `findings` (the data-loss trap this migration must avoid);
//   3. after the rebuild, a 'working-tree' run INSERTs successfully;
//   4. after the project-review rebuild, a 'project' run INSERTs successfully;
//   5. an invalid ref_type is still rejected by the new CHECK;
//   6. ON DELETE CASCADE still works post-rebuild (delete a run → its findings go);
//   7. foreign_key_check reports no violations.
// Mirrors the exact v11 schema + v12 rebuild SQL in src/main/store.ts.
// Run: `npm run smoke:migration`

const { app } = require('electron')
const Database = require('better-sqlite3')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

app.whenReady().then(() => {
  try {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')

    // --- v4/v7/v11 baseline: the runs table as it existed BEFORE v12 (CHECK without
    //     'working-tree'), plus the findings table that FK-cascades off it. ---
    db.exec(`
      CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT);
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
        posted_url  TEXT,
        author_login TEXT
      );
      CREATE INDEX idx_runs_repo ON runs (repo_id);
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

    const repoId = db.prepare(`INSERT INTO repos (full_name) VALUES ('o/r')`).run().lastInsertRowid
    const insRun = db.prepare(
      `INSERT INTO runs (repo_id, ref_type, ref_id, head_sha, agent_id, status, started_at, author_login)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const commitRunId = insRun.run(
      repoId,
      'commit',
      'abc',
      'a'.repeat(40),
      'codex',
      'done',
      '2026-01-01T00:00:00Z',
      'octocat'
    ).lastInsertRowid
    insRun.run(repoId, 'pr', '42', 'b'.repeat(40), 'qwen', 'done', '2026-01-02T00:00:00Z', null)
    // A finding hanging off the commit run — must survive the runs rebuild.
    db.prepare(
      `INSERT INTO findings (run_id, tool, rule_id, severity, file, line, message, fingerprint)
       VALUES (?, 'eslint', 'no-debugger', 'medium', 'x.ts', 3, 'msg', 'fp1')`
    ).run(commitRunId)

    const runsBefore = db.prepare(`SELECT COUNT(*) c FROM runs`).get().c
    const findingsBefore = db.prepare(`SELECT COUNT(*) c FROM findings`).get().c
    assert(runsBefore === 2, `expected 2 runs before, got ${runsBefore}`)
    assert(findingsBefore === 1, `expected 1 finding before, got ${findingsBefore}`)

    // --- v12 rebuild, exactly as migrate() runs it: FK enforcement OFF (outside any
    //     transaction) so DROP TABLE runs does NOT cascade-delete findings. ---
    db.pragma('foreign_keys = OFF')
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
    const violations = db.pragma('foreign_key_check')
    assert(
      Array.isArray(violations) && violations.length === 0,
      `foreign_key_check reported violations: ${JSON.stringify(violations)}`
    )
    db.pragma('foreign_keys = ON')

    // (1) existing runs preserved, with values intact.
    const runsAfter = db.prepare(`SELECT COUNT(*) c FROM runs`).get().c
    assert(runsAfter === 2, `runs lost in rebuild: ${runsBefore} → ${runsAfter}`)
    const commitRow = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(commitRunId)
    assert(commitRow.ref_type === 'commit' && commitRow.author_login === 'octocat', 'row corrupted')

    // (2) the finding survived (no cascade-wipe on DROP TABLE runs).
    const findingsAfter = db.prepare(`SELECT COUNT(*) c FROM findings`).get().c
    assert(findingsAfter === 1, `findings cascade-wiped by the rebuild: ${findingsAfter}`)

    // (3) a working-tree run now inserts.
    const wtRunId = insRun.run(
      repoId,
      'working-tree',
      'working-tree',
      'c'.repeat(40),
      'codex',
      'done',
      '2026-06-22T00:00:00Z',
      null
    ).lastInsertRowid
    assert(typeof wtRunId === 'number' || typeof wtRunId === 'bigint', 'working-tree insert failed')

    // --- v15 rebuild: relax the same CHECK again to add project-wide reviews. ---
    db.pragma('foreign_keys = OFF')
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
    const projectViolations = db.pragma('foreign_key_check')
    assert(
      Array.isArray(projectViolations) && projectViolations.length === 0,
      `v15 foreign_key_check reported violations: ${JSON.stringify(projectViolations)}`
    )
    db.pragma('foreign_keys = ON')

    // (4) a project run now inserts.
    const insRunV15 = db.prepare(
      `INSERT INTO runs (repo_id, ref_type, ref_id, head_sha, agent_id, status, started_at, author_login)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const projectRunId = insRunV15.run(
      repoId,
      'project',
      'main',
      'e'.repeat(40),
      'codex',
      'done',
      '2026-06-23T00:00:00Z',
      null
    ).lastInsertRowid
    assert(
      typeof projectRunId === 'number' || typeof projectRunId === 'bigint',
      'project insert failed'
    )

    // (5) an invalid ref_type is still rejected.
    let rejected = false
    try {
      insRunV15.run(repoId, 'nonsense', 'x', 'd'.repeat(40), 'codex', 'done', 'now', null)
    } catch {
      rejected = true
    }
    assert(rejected, 'invalid ref_type was accepted — CHECK constraint not enforced')

    // (6) cascade still works after the rebuild: delete the commit run → its finding goes.
    db.prepare(`DELETE FROM runs WHERE id = ?`).run(commitRunId)
    const orphans = db
      .prepare(`SELECT COUNT(*) c FROM findings WHERE run_id = ?`)
      .get(commitRunId).c
    assert(orphans === 0, `ON DELETE CASCADE broken after rebuild: ${orphans} orphan findings`)

    db.close()
    console.log('\n✅ runs ref_type migration smoke PASSED — rebuilds kept findings,')
    console.log('   working-tree and project accepted, invalid refs rejected, cascade intact.')
    app.exit(0)
  } catch (err) {
    console.error('\n❌ runs ref_type migration smoke FAILED:', err.message)
    app.exit(1)
  }
})
