import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { isOnPath, whichOnPath } from './pathLookup'

const dir = mkdtempSync(join(tmpdir(), 'aerie-path-'))
const otherDir = mkdtempSync(join(tmpdir(), 'aerie-path-'))
const binName = 'aerie-fake-bin'
const binPath = join(dir, binName)
writeFileSync(binPath, '#!/bin/sh\n')

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(otherDir, { recursive: true, force: true })
})

describe('whichOnPath', () => {
  it('resolves a bare name found on PATH to its absolute path', () => {
    const env = { PATH: [otherDir, dir].join(delimiter) }
    expect(whichOnPath(binName, env)).toBe(binPath)
  })

  it('returns null for a bare name not on PATH', () => {
    const env = { PATH: otherDir }
    expect(whichOnPath(binName, env)).toBeNull()
  })

  it('checks an explicit path as-is, ignoring PATH', () => {
    expect(whichOnPath(binPath, { PATH: '' })).toBe(binPath)
    expect(whichOnPath(join(dir, 'nope'), { PATH: dir })).toBeNull()
  })

  it('handles an empty/missing PATH and empty bin', () => {
    expect(whichOnPath(binName, {})).toBeNull()
    expect(whichOnPath('', { PATH: dir })).toBeNull()
  })

  it('isOnPath mirrors whichOnPath as a boolean', () => {
    expect(isOnPath(binName, { PATH: dir })).toBe(true)
    expect(isOnPath(binName, { PATH: otherDir })).toBe(false)
  })

  it('does not match a same-named directory (regular files only)', () => {
    const pdir = mkdtempSync(join(tmpdir(), 'aerie-path-'))
    mkdirSync(join(pdir, 'toolname')) // a DIRECTORY named like a binary
    expect(whichOnPath('toolname', { PATH: pdir })).toBeNull()
    rmSync(pdir, { recursive: true, force: true })
  })

  it('resolves Windows PATHEXT suffixes for a bare name', () => {
    const wdir = mkdtempSync(join(tmpdir(), 'aerie-path-'))
    writeFileSync(join(wdir, 'mytool.cmd'), 'echo')
    expect(whichOnPath('mytool', { PATH: wdir }, 'win32')).toBe(join(wdir, 'mytool.cmd'))
    // POSIX (default) does not add suffixes, so the bare name misses.
    expect(whichOnPath('mytool', { PATH: wdir }, 'linux')).toBeNull()
    rmSync(wdir, { recursive: true, force: true })
  })
})
