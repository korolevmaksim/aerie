import { describe, expect, it } from 'vitest'
import { filterCommands, scoreMatch, type PaletteCommand } from './palette'

describe('scoreMatch', () => {
  it('returns null when the query is not a subsequence', () => {
    expect(scoreMatch('xyz', 'Repos')).toBeNull()
    expect(scoreMatch('zzz', 'history')).toBeNull()
  })
  it('matches a subsequence', () => {
    expect(scoreMatch('rps', 'Repos')).not.toBeNull()
    expect(scoreMatch('hist', 'History')).not.toBeNull()
  })
  it('an empty query matches everything with score 0', () => {
    expect(scoreMatch('', 'anything')).toBe(0)
    expect(scoreMatch('   ', 'anything')).toBe(0)
  })
  it('scores a word-boundary / prefix match higher than a scattered one', () => {
    const prefix = scoreMatch('set', 'Settings')!
    const scattered = scoreMatch('set', 'reset everything')! // s-e-t scattered, mid-word
    expect(prefix).toBeGreaterThan(scattered)
  })
  it('scores a contiguous run higher than a broken one', () => {
    expect(scoreMatch('too', 'Tools')!).toBeGreaterThan(scoreMatch('tos', 'Tools')!)
  })
})

describe('filterCommands', () => {
  const mk = (id: string, title: string, hint?: string): PaletteCommand => ({
    id,
    title,
    hint,
    run: () => {}
  })
  const cmds = [
    mk('repos', 'Repos'),
    mk('hist', 'History'),
    mk('tools', 'Tools'),
    mk('set', 'Settings')
  ]

  it('returns all commands (in order) for an empty query', () => {
    expect(filterCommands(cmds, '').map((c) => c.id)).toEqual(['repos', 'hist', 'tools', 'set'])
  })
  it('filters out non-matches and ranks the best first', () => {
    const r = filterCommands(cmds, 'set')
    expect(r[0].id).toBe('set')
    expect(r.every((c) => c.id !== 'repos')).toBe(true)
  })
  it('searches the hint too', () => {
    const withHint = [mk('a', 'Open', 'octo/aerie'), mk('b', 'Open', 'other/thing')]
    const r = filterCommands(withHint, 'aerie')
    expect(r.map((c) => c.id)).toEqual(['a'])
  })
})
