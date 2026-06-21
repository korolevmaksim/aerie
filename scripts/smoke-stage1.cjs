// Stage 1 smoke — runs INSIDE Electron (so safeStorage + the native better-sqlite3
// ABI are real) and proves the runtime stack the auth/store layers depend on:
//   1. safeStorage encrypts/decrypts a secret round-trip (token-at-rest primitive)
//   2. better-sqlite3 opens, migrates the accounts schema, stores an ENCRYPTED
//      token blob, reads it back, and the blob is ciphertext (not the plaintext)
//   3. delete removes the row (and with it the stored token)
//
// The full add-by-real-PAT → GitHub validate flow is verified manually with a
// live token (it needs network + a real GitHub account). Run: `npm run smoke:stage1`.

const { app, safeStorage } = require('electron')
const Database = require('better-sqlite3')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

app.whenReady().then(() => {
  let dir
  try {
    // 1. safeStorage round-trip
    assert(safeStorage.isEncryptionAvailable(), 'safeStorage encryption not available')
    const secret = 'ghp_smoke_token_DO_NOT_USE_1234567890'
    const blob = safeStorage.encryptString(secret)
    assert(Buffer.isBuffer(blob), 'encrypted token is not a Buffer')
    assert(!blob.toString('utf8').includes(secret), 'plaintext token leaked into ciphertext blob')
    assert(safeStorage.decryptString(blob) === secret, 'decrypt did not round-trip')

    // 2. better-sqlite3 with the accounts schema (mirrors store.ts migration v1)
    dir = mkdtempSync(join(tmpdir(), 'aerie-smoke-'))
    const db = new Database(join(dir, 'aerie.db'))
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user','org')),
        login TEXT NOT NULL UNIQUE,
        token_blob BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    const info = db
      .prepare(
        `INSERT INTO accounts (label, kind, login, token_blob, created_at)
         VALUES (?, 'user', ?, ?, ?)`
      )
      .run('smoke', 'octocat', blob, new Date().toISOString())
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(info.lastInsertRowid)
    assert(row && row.login === 'octocat', 'inserted account not found')
    assert(Buffer.isBuffer(row.token_blob), 'stored token_blob is not binary')
    assert(safeStorage.decryptString(row.token_blob) === secret, 'stored token did not decrypt')

    // 3. delete wipes the row + token
    const del = db.prepare('DELETE FROM accounts WHERE id = ?').run(info.lastInsertRowid)
    assert(del.changes === 1, 'delete did not remove the row')
    assert(
      !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(info.lastInsertRowid),
      'row survived delete'
    )
    db.close()

    process.stdout.write(
      `\nSTAGE1_OK — safeStorage round-trip ok, encrypted token stored & wiped, ABI=${process.versions.modules}\n`
    )
    app.exit(0)
  } catch (err) {
    process.stderr.write(`\nSTAGE1_FAIL — ${err.message}\n`)
    app.exit(1)
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})
