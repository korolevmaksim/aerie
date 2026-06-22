#!/usr/bin/env node
// Smoke for M7 working-tree review against REAL git. Proves the diff semantics
// `prepareWorkingTree`/`headShaOf` rely on, and the READ-ONLY invariant:
//   1. `git diff HEAD`    captures ALL uncommitted tracked changes (staged + unstaged);
//   2. `git diff --staged` captures ONLY what is staged;
//   3. `git rev-parse HEAD` yields a 40-hex sha (what a working-tree run records);
//   4. producing those diffs NEVER mutates the working copy and creates NO worktree
//      (the whole point: review the user's own clone in place, read-only).
// Run: `npm run smoke:worktree`

const { execSync } = require('node:child_process')
const { mkdtempSync, readdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const dir = mkdtempSync(join(tmpdir(), 'aerie-worktree-'))
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'smoke',
  GIT_AUTHOR_EMAIL: 'smoke@aerie.test',
  GIT_COMMITTER_NAME: 'smoke',
  GIT_COMMITTER_EMAIL: 'smoke@aerie.test'
}
const git = (cmd) =>
  execSync(`git ${cmd}`, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const write = (name, content) => writeFileSync(join(dir, name), content)

try {
  git('init -q -b main')

  // A committed baseline.
  write('a.txt', 'committed-1\n')
  write('b.txt', 'committed-1\n')
  git('add a.txt b.txt')
  git('commit -q -m base')

  const headSha = git('rev-parse HEAD').trim()
  assert(/^[0-9a-f]{40}$/i.test(headSha), `HEAD is not a 40-hex sha: ${headSha}`)

  // Uncommitted changes: a.txt staged, b.txt left unstaged.
  write('a.txt', 'STAGED-CHANGE\n')
  git('add a.txt')
  write('b.txt', 'UNSTAGED-CHANGE\n')

  // Snapshot working-tree state to prove read-only afterwards.
  const beforeStatus = git('status --porcelain')
  const beforeA = readFileSync(join(dir, 'a.txt'), 'utf8')
  const beforeB = readFileSync(join(dir, 'b.txt'), 'utf8')

  // (1) `git diff HEAD` — all uncommitted tracked changes (staged + unstaged).
  const diffAll = git('diff HEAD')
  assert(diffAll.includes('STAGED-CHANGE'), '`git diff HEAD` missing the staged change')
  assert(diffAll.includes('UNSTAGED-CHANGE'), '`git diff HEAD` missing the unstaged change')
  assert(diffAll.includes('a.txt') && diffAll.includes('b.txt'), '`git diff HEAD` missing a file')

  // (2) `git diff --staged` — only what is staged (a.txt), not b.txt.
  const diffStaged = git('diff --staged')
  assert(diffStaged.includes('STAGED-CHANGE'), '`git diff --staged` missing the staged change')
  assert(
    !diffStaged.includes('UNSTAGED-CHANGE'),
    '`git diff --staged` leaked the unstaged change (should only show staged)'
  )

  // (4a) read-only: working files and index are byte-identical after diffing.
  assert(readFileSync(join(dir, 'a.txt'), 'utf8') === beforeA, 'a.txt changed during diffing')
  assert(readFileSync(join(dir, 'b.txt'), 'utf8') === beforeB, 'b.txt changed during diffing')
  assert(git('status --porcelain') === beforeStatus, 'working-tree status changed during diffing')

  // (4b) no worktree was created (prepareWorkingTree never runs `worktree add`).
  const worktrees = git('worktree list').trim().split('\n')
  assert(
    worktrees.length === 1,
    `expected exactly one worktree (the clone), got ${worktrees.length}`
  )
  assert(
    !existsSync(join(dir, '.git', 'worktrees')) ||
      readdirSync(join(dir, '.git', 'worktrees')).length === 0,
    'a linked worktree was created — working-tree review must not create one'
  )

  // (3) HEAD is unchanged (rev-parse is read-only).
  assert(git('rev-parse HEAD').trim() === headSha, 'HEAD moved during the working-tree review')

  // (5) clean-tree premise of the runner's empty-diff guard: once everything is
  // committed, both working-tree diffs are empty (so the run short-circuits).
  git('add -A')
  git('commit -q -m wip')
  assert(git('diff HEAD').trim() === '', '`git diff HEAD` not empty on a clean tree')
  assert(git('diff --staged').trim() === '', '`git diff --staged` not empty on a clean tree')

  console.log('\n✅ M7 working-tree smoke PASSED — git diff HEAD / --staged semantics correct,')
  console.log('   read-only (working copy + index + HEAD unchanged), no worktree created.')
  process.exit(0)
} catch (err) {
  console.error('\n❌ M7 working-tree smoke FAILED:', err.message)
  process.exit(1)
} finally {
  try {
    require('node:fs').rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best-effort temp cleanup */
  }
}
