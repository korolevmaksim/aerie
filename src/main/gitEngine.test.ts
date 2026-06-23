import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import simpleGit from 'simple-git'
import { authEnv } from './gitEngine'

describe('authEnv', () => {
  it('keeps normal process env but strips unsafe git process controls', () => {
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
