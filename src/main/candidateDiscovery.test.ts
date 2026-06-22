import { describe, expect, it } from 'vitest'
import { detectCandidates, KNOWN_CODING_CLIS, type KnownCli } from './candidateDiscovery'

const known: KnownCli[] = [
  { command: 'aider', label: 'Aider' },
  { command: 'gptme', label: 'gptme' },
  { command: 'mods', label: 'Mods' }
]

// A fake PATH: only these binaries "exist".
const locator =
  (installed: Record<string, string>) =>
  (bin: string): string | null =>
    installed[bin] ?? null

describe('detectCandidates', () => {
  it('reports an installed known CLI that no agent covers', () => {
    const res = detectCandidates({
      known,
      configuredBins: new Set(),
      locate: locator({ aider: '/usr/local/bin/aider' })
    })
    expect(res).toEqual([{ command: 'aider', label: 'Aider', path: '/usr/local/bin/aider' }])
  })

  it('omits a CLI that is not installed', () => {
    const res = detectCandidates({
      known,
      configuredBins: new Set(),
      locate: locator({}) // nothing on PATH
    })
    expect(res).toEqual([])
  })

  it('omits a CLI already covered by a configured agent (by binary)', () => {
    const res = detectCandidates({
      known,
      configuredBins: new Set(['aider']), // a configured agent already uses `aider`
      locate: locator({ aider: '/usr/local/bin/aider', gptme: '/usr/local/bin/gptme' })
    })
    expect(res.map((c) => c.command)).toEqual(['gptme'])
  })

  it('excludes by configuredBins membership whether it came from detect or command', () => {
    // listCandidates builds configuredBins from `detect ?? command`; detectCandidates sees only
    // the resolved set, so a binary contributed by an agent's detect probe excludes it too.
    const res = detectCandidates({
      known,
      configuredBins: new Set(['gptme']), // e.g. an agent whose detect binary is 'gptme'
      locate: locator({ aider: '/a', gptme: '/g' })
    })
    expect(res.map((c) => c.command)).toEqual(['aider'])
  })

  it('reports multiple installed candidates and de-dupes by binary', () => {
    const dupes: KnownCli[] = [...known, { command: 'aider', label: 'Aider (dupe)' }]
    const res = detectCandidates({
      known: dupes,
      configuredBins: new Set(),
      locate: locator({ aider: '/a', gptme: '/g', mods: '/m' })
    })
    expect(res.map((c) => c.command)).toEqual(['aider', 'gptme', 'mods'])
  })

  it('produces only inert display fields — no spawnable command shape', () => {
    const res = detectCandidates({
      known,
      configuredBins: new Set(),
      locate: locator({ mods: '/usr/bin/mods' })
    })
    expect(Object.keys(res[0]).sort()).toEqual(['command', 'label', 'path'])
    // No args / promptDelivery / env etc. that an agent runner could spawn.
    expect(res[0]).not.toHaveProperty('args')
    expect(res[0]).not.toHaveProperty('promptDelivery')
  })
})

describe('KNOWN_CODING_CLIS registry', () => {
  it('has unique binaries and non-empty fields', () => {
    const cmds = KNOWN_CODING_CLIS.map((c) => c.command)
    expect(new Set(cmds).size).toBe(cmds.length)
    for (const c of KNOWN_CODING_CLIS) {
      expect(c.command.length).toBeGreaterThan(0)
      expect(c.label.length).toBeGreaterThan(0)
    }
  })

  it('excludes generic-collision binary names (trust: avoid false positives)', () => {
    const cmds = new Set(KNOWN_CODING_CLIS.map((c) => c.command))
    for (const generic of ['goose', 'forge', 'q', 'amp', 'llm']) {
      expect(cmds.has(generic)).toBe(false)
    }
  })
})
