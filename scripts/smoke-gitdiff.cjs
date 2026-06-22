#!/usr/bin/env node
// Smoke: proves the M0 whole-PR diff fix against REAL git (not just the unit-tested
// reviewDiffArgs). Builds a temp repo where a feature branch has MULTIPLE commits and
// the base branch has advanced PAST the branch point, then asserts:
//   - three-dot `base...head` (what Aerie now does for a PR) covers the WHOLE PR (all
//     feature commits) and EXCLUDES base-only commits made after branching;
//   - the old `head^..head` (last commit only) MISSES earlier feature commits — the
//     exact bug this fix closes.
// Run: `npm run smoke:gitdiff`

const { execSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const dir = mkdtempSync(join(tmpdir(), 'aerie-gitdiff-'))
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'smoke',
  GIT_AUTHOR_EMAIL: 'smoke@aerie.test',
  GIT_COMMITTER_NAME: 'smoke',
  GIT_COMMITTER_EMAIL: 'smoke@aerie.test'
}
const git = (cmd) =>
  execSync(`git ${cmd}`, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const sha = (ref) => git(`rev-parse ${ref}`).trim()
const write = (name, content) => writeFileSync(join(dir, name), content)

try {
  git('init -q -b main')

  // base commit on main
  write('a.txt', 'v1\n')
  git('add a.txt')
  git('commit -q -m base')

  // feature branch: three commits (a multi-commit PR)
  git('checkout -q -b feature')
  write('b.txt', 'new-b\n')
  git('add b.txt')
  git('commit -q -m feat-add-b')
  write('a.txt', 'v2\n')
  git('add a.txt')
  git('commit -q -m feat-modify-a')
  write('c.txt', 'new-c\n')
  git('add c.txt')
  git('commit -q -m feat-add-c')
  const head = sha('HEAD')

  // base branch advances AFTER branching, so base tip != merge-base
  git('checkout -q main')
  write('d.txt', 'main-only\n')
  git('add d.txt')
  git('commit -q -m main-add-d')
  const base = sha('HEAD') // = a PR's base.sha (base branch current tip)

  const threeDot = git(`diff ${base}...${head}`) // what Aerie now does for a PR
  const lastCommit = git(`diff ${head}^ ${head}`) // the old (buggy) behavior

  // three-dot covers the WHOLE PR and excludes base-only changes
  assert(threeDot.includes('b.txt'), 'three-dot diff missing b.txt (first feature commit)')
  assert(threeDot.includes('a.txt'), 'three-dot diff missing the a.txt change (middle commit)')
  assert(threeDot.includes('c.txt'), 'three-dot diff missing c.txt (last commit)')
  assert(!threeDot.includes('d.txt'), 'three-dot diff wrongly includes the base-only commit d.txt')

  // old last-commit diff MISSES earlier feature commits — the bug this closes
  assert(lastCommit.includes('c.txt'), 'sanity: last-commit diff should include c.txt')
  assert(
    !lastCommit.includes('b.txt'),
    'last-commit diff unexpectedly includes b.txt (the bug should miss it)'
  )

  process.stdout.write(
    '\nGITDIFF_OK — whole-PR three-dot diff covers all feature commits and excludes base-only ' +
      'changes; the old last-commit diff confirmed to miss earlier commits.\n'
  )
  process.exitCode = 0
} catch (err) {
  process.stderr.write(`\nGITDIFF_FAIL — ${err.message}\n`)
  process.exitCode = 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
