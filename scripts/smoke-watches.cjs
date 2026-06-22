#!/usr/bin/env node
// Stage smoke for the M8 v13 "polling foundation" migration + store helpers: runs
// INSIDE Electron (real better-sqlite3 ABI) and proves:
//   1. http_cache gains a nullable `payload`; legacy ETag-only rows keep payload NULL,
//      and setCacheEntry round-trips an ETag + JSON body (getCacheEntry reads both);
//   2. the `watches` UNIQUE(repo_id, ref_type, ref) holds — upsertWatch is idempotent;
//   3. touchWatchPolled records last_polled_at WITHOUT advancing last_seen_sha
//      (a bare poll must never consume an unprocessed delta);
//   4. markWatchSeen advances last_seen_sha (delta processed);
//   5. the ref_type CHECK rejects anything but 'commit'/'pr';
//   6. ON DELETE CASCADE removes a repo's watches with it;
//   7. foreign_key_check reports no violations.
// Mirrors the exact v2 http_cache + v13 SQL and the helper statements in
// src/main/store.ts — keep in sync if either changes.
// Run: `npm run smoke:watches`

const { app } = require('electron')
const Database = require('better-sqlite3')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function expectThrows(fn, label) {
  let threw = false
  try {
    fn()
  } catch {
    threw = true
  }
  assert(threw, `expected ${label} to throw`)
}

app.whenReady().then(() => {
  try {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')

    // --- baseline: repos (FK parent) + the v2 http_cache (etag-only). ---
    db.exec(`
      CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT);
      CREATE TABLE http_cache (
        key        TEXT PRIMARY KEY,
        etag       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    // A legacy ETag-only row, written before v13 added the payload column.
    db.prepare(`INSERT INTO http_cache (key, etag, updated_at) VALUES (?, ?, ?)`).run(
      'repos:list:1',
      '"legacy-etag"',
      '2026-01-01T00:00:00Z'
    )

    // --- v13 migration, exactly as store.ts applies it. ---
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

    // 1. payload column: the legacy row survives with payload NULL; setCacheEntry round-trips.
    const legacy = db
      .prepare(`SELECT etag, payload FROM http_cache WHERE key = ?`)
      .get('repos:list:1')
    assert(legacy.etag === '"legacy-etag"', 'legacy etag preserved')
    assert(legacy.payload === null, 'legacy row has NULL payload')

    const setCacheEntry = db.prepare(
      `INSERT INTO http_cache (key, etag, payload, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         etag = excluded.etag, payload = excluded.payload, updated_at = excluded.updated_at`
    )
    const body = JSON.stringify({ items: [{ sha: 'deadbeef' }], hasMore: false })
    setCacheEntry.run('commits:1:o/r::1', '"c-etag"', body, '2026-06-22T00:00:00Z')
    const entry = db
      .prepare(`SELECT etag, payload FROM http_cache WHERE key = ?`)
      .get('commits:1:o/r::1')
    assert(entry.etag === '"c-etag"', 'cache etag stored')
    assert(JSON.parse(entry.payload).items[0].sha === 'deadbeef', 'cache payload round-trips')
    // Upsert updates payload in place.
    const body2 = JSON.stringify({ items: [{ sha: 'cafef00d' }], hasMore: true })
    setCacheEntry.run('commits:1:o/r::1', '"c-etag2"', body2, '2026-06-22T01:00:00Z')
    const updated = db
      .prepare(`SELECT etag, payload FROM http_cache WHERE key = ?`)
      .get('commits:1:o/r::1')
    assert(updated.etag === '"c-etag2"', 'cache etag updated')
    assert(JSON.parse(updated.payload).hasMore === true, 'cache payload updated')

    // --- watches: upsert / touch / mark-seen, exactly as the store helpers. ---
    const repoId = db.prepare(`INSERT INTO repos (full_name) VALUES ('o/r')`).run().lastInsertRowid
    const otherRepo = db
      .prepare(`INSERT INTO repos (full_name) VALUES ('o/other')`)
      .run().lastInsertRowid
    const upsertWatch = db.prepare(
      `INSERT INTO watches (repo_id, ref_type, ref) VALUES (?, ?, ?)
       ON CONFLICT (repo_id, ref_type, ref) DO NOTHING`
    )
    const getWatch = db.prepare(
      `SELECT * FROM watches WHERE repo_id = ? AND ref_type = ? AND ref = ?`
    )

    // 2. upsert is idempotent under the UNIQUE constraint.
    upsertWatch.run(repoId, 'commit', 'main')
    upsertWatch.run(repoId, 'commit', 'main')
    const count = db.prepare(`SELECT COUNT(*) c FROM watches WHERE repo_id = ?`).get(repoId).c
    assert(count === 1, `expected 1 watch after idempotent upsert, got ${count}`)
    const fresh = getWatch.get(repoId, 'commit', 'main')
    assert(fresh.last_seen_sha === null, 'a fresh watch has NULL last_seen_sha')
    assert(fresh.last_polled_at === null, 'a fresh watch has NULL last_polled_at')

    // 3. touchWatchPolled sets last_polled_at but NOT last_seen_sha.
    db.prepare(
      `UPDATE watches SET last_polled_at = ? WHERE repo_id = ? AND ref_type = ? AND ref = ?`
    ).run('2026-06-22T02:00:00Z', repoId, 'commit', 'main')
    const polled = getWatch.get(repoId, 'commit', 'main')
    assert(polled.last_polled_at === '2026-06-22T02:00:00Z', 'last_polled_at recorded')
    assert(polled.last_seen_sha === null, 'a bare poll must NOT advance last_seen_sha')

    // 4. markWatchSeen advances last_seen_sha (and last_polled_at).
    db.prepare(
      `UPDATE watches SET last_seen_sha = ?, last_polled_at = ?
       WHERE repo_id = ? AND ref_type = ? AND ref = ?`
    ).run('a'.repeat(40), '2026-06-22T03:00:00Z', repoId, 'commit', 'main')
    const seen = getWatch.get(repoId, 'commit', 'main')
    assert(seen.last_seen_sha === 'a'.repeat(40), 'markWatchSeen advances last_seen_sha')

    // A pr watch keyed by `pr:<number>` coexists with the commit watch.
    upsertWatch.run(repoId, 'pr', 'pr:42')
    assert(getWatch.get(repoId, 'pr', 'pr:42'), 'pr watch created alongside commit watch')

    // 5. the ref_type CHECK rejects anything else.
    expectThrows(() => upsertWatch.run(repoId, 'working-tree', 'x'), 'invalid ref_type')

    // 6. ON DELETE CASCADE: deleting a repo removes its watches; others untouched.
    upsertWatch.run(otherRepo, 'commit', 'main')
    db.prepare(`DELETE FROM repos WHERE id = ?`).run(repoId)
    const goneCount = db.prepare(`SELECT COUNT(*) c FROM watches WHERE repo_id = ?`).get(repoId).c
    assert(goneCount === 0, 'watches cascade-deleted with the repo')
    const otherCount = db
      .prepare(`SELECT COUNT(*) c FROM watches WHERE repo_id = ?`)
      .get(otherRepo).c
    assert(otherCount === 1, "another repo's watch is untouched")

    // 7. no dangling foreign keys.
    const violations = db.pragma('foreign_key_check')
    assert(Array.isArray(violations) && violations.length === 0, 'no FK violations')

    db.close()
    console.log(
      'smoke:watches PASS — v13 polling foundation (http_cache.payload + watches) verified'
    )
    app.exit(0)
  } catch (err) {
    console.error('smoke:watches FAIL —', err && err.message ? err.message : err)
    app.exit(1)
  }
})
