import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import simpleGit from 'simple-git'

afterEach(() => {
  vi.doUnmock('electron')
  vi.resetModules()
})

async function loadGitEngine(userData?: string): Promise<typeof import('./gitEngine')> {
  if (userData) {
    vi.doMock('electron', () => ({
      app: {
        getPath: (name: string) => {
          if (name !== 'userData') throw new Error(`unexpected app.getPath(${name})`)
          return userData
        }
      }
    }))
  }
  return import('./gitEngine')
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
}

function createCommittedRepo(root: string): { repoDir: string; sha: string } {
  const repoDir = join(root, 'repo')
  mkdirSync(repoDir, { recursive: true })
  git(repoDir, ['init', '-b', 'main'])
  git(repoDir, ['config', 'user.email', 'aerie@example.test'])
  git(repoDir, ['config', 'user.name', 'Aerie Test'])
  writeFileSync(join(repoDir, 'README.md'), 'hello\n', 'utf8')
  git(repoDir, ['add', 'README.md'])
  git(repoDir, ['commit', '-m', 'initial'])
  return { repoDir, sha: git(repoDir, ['rev-parse', 'HEAD']).trim() }
}

describe('authEnv', () => {
  it('keeps normal process env but strips unsafe git process controls', async () => {
    const { authEnv } = await loadGitEngine()
    const original = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PAGER: process.env.PAGER,
      GIT_PAGER: process.env.GIT_PAGER,
      GIT_EDITOR: process.env.GIT_EDITOR
    }

    try {
      process.env.PATH = '/usr/bin'
      process.env.HOME = '/Users/example'
      process.env.PAGER = 'less'
      process.env.GIT_PAGER = 'less'
      process.env.GIT_EDITOR = 'vim'

      const env = authEnv()

      expect(env.PATH).toBe('/usr/bin')
      expect(env.HOME).toBe('/Users/example')
      expect(env.PAGER).toBeUndefined()
      expect(env.GIT_PAGER).toBeUndefined()
      expect(env.GIT_EDITOR).toBeUndefined()
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('can be passed to simple-git when PAGER is set in the shell', async () => {
    const { authEnv } = await loadGitEngine()
    const dir = mkdtempSync(join(tmpdir(), 'aerie-git-env-'))
    const originalPager = process.env.PAGER

    try {
      execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
      process.env.PAGER = 'less'

      await expect(simpleGit(dir).env(authEnv()).raw(['status', '--short'])).resolves.toBe('')
    } finally {
      if (originalPager === undefined) delete process.env.PAGER
      else process.env.PAGER = originalPager
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildProjectReviewContext', () => {
  it('builds a bounded project-audit brief with landmarks and omitted file count', async () => {
    const { buildProjectReviewContext } = await loadGitEngine()
    const files = [
      'src/main.ts',
      'src/ui/App.tsx',
      'package.json',
      'README.md',
      ...Array.from({ length: 805 }, (_, i) => `generated/file-${i}.txt`)
    ]

    const context = buildProjectReviewContext({
      fullName: 'octo/repo',
      sha: 'a'.repeat(40),
      refName: 'main',
      files
    })

    expect(context).toContain('Repository: octo/repo')
    expect(context).toContain('Reviewing: whole repository snapshot')
    expect(context).toContain('Ref: main')
    expect(context).toContain('- package.json')
    expect(context).toContain('- README.md')
    expect(context).toContain('first 800')
    expect(context).toContain('omitted')
    const listedGenerated = context
      .split('\n')
      .filter((line) => line.startsWith('- generated/file-'))
    expect(listedGenerated.length).toBeLessThanOrEqual(800)
  })
})

describe('prepare cleanup', () => {
  it('rejects repository names containing null bytes', async () => {
    const { clonePathFor } = await loadGitEngine('/tmp/aerie-test-user-data')
    expect(() => clonePathFor('octo/repo\0evil')).toThrow(/Invalid repository name/)
  })

  it('replaces stale failed-clone residue before cloning into the app-owned clone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aerie-git-engine-'))
    try {
      const userData = join(root, 'userData')
      mkdirSync(userData, { recursive: true })
      const { repoDir } = createCommittedRepo(root)
      writeFileSync(join(repoDir, 'README.md'), 'hello\nagain\n', 'utf8')
      git(repoDir, ['add', 'README.md'])
      git(repoDir, ['commit', '-m', 'second'])
      const sha = git(repoDir, ['rev-parse', 'HEAD']).trim()
      const { clonePathFor, cleanupCheckout, prepareCheckout } = await loadGitEngine(userData)
      const clonePath = clonePathFor('octo/repo')
      mkdirSync(clonePath, { recursive: true })
      writeFileSync(join(clonePath, 'partial.txt'), 'left by interrupted clone\n', 'utf8')

      const prepared = await prepareCheckout({
        fullName: 'octo/repo',
        sha,
        remoteUrl: repoDir,
        runTag: 'stale',
        useLocalWorktree: false
      })

      expect(existsSync(join(clonePath, '.git'))).toBe(true)
      expect(existsSync(join(clonePath, 'partial.txt'))).toBe(false)
      await cleanupCheckout(prepared)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('cleans the app-owned clone directory when a fresh clone fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aerie-git-engine-'))
    try {
      const userData = join(root, 'userData')
      mkdirSync(userData, { recursive: true })
      const { clonePathFor, prepareCheckout } = await loadGitEngine(userData)
      const clonePath = clonePathFor('octo/repo')

      await expect(
        prepareCheckout({
          fullName: 'octo/repo',
          sha: 'a'.repeat(40),
          remoteUrl: join(root, 'missing-remote.git'),
          runTag: 'failed',
          useLocalWorktree: false
        })
      ).rejects.toThrow()

      expect(existsSync(clonePath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes a user-local linked worktree when commit diff generation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aerie-git-engine-'))
    try {
      const userData = join(root, 'userData')
      mkdirSync(userData, { recursive: true })
      writeFileSync(join(userData, 'diffs'), 'not a directory', 'utf8')
      const { repoDir, sha } = createCommittedRepo(root)
      const { prepareCheckout } = await loadGitEngine(userData)
      const expectedWorktree = join(userData, 'worktrees', 'octo', 'repo', `${sha.slice(0, 12)}-t1`)

      await expect(
        prepareCheckout({
          fullName: 'octo/repo',
          sha,
          remoteUrl: 'file:///unused',
          runTag: 't1',
          userLocalPath: repoDir,
          useLocalWorktree: true
        })
      ).rejects.toThrow()

      expect(existsSync(expectedWorktree)).toBe(false)
      expect(git(repoDir, ['worktree', 'list', '--porcelain'])).not.toContain(expectedWorktree)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes a project-review linked worktree when context writing fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aerie-git-engine-'))
    try {
      const userData = join(root, 'userData')
      mkdirSync(userData, { recursive: true })
      writeFileSync(join(userData, 'diffs'), 'not a directory', 'utf8')
      const { repoDir, sha } = createCommittedRepo(root)
      const { prepareProjectReview } = await loadGitEngine(userData)
      const expectedWorktree = join(userData, 'worktrees', 'octo', 'repo', `${sha.slice(0, 12)}-t2`)

      await expect(
        prepareProjectReview({
          fullName: 'octo/repo',
          sha,
          refName: 'main',
          remoteUrl: 'file:///unused',
          runTag: 't2',
          userLocalPath: repoDir,
          useLocalWorktree: true
        })
      ).rejects.toThrow()

      expect(existsSync(expectedWorktree)).toBe(false)
      expect(git(repoDir, ['worktree', 'list', '--porcelain'])).not.toContain(expectedWorktree)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
