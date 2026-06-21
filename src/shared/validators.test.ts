import { describe, it, expect } from 'vitest'
import { isValidId, isValidSha } from './validators'

describe('isValidId', () => {
  it('accepts positive integers', () => {
    expect(isValidId(1)).toBe(true)
    expect(isValidId(999)).toBe(true)
  })
  it('rejects non-positive, non-integer, and non-number', () => {
    expect(isValidId(0)).toBe(false)
    expect(isValidId(-1)).toBe(false)
    expect(isValidId(1.5)).toBe(false)
    expect(isValidId('1')).toBe(false)
    expect(isValidId(null)).toBe(false)
    expect(isValidId(undefined)).toBe(false)
    expect(isValidId(NaN)).toBe(false)
  })
})

describe('isValidSha', () => {
  it('accepts 7–40 char hex (any case)', () => {
    expect(isValidSha('abc1234')).toBe(true)
    expect(isValidSha('f2904eaff11660ca365ba7b5595e043371513360')).toBe(true)
    expect(isValidSha('ABCDEF0')).toBe(true)
  })
  it('rejects too-short, too-long, non-hex, and non-string', () => {
    expect(isValidSha('abc12')).toBe(false)
    expect(isValidSha('f'.repeat(41))).toBe(false)
    expect(isValidSha('xyz1234')).toBe(false)
    expect(isValidSha('abc 123')).toBe(false)
    expect(isValidSha(123)).toBe(false)
    expect(isValidSha(null)).toBe(false)
  })
})
