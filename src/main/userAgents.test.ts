import { describe, expect, it } from 'vitest'
import type { Agent } from './agentConfig'
import { cloneToUserAgent, deleteUserAgent, upsertUserAgent } from './userAgents'

function mk(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    label: id,
    command: 'node',
    args: ['-e', 'x'],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: 60,
    env: {},
    ...over
  }
}

const shipped = new Set(['codex', 'eslint', 'qwen'])

describe('upsertUserAgent', () => {
  it('appends a new valid user agent', () => {
    const r = upsertUserAgent({ userAgents: [], agent: mk('mine'), shippedIds: shipped })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.agents.map((a) => a.id)).toEqual(['mine'])
  })

  it('rejects an id that collides with ANY shipped id (default OR catalog/tool)', () => {
    for (const id of ['codex', 'eslint', 'qwen']) {
      const r = upsertUserAgent({ userAgents: [], agent: mk(id), shippedIds: shipped })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/built-in/)
    }
  })

  it('rejects a malformed id (incl. uppercase — ids are lowercase-only)', () => {
    for (const id of ['', '-bad', 'has space', 'a/b', 'x'.repeat(65), 'Codex', 'ESLint']) {
      expect(upsertUserAgent({ userAgents: [], agent: mk(id), shippedIds: shipped }).ok).toBe(false)
    }
  })

  it('rejects a rename onto a DIFFERENT existing user id (dup)', () => {
    const existing = [mk('old'), mk('keep')]
    const r = upsertUserAgent({
      userAgents: existing,
      agent: mk('keep'),
      shippedIds: shipped,
      editingId: 'old'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/already exists/)
  })

  it('does not mutate the input userAgents array', () => {
    const existing = [mk('a')]
    upsertUserAgent({ userAgents: existing, agent: mk('b'), shippedIds: shipped })
    expect(existing.map((x) => x.id)).toEqual(['a'])
  })

  it('rejects an invalid agent payload', () => {
    const r = upsertUserAgent({ userAgents: [], agent: { id: 'x' }, shippedIds: shipped })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Invalid agent/)
  })

  it('rejects a duplicate user id, but allows replacing the one being edited', () => {
    const existing = [mk('a'), mk('b')]
    expect(upsertUserAgent({ userAgents: existing, agent: mk('a'), shippedIds: shipped }).ok).toBe(
      false
    ) // dup, not editing
    const edit = upsertUserAgent({
      userAgents: existing,
      agent: mk('a', { command: 'changed' }),
      shippedIds: shipped,
      editingId: 'a'
    })
    expect(edit.ok).toBe(true)
    if (edit.ok) {
      expect(edit.agents).toHaveLength(2)
      expect(edit.agents.find((x) => x.id === 'a')?.command).toBe('changed')
    }
  })

  it('supports rename (editingId differs from the new id)', () => {
    const r = upsertUserAgent({
      userAgents: [mk('old'), mk('keep')],
      agent: mk('new'),
      shippedIds: shipped,
      editingId: 'old'
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.agents.map((a) => a.id).sort()).toEqual(['keep', 'new'])
  })
})

describe('deleteUserAgent', () => {
  it('removes by id and is a no-op for an absent id', () => {
    expect(deleteUserAgent([mk('a'), mk('b')], 'a').map((x) => x.id)).toEqual(['b'])
    expect(deleteUserAgent([mk('a')], 'ghost').map((x) => x.id)).toEqual(['a'])
  })
})

describe('cloneToUserAgent', () => {
  it('copies the descriptor under a new id with a (copy) label', () => {
    const c = cloneToUserAgent(mk('codex', { command: 'codex', label: 'Codex' }), 'codex-mine')
    expect(c.id).toBe('codex-mine')
    expect(c.label).toBe('Codex (copy)')
    expect(c.command).toBe('codex')
  })
})
