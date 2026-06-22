import { describe, expect, it } from 'vitest'
import { AGENT_CATALOG } from './agentCatalog'
import { DEFAULT_AGENTS, isAgent, RETIRED_AGENT_IDS } from './agentConfig'
import { TOOL_CATALOG } from './toolCatalog'

describe('TOOL_CATALOG', () => {
  it('every entry is a structurally valid agent marked kind:tool', () => {
    for (const t of TOOL_CATALOG) {
      expect(isAgent(t)).toBe(true)
      expect(t.kind).toBe('tool')
    }
  })

  it('declares successExitCodes that include a non-zero "found issues" code', () => {
    for (const t of TOOL_CATALOG) {
      expect(Array.isArray(t.successExitCodes)).toBe(true)
      expect(t.successExitCodes!.length).toBeGreaterThan(0)
      expect(t.successExitCodes).toContain(0)
    }
  })

  it('treats only tsc type-errors (exit 1) as findings, not config errors (exit 2)', () => {
    const tsc = TOOL_CATALOG.find((t) => t.id === 'tsc')!
    expect(tsc.successExitCodes).toEqual([0, 1])
  })

  it('does not collide with default agents, the agent catalog, or retired ids', () => {
    const taken = new Set([...DEFAULT_AGENTS, ...AGENT_CATALOG].map((a) => a.id))
    for (const t of TOOL_CATALOG) {
      expect(taken.has(t.id)).toBe(false)
      expect(RETIRED_AGENT_IDS.has(t.id)).toBe(false)
    }
  })

  it('has unique ids and a detect binary each', () => {
    const ids = TOOL_CATALOG.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of TOOL_CATALOG) expect((t.detect ?? t.command).length).toBeGreaterThan(0)
  })
})
