import { describe, expect, it } from 'vitest'
import { parseShellPath } from './shellPath'

const wrap = (path: string): string => `__AERIE_PATH_START__${path}__AERIE_PATH_END__`

describe('parseShellPath', () => {
  it('extracts the PATH between the markers', () => {
    expect(parseShellPath(wrap('/nvm/bin:/usr/bin'))).toBe('/nvm/bin:/usr/bin')
  })

  it('ignores rc banner output surrounding the markers', () => {
    const noisy = `Welcome to your shell!\nsome banner line\n${wrap('/a:/b')}trailing junk`
    expect(parseShellPath(noisy)).toBe('/a:/b')
  })

  it('returns null when the markers are absent', () => {
    expect(parseShellPath('/just/a/path:/no/markers')).toBeNull()
    expect(parseShellPath('')).toBeNull()
  })

  it('returns null on an empty PATH between markers', () => {
    expect(parseShellPath(wrap(''))).toBeNull()
  })

  it('returns null when the end marker precedes the start (garbled output)', () => {
    expect(parseShellPath('__AERIE_PATH_END__/x__AERIE_PATH_START__')).toBeNull()
  })
})
