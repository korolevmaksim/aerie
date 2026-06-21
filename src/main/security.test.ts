import { afterEach, describe, it, expect, vi } from 'vitest'
import { isInternalUrl, isSafeExternalUrl } from './security'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isSafeExternalUrl', () => {
  it('allows http(s)', () => {
    expect(isSafeExternalUrl('https://github.com/x')).toBe(true)
    expect(isSafeExternalUrl('http://example.com')).toBe(true)
  })
  it('rejects non-http schemes and junk', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('data:text/html,x')).toBe(false)
    expect(isSafeExternalUrl('ftp://h/x')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
  })
})

describe('isInternalUrl', () => {
  it('in dev, matches the renderer base and rejects look-alike hosts', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    expect(isInternalUrl('http://localhost:5173/')).toBe(true)
    expect(isInternalUrl('http://localhost:5173/index.html')).toBe(true)
    expect(isInternalUrl('http://localhost:5173.evil.com/')).toBe(false)
    expect(isInternalUrl('https://github.com/')).toBe(false)
  })
  it('in prod, only file:// is internal', () => {
    expect(isInternalUrl('file:///Applications/Aerie.app/index.html')).toBe(true)
    expect(isInternalUrl('https://github.com/')).toBe(false)
  })
})
