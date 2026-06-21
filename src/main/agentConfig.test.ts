import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AGENTS,
  DEFAULT_REVIEW_INSTRUCTIONS,
  RETIRED_AGENT_IDS,
  SEED_PROMPTS,
  buildPrompt,
  isAgent,
  substitute
} from './agentConfig'

describe('substitute', () => {
  const vars = { repoPath: '/wt', diffFile: '/d.diff', prompt: 'hi' }
  it('replaces known placeholders', () => {
    expect(substitute('cd {{repoPath}} && cat {{diffFile}}', vars)).toBe('cd /wt && cat /d.diff')
  })
  it('leaves unknown placeholders intact', () => {
    expect(substitute('{{nope}} {{prompt}}', vars)).toBe('{{nope}} hi')
  })
  it('replaces every occurrence', () => {
    expect(substitute('{{prompt}}-{{prompt}}', vars)).toBe('hi-hi')
  })
})

describe('buildPrompt', () => {
  const base = {
    fullName: 'octo/repo',
    sha: 'deadbeef',
    repoPath: '/wt',
    diffFile: '/d.diff'
  }
  it('includes repo, sha, paths', () => {
    const p = buildPrompt({ ...base, refType: 'commit', refId: 'deadbeef' })
    expect(p).toContain('octo/repo')
    expect(p).toContain('deadbeef')
    expect(p).toContain('/wt')
    expect(p).toContain('/d.diff')
  })
  it('labels a commit vs a PR', () => {
    expect(buildPrompt({ ...base, refType: 'commit', refId: 'deadbeef' })).toContain(
      'commit deadbeef'
    )
    expect(buildPrompt({ ...base, refType: 'pr', refId: '42' })).toContain('pull request #42')
  })
  it('uses the default instructions when none are given', () => {
    const p = buildPrompt({ ...base, refType: 'commit', refId: 'deadbeef' })
    expect(p).toContain('senior software engineer')
    expect(p).toContain('Severity:') // default carries the severity rubric
  })
  it('uses custom instructions but always keeps the machine context', () => {
    const p = buildPrompt(
      { ...base, refType: 'commit', refId: 'deadbeef' },
      'Focus only on security. Repo is {{repo}}.'
    )
    expect(p).toContain('Focus only on security.')
    expect(p).toContain('Repo is octo/repo.') // {{repo}} substituted
    expect(p).not.toContain('Severity:') // default replaced
    expect(p).toContain('/wt') // context block (worktree) still present
    expect(p).toContain('/d.diff') // context block (diff path) still present
  })
  it('falls back to the default on an empty custom prompt', () => {
    const p = buildPrompt({ ...base, refType: 'commit', refId: 'deadbeef' }, '   ')
    expect(p).toContain('senior software engineer')
    expect(DEFAULT_REVIEW_INSTRUCTIONS).toContain('senior software engineer')
  })
})

describe('SEED_PROMPTS', () => {
  it('ships the curated set with the default first', () => {
    const names = SEED_PROMPTS.map((p) => p.name)
    expect(names[0]).toBe('Default review')
    expect(names).toEqual(
      expect.arrayContaining([
        'Security audit',
        'Tests & edge cases',
        'Performance',
        'Architecture & maintainability',
        'Quick triage (blocking only)'
      ])
    )
    expect(SEED_PROMPTS[0].body).toBe(DEFAULT_REVIEW_INSTRUCTIONS)
    for (const p of SEED_PROMPTS) {
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.body.trim().length).toBeGreaterThan(40)
    }
  })
})

describe('isAgent', () => {
  const valid = DEFAULT_AGENTS[0]
  it('accepts the default agents', () => {
    for (const a of DEFAULT_AGENTS) expect(isAgent(a)).toBe(true)
  })
  it('rejects malformed entries', () => {
    expect(isAgent(null)).toBe(false)
    expect(isAgent({ ...valid, id: 123 })).toBe(false)
    expect(isAgent({ ...valid, args: 'not-array' })).toBe(false)
    expect(isAgent({ ...valid, args: [1, 2] })).toBe(false)
    expect(isAgent({ ...valid, promptDelivery: 'telepathy' })).toBe(false)
    expect(isAgent({ ...valid, outputCapture: 'pipe' })).toBe(false)
    expect(isAgent({ ...valid, timeoutSec: '600' })).toBe(false)
  })
})

describe('DEFAULT_AGENTS', () => {
  it('ships the real agent templates and no dummy', () => {
    const ids = DEFAULT_AGENTS.map((a) => a.id)
    expect(ids).toContain('codex')
    expect(ids).toContain('vibe')
    expect(ids).not.toContain('dummy')
  })

  it('marks dummy retired so a stale agents.json prunes it', () => {
    expect(RETIRED_AGENT_IDS.has('dummy')).toBe(true)
    // A retired id must not also be a live default (that would be contradictory).
    for (const a of DEFAULT_AGENTS) expect(RETIRED_AGENT_IDS.has(a.id)).toBe(false)
  })

  it('wires Mistral Vibe via VIBE_ACTIVE_MODEL with no reasoning control', () => {
    const vibe = DEFAULT_AGENTS.find((a) => a.id === 'vibe')!
    expect(vibe.env.VIBE_ACTIVE_MODEL).toBe('{{model}}')
    expect(substitute(vibe.env.VIBE_ACTIVE_MODEL, { model: 'devstral' })).toBe('devstral')
    expect(vibe.args).toContain('-p')
    expect(vibe.args).toContain('--auto-approve')
    expect(vibe.reasoningLevels ?? []).toEqual([])
  })
})

describe('reasoning wiring', () => {
  it('flag-based agents inject {{reasoning}} and expose levels', () => {
    const codex = DEFAULT_AGENTS.find((a) => a.id === 'codex')!
    expect(codex.args.join(' ')).toContain('model_reasoning_effort={{reasoning}}')
    expect(codex.reasoningLevels).toContain('high')
    const filled = codex.args.map((a) => substitute(a, { reasoning: 'xhigh', model: 'gpt-5.5' }))
    expect(filled.join(' ')).toContain('model_reasoning_effort=xhigh')

    const claude = DEFAULT_AGENTS.find((a) => a.id === 'claude-code')!
    expect(claude.args).toContain('--effort')
    expect(claude.args).toContain('{{reasoning}}')
  })

  it('model-suffix / none agents expose no reasoning levels', () => {
    for (const id of ['cursor-agent', 'kimi', 'gemini', 'agy']) {
      const a = DEFAULT_AGENTS.find((x) => x.id === id)!
      expect(a.reasoningLevels ?? []).toEqual([])
      expect(a.args.join(' ')).not.toContain('{{reasoning}}')
    }
  })
})
