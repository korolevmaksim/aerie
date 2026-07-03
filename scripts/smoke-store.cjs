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
    const findings = require(path.join(__dirname, '..', 'src', 'main', 'findings.ts'))
    const reviewMemory = require(path.join(__dirname, '..', 'src', 'main', 'reviewMemory.ts'))
    const db = store.initStore(':memory:')

    const version = db.pragma('user_version', { simple: true })
    assert(version >= 22, `expected migration user_version >= 22, got ${version}`)
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

    const stableId = findings.stableFindingIdOf({
      tool: 'eslint',
      file: 'src/app.ts',
      ruleId: 'no-debugger',
      message: "Unexpected 'debugger' statement."
    })
    const contextHash = findings.findingContextHashOf({
      tool: 'eslint',
      ruleId: 'no-debugger',
      snippet: 'function demo() {\n  debugger\n}'
    })
    assert(contextHash, 'context hash helper returned null')
    store.insertFindings(projectRun.id, [
      {
        tool: 'eslint',
        ruleId: 'no-debugger',
        severity: 'medium',
        file: 'src/app.ts',
        line: 12,
        message: "Unexpected 'debugger' statement.",
        fingerprint: 'abc12345',
        stableId,
        contextHash
      }
    ])
    const finding = store.listFindingsForRun(projectRun.id)[0]
    assert(finding.stable_id === stableId, 'finding stable id was not persisted')
    assert(finding.context_hash === contextHash, 'finding context hash was not persisted')

    const fakeOpenAiKey = ['sk', 'proj', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('-')
    const globalMemory = reviewMemory.annotateFindingMemory({
      findingId: finding.id,
      decision: 'dismissed',
      scopeKind: 'global',
      note: `Globally noisy check ${fakeOpenAiKey}`
    })
    assert(!globalMemory.note.includes(fakeOpenAiKey), 'review memory note was not redacted')
    assert(globalMemory.note.includes('[REDACTED]'), 'review memory note lost redaction marker')
    const repoMemory = reviewMemory.annotateFindingMemory({
      findingId: finding.id,
      decision: 'accepted',
      scopeKind: 'repo'
    })
    const repoMatches = reviewMemory.attachReviewMemory(repo.id, [{ stableId }])
    assert(repoMatches[0].memory.annotation.id === repoMemory.id, 'repo memory did not win')
    assert(repoMatches[0].memory.matchedBy === 'stable_id', 'stable-id match was not labeled')
    assert(repoMatches[0].memory.suppresses === false, 'accepted should not suppress')

    assert(reviewMemory.clearFindingMemory(repoMemory.id), 'repo memory clear failed')
    const globalMatches = reviewMemory.attachReviewMemory(repo.id, [{ stableId }])
    assert(globalMatches[0].memory.annotation.id === globalMemory.id, 'global memory did not match')
    assert(globalMatches[0].memory.suppresses === true, 'dismissed should suppress')
    const promptMemory = reviewMemory.buildReviewMemoryPromptContext(repo.id, ['src/app.ts'])
    assert(promptMemory.included >= 1, 'prompt review memory did not include changed-path memory')
    assert(
      promptMemory.text.includes('current source code wins'),
      'prompt memory lost advisory guardrail'
    )
    assert(!promptMemory.text.includes(fakeOpenAiKey), 'prompt memory leaked unredacted secret')
    assert(promptMemory.text.includes('[REDACTED]'), 'prompt memory lost redacted note marker')
    const unrelatedPromptMemory = reviewMemory.buildReviewMemoryPromptContext(repo.id, [
      'src/other.ts'
    ])
    assert(unrelatedPromptMemory.included === 0, 'prompt memory ignored changed-file filter')
    const archivedMemoryList = reviewMemory.listRepoReviewMemory(repo.id)
    assert(
      !archivedMemoryList.some((annotation) => annotation.id === repoMemory.id),
      'archived repo memory stayed active'
    )
    const archivedExport = reviewMemory.exportRepoReviewMemory(repo.id)
    assert(
      archivedExport.annotations.some(
        (annotation) =>
          annotation.stableId === stableId &&
          annotation.decision === 'accepted' &&
          annotation.archivedAt !== null
      ),
      'review memory export did not preserve archived annotation'
    )
    try {
      reviewMemory.updateFindingMemoryAnnotation({
        annotationId: globalMemory.id,
        decision: 'false_positive',
        note: ''
      })
      throw new Error('empty suppressing update unexpectedly succeeded')
    } catch (err) {
      assert(
        String(err && err.message ? err.message : err).includes('require a note'),
        'empty suppressing update returned the wrong error'
      )
    }
    const updatedGlobal = reviewMemory.updateFindingMemoryAnnotation({
      annotationId: globalMemory.id,
      decision: 'false_positive',
      note: 'Still noisy after review.'
    })
    assert(updatedGlobal.decision === 'false_positive', 'review memory update failed')
    const contextMatches = reviewMemory.attachReviewMemory(repo.id, [
      { stableId: 'aerie-finding-v1:differentstableid0000000000000', contextHash }
    ])
    assert(
      contextMatches[0].memory.annotation.id === globalMemory.id,
      'context fallback did not match'
    )
    assert(contextMatches[0].memory.matchedBy === 'context_hash', 'context match was not labeled')
    assert(contextMatches[0].memory.suppresses === true, 'context fallback suppression failed')
    const fixedMemory = reviewMemory.annotateFindingMemory({
      findingId: finding.id,
      decision: 'fixed',
      scopeKind: 'repo'
    })
    const fixedMatches = reviewMemory.attachReviewMemory(repo.id, [{ stableId, contextHash }])
    assert(fixedMatches[0].memory.annotation.id === fixedMemory.id, 'fixed repo memory did not win')
    assert(fixedMatches[0].memory.reopened === true, 'fixed repeat was not marked reopened')
    assert(fixedMatches[0].memory.suppresses === false, 'fixed repeat should remain visible')
    const importedStableId = 'aerie-finding-v1:importednoise000000000000000000000000000000'
    const archivedStableId = 'aerie-finding-v1:archivednoise00000000000000000000000000000'
    const importResult = reviewMemory.importRepoReviewMemory({
      repoId: repo.id,
      payload: JSON.stringify({
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        repoId: repo.id,
        annotations: [
          {
            scopeKind: 'repo',
            stableId: importedStableId,
            contextHash: null,
            decision: 'duplicate',
            note: 'Covered by eslint.',
            archivedAt: null,
            updatedAt: new Date().toISOString()
          },
          {
            scopeKind: 'repo',
            stableId: archivedStableId,
            contextHash: null,
            decision: 'dismissed',
            note: 'Archived during import.',
            archivedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      })
    })
    assert(importResult.imported === 2, 'review memory import did not import expected records')
    const importedMatches = reviewMemory.attachReviewMemory(repo.id, [
      { stableId: importedStableId },
      { stableId: archivedStableId }
    ])
    assert(importedMatches[0].memory.suppresses === true, 'imported suppression did not match')
    assert(importedMatches[1].memory === null, 'imported archived annotation matched')
    const repoMemoryList = reviewMemory.listRepoReviewMemory(repo.id)
    assert(
      repoMemoryList.some((annotation) => annotation.id === globalMemory.id),
      'repo memory list did not include global annotation'
    )
    const memoryEvents = reviewMemory.listRepoReviewMemoryEvents(repo.id)
    assert(memoryEvents.length >= 4, 'review memory events were not recorded')
    assert(
      memoryEvents.some((event) => event.eventKind === 'cleared') &&
        memoryEvents.some((event) => event.eventKind === 'updated'),
      'review memory audit events missing clear/update'
    )

    store.setSetting('ui.groundReviews', '1')
    assert(store.getSetting('ui.groundReviews') === '1', 'setting insert failed')
    store.setSetting('ui.groundReviews', '0')
    assert(store.getSetting('ui.groundReviews') === '0', 'setting update failed')
    store.deleteSetting('ui.groundReviews')
    assert(store.getSetting('ui.groundReviews') === undefined, 'setting delete failed')

    store.closeStore()
    console.log('smoke:store PASS — migrations, repo/run/settings/review-memory helpers verified')
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
