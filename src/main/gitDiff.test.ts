import { describe, expect, it } from 'vitest'
import { reviewDiffArgs } from './gitDiff'

describe('reviewDiffArgs', () => {
  it('uses a three-dot base...head diff for a PR (whole PR, not just head commit)', () => {
    expect(reviewDiffArgs('headsha', 'basesha')).toEqual(['diff', 'basesha...headsha'])
  })

  it('diffs against the first parent for a commit (no base)', () => {
    expect(reviewDiffArgs('headsha')).toEqual(['diff', 'headsha^', 'headsha'])
    expect(reviewDiffArgs('headsha', null)).toEqual(['diff', 'headsha^', 'headsha'])
    expect(reviewDiffArgs('headsha', '')).toEqual(['diff', 'headsha^', 'headsha'])
  })
})
