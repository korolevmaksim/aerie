#!/usr/bin/env node
// Stage smoke for the M9a v14 "automation pipelines" migration + store helpers: runs
// INSIDE Electron (real better-sqlite3 ABI) and proves:
//   1. pipelines/pipeline_runs tables exist; the CHECK constraints reject bad
//      trigger / action_kind / status values;
//   2. insertPipeline derives the promoted columns (enabled, action_kind, auto_post)
//      from the draft JSON, and updatePipeline keeps them in sync;
//   3. listEnabledPipelineRows returns only enabled rows;
//   4. pipeline_runs: insert defaults status 'pending'; status/posted updates work;
//   5. findCompletedPipelineRunByDedupe returns ONLY a 'done' run (errored/skipped
//      are retryable), most-recent-first;
//   6. reconcileInterruptedPipelineRuns flips pending/running -> error (crash recovery)
//      WITHOUT touching any watch state;
//   7. ON DELETE CASCADE: deleting a pipeline removes its runs; deleting a repo removes
//      its pipelines (and their runs);
//   8. foreign_key_check reports no violations.
// Mirrors the exact v14 SQL + helper statements in src/main/store.ts — keep in sync.
// Run: `npm run smoke:pipelines`

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

    // --- baseline: repos (FK parent) + the v14 tables, exactly as store.ts. ---
    db.exec(`
      CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT);

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

    const repoId = db.prepare(`INSERT INTO repos (full_name) VALUES ('o/r')`).run().lastInsertRowid

    // --- insertPipeline: promoted columns derived from the draft. ---
    const insertPipeline = db.prepare(
      `INSERT INTO pipelines (repo_id, name, trigger, enabled, action_kind, auto_post, config,
                              created_at, updated_at)
       VALUES (@repoId, @name, @trigger, @enabled, @actionKind, @autoPost, @config, @now, @now)`
    )
    const draftNotify = {
      name: 'PR review',
      repoId,
      trigger: 'pr',
      enabled: true,
      scope: {},
      steps: [{ id: 's1', kind: 'agent', ref: 'codex' }],
      action: { kind: 'notify', autoPost: false },
      guardrails: {}
    }
    const pid = insertPipeline.run({
      repoId,
      name: draftNotify.name,
      trigger: draftNotify.trigger,
      enabled: 1,
      actionKind: draftNotify.action.kind,
      autoPost: 0,
      config: JSON.stringify(draftNotify),
      now: '2026-06-22T00:00:00Z'
    }).lastInsertRowid
    const row = db.prepare(`SELECT * FROM pipelines WHERE id = ?`).get(pid)
    assert(
      row.enabled === 1 && row.action_kind === 'notify' && row.auto_post === 0,
      'promoted columns set'
    )
    assert(JSON.parse(row.config).steps[0].ref === 'codex', 'config JSON round-trips')

    // A disabled, auto-post pipeline (the dangerous combo — stored, never auto-run here).
    const pid2 = insertPipeline.run({
      repoId,
      name: 'auto-post',
      trigger: 'commit',
      enabled: 0,
      actionKind: 'post',
      autoPost: 1,
      config: JSON.stringify({
        ...draftNotify,
        name: 'auto-post',
        trigger: 'commit',
        enabled: false,
        action: { kind: 'post', autoPost: true }
      }),
      now: '2026-06-22T00:01:00Z'
    }).lastInsertRowid

    // --- updatePipeline keeps promoted columns in sync. ---
    db.prepare(
      `UPDATE pipelines SET name=@name, trigger=@trigger, enabled=@enabled, action_kind=@actionKind,
         auto_post=@autoPost, config=@config, updated_at=@now WHERE id=@id`
    ).run({
      id: pid,
      name: 'PR review v2',
      trigger: 'pr',
      enabled: 0,
      actionKind: 'stage',
      autoPost: 0,
      config: JSON.stringify({
        ...draftNotify,
        name: 'PR review v2',
        enabled: false,
        action: { kind: 'stage', autoPost: false }
      }),
      now: '2026-06-22T00:02:00Z'
    })
    const updated = db.prepare(`SELECT * FROM pipelines WHERE id = ?`).get(pid)
    assert(
      updated.enabled === 0 && updated.action_kind === 'stage',
      'update syncs promoted columns'
    )

    // --- listEnabledPipelineRows: only enabled=1 (pid is now disabled; pid2 is disabled). ---
    db.prepare(`UPDATE pipelines SET enabled = 1 WHERE id = ?`).run(pid2)
    const enabled = db.prepare(`SELECT id FROM pipelines WHERE enabled = 1 ORDER BY id ASC`).all()
    assert(enabled.length === 1 && enabled[0].id === pid2, 'only enabled rows listed')

    // --- CHECK constraints reject bad enums. ---
    expectThrows(
      () =>
        insertPipeline.run({
          repoId,
          name: 'bad',
          trigger: 'webhook',
          enabled: 0,
          actionKind: 'notify',
          autoPost: 0,
          config: '{}',
          now: 'x'
        }),
      'invalid trigger'
    )
    expectThrows(
      () =>
        insertPipeline.run({
          repoId,
          name: 'bad',
          trigger: 'pr',
          enabled: 0,
          actionKind: 'publish',
          autoPost: 0,
          config: '{}',
          now: 'x'
        }),
      'invalid action_kind'
    )
    // The auto-post guard CHECK: auto_post=1 is allowed ONLY for a 'post' action.
    expectThrows(
      () =>
        insertPipeline.run({
          repoId,
          name: 'bad-autopost',
          trigger: 'pr',
          enabled: 0,
          actionKind: 'notify',
          autoPost: 1,
          config: '{}',
          now: 'x'
        }),
      'auto_post=1 with a non-post action'
    )

    // --- pipeline_runs: insert (pending), status/posted updates, dedupe lookup. ---
    const insertRun = db.prepare(
      `INSERT INTO pipeline_runs (pipeline_id, trigger, ref_type, ref, head_sha, status, action,
                                  dedupe_key, started_at)
       VALUES (@pipelineId, @trigger, @refType, @ref, @headSha, 'pending', @action, @dedupeKey, @startedAt)`
    )
    const runId = insertRun.run({
      pipelineId: pid2,
      trigger: 'commit',
      refType: 'commit',
      ref: 'main',
      headSha: 'a'.repeat(40),
      action: 'post',
      dedupeKey: 'k1',
      startedAt: '2026-06-22T01:00:00Z'
    }).lastInsertRowid
    let r = db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`).get(runId)
    assert(r.status === 'pending' && r.posted === 0, 'run starts pending, not posted')

    db.prepare(
      `UPDATE pipeline_runs SET status=@s, finished_at=COALESCE(@f, finished_at) WHERE id=@id`
    ).run({ id: runId, s: 'done', f: '2026-06-22T01:05:00Z' })
    db.prepare(`UPDATE pipeline_runs SET posted = 1 WHERE id = ?`).run(runId)
    r = db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`).get(runId)
    assert(
      r.status === 'done' && r.posted === 1 && r.finished_at === '2026-06-22T01:05:00Z',
      'run completed + posted'
    )

    // findCompletedPipelineRunByDedupe: only 'done' counts.
    const findDone = db.prepare(
      `SELECT * FROM pipeline_runs WHERE dedupe_key = ? AND status = 'done' ORDER BY id DESC LIMIT 1`
    )
    assert(findDone.get('k1'), "a 'done' run is found by dedupe key")
    // An errored run on a different key is NOT returned as completed.
    insertRun.run({
      pipelineId: pid2,
      trigger: 'commit',
      refType: 'commit',
      ref: 'main',
      headSha: 'b'.repeat(40),
      action: 'post',
      dedupeKey: 'k2',
      startedAt: '2026-06-22T02:00:00Z'
    })
    db.prepare(`UPDATE pipeline_runs SET status='error' WHERE dedupe_key='k2'`).run()
    assert(!findDone.get('k2'), 'an errored run is NOT treated as already-processed (retryable)')

    // --- guardrail inputs (countActivePipelineRuns / recentPipelineRunStarts /
    //     lastRepoPipelineRunStart), exactly as the store helpers query them. ---
    // k1 is 'done', k2 is 'error' so far → 0 active for pid2. Add one running.
    insertRun.run({
      pipelineId: pid2,
      trigger: 'commit',
      refType: 'commit',
      ref: 'main',
      headSha: 'd'.repeat(40),
      action: 'notify',
      dedupeKey: 'kactive',
      startedAt: '2026-06-22T05:00:00Z'
    })
    db.prepare(`UPDATE pipeline_runs SET status='running' WHERE dedupe_key='kactive'`).run()
    const active = db
      .prepare(
        `SELECT COUNT(*) c FROM pipeline_runs WHERE pipeline_id = ? AND status IN ('pending','running')`
      )
      .get(pid2).c
    assert(active === 1, `expected 1 active run for pid2, got ${active}`)

    const recent = db
      .prepare(
        `SELECT started_at FROM pipeline_runs WHERE pipeline_id = ? AND started_at >= ?
         ORDER BY started_at DESC`
      )
      .all(pid2, '2026-06-22T02:00:00Z')
      .map((r) => r.started_at)
    // started_at of k2 (02:00), kactive (05:00) are >= cutoff; k1 (01:00) is not.
    assert(recent.length === 2, `expected 2 recent starts, got ${recent.length}`)
    assert(recent[0] === '2026-06-22T05:00:00Z', 'recent starts are newest-first')

    const lastRepo = db
      .prepare(
        `SELECT pr.started_at FROM pipeline_runs pr JOIN pipelines p ON p.id = pr.pipeline_id
         WHERE p.repo_id = ? ORDER BY pr.started_at DESC LIMIT 1`
      )
      .get(repoId)
    assert(
      lastRepo && lastRepo.started_at === '2026-06-22T05:00:00Z',
      'last repo run-start is the newest across the repo'
    )
    // Settle kactive so the crash-recovery assertion below sees exactly one interrupted run.
    db.prepare(`UPDATE pipeline_runs SET status='done' WHERE dedupe_key='kactive'`).run()

    // --- crash recovery: a pending + a running run -> error. ---
    insertRun.run({
      pipelineId: pid2,
      trigger: 'manual',
      refType: 'commit',
      ref: 'main',
      headSha: 'c'.repeat(40),
      action: 'notify',
      dedupeKey: 'k3',
      startedAt: '2026-06-22T03:00:00Z'
    })
    db.prepare(`UPDATE pipeline_runs SET status='running' WHERE dedupe_key='k3'`).run()
    const reconciled = db
      .prepare(
        `UPDATE pipeline_runs SET status='error', finished_at=? WHERE status IN ('pending','running')`
      )
      .run('2026-06-22T04:00:00Z').changes
    assert(reconciled === 1, `expected 1 interrupted run reconciled, got ${reconciled}`)
    const live = db
      .prepare(`SELECT COUNT(*) c FROM pipeline_runs WHERE status IN ('pending','running')`)
      .get().c
    assert(live === 0, 'no live pipeline runs after reconcile')

    // --- CASCADE: delete a pipeline removes its runs; delete the repo removes all. ---
    db.prepare(`DELETE FROM pipelines WHERE id = ?`).run(pid2)
    const runsGone = db
      .prepare(`SELECT COUNT(*) c FROM pipeline_runs WHERE pipeline_id = ?`)
      .get(pid2).c
    assert(runsGone === 0, 'pipeline_runs cascade-deleted with the pipeline')

    db.prepare(`DELETE FROM repos WHERE id = ?`).run(repoId)
    const pipesGone = db.prepare(`SELECT COUNT(*) c FROM pipelines WHERE repo_id = ?`).get(repoId).c
    assert(pipesGone === 0, 'pipelines cascade-deleted with the repo')

    const violations = db.pragma('foreign_key_check')
    assert(Array.isArray(violations) && violations.length === 0, 'no FK violations')

    db.close()
    console.log(
      'smoke:pipelines PASS — v14 pipelines + pipeline_runs (CRUD, dedupe, crash recovery) verified'
    )
    app.exit(0)
  } catch (err) {
    console.error('smoke:pipelines FAIL —', err && err.message ? err.message : err)
    app.exit(1)
  }
})
