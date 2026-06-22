import { delimiter } from 'path'
import { describe, expect, it } from 'vitest'
import { augmentedPath } from './osPath'

describe('augmentedPath', () => {
  const home = '/Users/me'

  it('appends well-known install dirs that exist and are missing from PATH (macOS)', () => {
    const exists = (p: string): boolean => ['/opt/homebrew/bin', '/Users/me/.cargo/bin'].includes(p)
    const result = augmentedPath('/usr/bin:/bin', { home, platform: 'darwin', exists })
    const parts = result.split(delimiter)
    expect(parts[0]).toBe('/usr/bin') // existing entries keep precedence
    expect(parts[1]).toBe('/bin')
    expect(parts).toContain('/opt/homebrew/bin')
    expect(parts).toContain('/Users/me/.cargo/bin')
  })

  it('does not duplicate a dir already on PATH', () => {
    const exists = (): boolean => true
    const result = augmentedPath('/opt/homebrew/bin:/usr/bin', { home, platform: 'darwin', exists })
    const count = result.split(delimiter).filter((p) => p === '/opt/homebrew/bin').length
    expect(count).toBe(1)
  })

  it('returns PATH unchanged when nothing extra exists', () => {
    const exists = (): boolean => false
    expect(augmentedPath('/usr/bin', { home, platform: 'darwin', exists })).toBe('/usr/bin')
  })

  it('leaves a Windows PATH untouched', () => {
    const exists = (): boolean => true
    expect(augmentedPath('C:\\Windows', { home, platform: 'win32', exists })).toBe('C:\\Windows')
  })

  it('handles an empty PATH', () => {
    const exists = (p: string): boolean => p === '/opt/homebrew/bin'
    expect(augmentedPath('', { home, platform: 'darwin', exists })).toBe('/opt/homebrew/bin')
  })
})
