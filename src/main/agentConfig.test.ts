import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AGENTS,
  DEFAULT_REVIEW_INSTRUCTIONS,
  RETIRED_AGENT_IDS,
  SEED_PROMPTS,
  buildPrompt,
  isAgent,
  mergeAgents,
  substitute,
  type Agent
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

describe('mergeAgents', () => {
  const mk = (id: string): Agent => ({
    id,
    label: id,
    command: id,
    args: [],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: 600,
    env: {}
  })
  const retired: ReadonlySet<string> = new Set(['dummy'])

  it('persists defaults + user-added (pruning retired); surfaces detected catalog at runtime only', () => {
    const { persist, runtime } = mergeAgents({
      defaults: [mk('codex')],
      userAgents: [mk('mine'), mk('dummy')],
      catalog: [mk('aider'), mk('goose')],
      retired,
      isDetected: (a) => a.id === 'aider' // only aider installed
    })
    // dummy pruned; catalog NEVER persisted.
    expect(persist.map((a) => a.id)).toEqual(['codex', 'mine'])
    // goose isn't detected, so only aider is surfaced at runtime.
    expect(runtime.map((a) => a.id)).toEqual(['codex', 'mine', 'aider'])
  })

  it('is behavior-preserving with an empty catalog (runtime equals persist)', () => {
    const { persist, runtime } = mergeAgents({
      defaults: [mk('codex'), mk('claude')],
      userAgents: [mk('mine')],
      catalog: [],
      retired,
      isDetected: () => true
    })
    expect(runtime).toEqual(persist)
    expect(persist.map((a) => a.id)).toEqual(['codex', 'claude', 'mine'])
  })

  it('never persists a catalog entry even when detected', () => {
    const { persist } = mergeAgents({
      defaults: [mk('codex')],
      userAgents: [],
      catalog: [mk('qwen'), mk('cn')],
      retired,
      isDetected: () => true // both installed
    })
    expect(persist.map((a) => a.id)).toEqual(['codex'])
  })

  it('never lets a catalog entry shadow a default or user-added id', () => {
    const { runtime } = mergeAgents({
      defaults: [mk('codex')],
      userAgents: [mk('aider')], // user already defined their own 'aider'
      catalog: [mk('aider')],
      retired,
      isDetected: () => true
    })
    expect(runtime.filter((a) => a.id === 'aider')).toHaveLength(1)
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
