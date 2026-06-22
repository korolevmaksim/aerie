#!/usr/bin/env node
// Stage smoke for the M4 findings store: runs INSIDE Electron (real better-sqlite3
// ABI) and proves the v11 `findings` schema is valid SQL and behaves correctly:
//   1. the table + index create cleanly;
//   2. findings insert and read back in order with the expected columns;
//   3. ON DELETE CASCADE removes a run's findings when the run is deleted (no orphans).
// Run: `npm run smoke:findings`

const { app } = require('electron')
const Database = require('better-sqlite3')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

app.whenReady().then(() => {
  try {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    // Minimal runs table + the real v11 findings schema (mirrors store.ts).
    db.exec(`
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT);
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

    const runId = db.prepare(`INSERT INTO runs (status) VALUES ('done')`).run().lastInsertRowid
    const ins = db.prepare(
      `INSERT INTO findings (run_id, tool, rule_id, severity, file, line, message, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    ins.run(
      runId,
      'eslint',
      'no-debugger',
      'medium',
      'bad.js',
      3,
      "Unexpected 'debugger'.",
      'aaaa1111'
    )
    ins.run(
      runId,
      'gitleaks',
      'generic-api-key',
      'high',
      'data.json',
      2,
      'Generic API Key',
      'bbbb2222'
    )

    const rows = db.prepare(`SELECT * FROM findings WHERE run_id = ? ORDER BY id`).all(runId)
    assert(rows.length === 2, `expected 2 findings, got ${rows.length}`)
    assert(rows[1].severity === 'high' && rows[1].tool === 'gitleaks', 'second finding mismatch')
    assert(rows[0].line === 3, 'line not persisted as integer')

    // ON DELETE CASCADE: removing the run wipes its findings.
    db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId)
    const remaining = db.prepare(`SELECT COUNT(*) AS c FROM findings`).get().c
    assert(remaining === 0, `findings did not cascade-delete with the run (${remaining} left)`)

    db.close()
    process.stdout.write(
      '\nFINDINGS_OK — v11 findings schema valid, rows round-trip, FK cascade works.\n'
    )
    app.exit(0)
  } catch (err) {
    process.stderr.write(`\nFINDINGS_FAIL — ${err.message}\n`)
    app.exit(1)
  }
})
