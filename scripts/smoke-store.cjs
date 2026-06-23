#!/usr/bin/env node
// Store smoke test: runs INSIDE Electron (real better-sqlite3 ABI) and exercises the
// actual src/main/store.ts exports against an in-memory DB. This covers the migration
// chain plus representative CRUD paths that Vitest cannot run while better-sqlite3 is
// rebuilt for Electron.
// Run: `npm run smoke:store`

const { app } = require('electron')
const { readFileSync } = require('fs')
const path = require('path')
const ts = require('typescript')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

require.extensions['.ts'] = function compileTypeScript(module, filename) {
  const source = readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022
    }
  })
  module._compile(outputText, filename)
}

app.whenReady().then(() => {
  let store
  try {
    store = require(path.join(__dirname, '..', 'src', 'main', 'store.ts'))
    const db = store.initStore(':memory:')

    const version = db.pragma('user_version', { simple: true })
    assert(version >= 15, `expected migration user_version >= 15, got ${version}`)
    assert(
      Array.isArray(db.pragma('foreign_key_check')) && db.pragma('foreign_key_check').length === 0,
      'foreign_key_check reported violations after migrations'
    )

    const projectPrompt = store.listPrompts().find((prompt) => prompt.name === 'Project audit')
    assert(projectPrompt && projectPrompt.body.length > 0, 'Project audit seeded')

    const createdAt = '2026-06-23T00:00:00.000Z'
    const account = store.insertAccount({
      label: 'personal',
      login: 'octocat',
      kind: 'user',
      tokenBlob: Buffer.from('encrypted-token'),
      createdAt
    })
    assert(store.listAccounts().length === 1, 'account insert/list failed')

    store.syncReposForAccount(
      account.id,
      [
        {
          fullName: 'octo/repo',
          defaultBranch: 'main',
          remoteUrl: 'https://github.com/octo/repo.git',
          htmlUrl: 'https://github.com/octo/repo',
          isPrivate: false,
          pushedAt: '2026-06-20T00:00:00.000Z'
        }
      ],
      '2026-06-23T00:01:00.000Z'
    )
    const repo = store.listReposForAccount(account.id)[0]
    assert(repo.full_name === 'octo/repo', 'repo sync failed')

    store.setRepoLocalPath(repo.id, '/tmp/octo-repo')
    store.setRepoUseLocalWorktree(repo.id, true)
    store.setRepoFavorite(repo.id, true)
    store.syncReposForAccount(
      account.id,
      [
        {
          fullName: 'octo/repo',
          defaultBranch: 'trunk',
          remoteUrl: 'https://github.com/octo/repo-renamed-remote.git',
          htmlUrl: 'https://github.com/octo/repo',
          isPrivate: true,
          pushedAt: '2026-06-21T00:00:00.000Z'
        }
      ],
      '2026-06-23T00:02:00.000Z'
    )
    const refreshed = store.getRepoById(repo.id)
    assert(refreshed.default_branch === 'trunk', 'GitHub-sourced repo columns did not update')
    assert(refreshed.user_local_path === '/tmp/octo-repo', 'local path was clobbered')
    assert(refreshed.use_local_worktree === 1, 'local worktree flag was clobbered')
    assert(refreshed.favorite === 1, 'favorite flag was clobbered')

    const sha = 'a'.repeat(40)
    const projectRun = store.insertRun({
      repoId: repo.id,
      refType: 'project',
      refId: 'main',
      headSha: sha,
      agentId: 'codex',
      startedAt: '2026-06-23T00:03:00.000Z',
      authorLogin: null
    })
    store.insertRun({
      repoId: repo.id,
      refType: 'working-tree',
      refId: 'staged',
      headSha: sha,
      agentId: 'codex',
      startedAt: '2026-06-23T00:04:00.000Z',
      authorLogin: null
    })
    assert(
      store.hasActiveRun(repo.id, 'project', 'main', sha, 'codex'),
      'project active-run lookup failed'
    )
    assert(
      !store.hasActiveRun(repo.id, 'commit', sha.slice(0, 7), sha, 'codex'),
      'active-run lookup conflated project and commit refs'
    )
    store.updateRunStatus(projectRun.id, {
      status: 'done',
      exitCode: 0,
      finishedAt: '2026-06-23T00:05:00.000Z',
      outputPath: '/tmp/review.out'
    })
    const doneRun = store.getRun(projectRun.id)
    assert(doneRun.status === 'done' && doneRun.exit_code === 0, 'run status update failed')

    store.setSetting('ui.groundReviews', '1')
    assert(store.getSetting('ui.groundReviews') === '1', 'setting insert failed')
    store.setSetting('ui.groundReviews', '0')
    assert(store.getSetting('ui.groundReviews') === '0', 'setting update failed')
    store.deleteSetting('ui.groundReviews')
    assert(store.getSetting('ui.groundReviews') === undefined, 'setting delete failed')

    store.closeStore()
    console.log('smoke:store PASS — migrations, repo/run/settings helpers verified')
    app.exit(0)
  } catch (err) {
    try {
      store?.closeStore?.()
    } catch {
      // ignore cleanup errors
    }
    console.error('smoke:store FAIL —', err && err.message ? err.message : err)
    app.exit(1)
  }
})
