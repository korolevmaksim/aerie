import { describe, expect, it } from 'vitest'
import { AGENT_CATALOG } from './agentCatalog'
import { DEFAULT_AGENTS, isAgent, RETIRED_AGENT_IDS } from './agentConfig'

describe('AGENT_CATALOG', () => {
  it('every entry is a structurally valid agent', () => {
    for (const a of AGENT_CATALOG) expect(isAgent(a)).toBe(true)
  })

  it('does not collide with default agent ids or retired ids', () => {
    const defaults = new Set(DEFAULT_AGENTS.map((a) => a.id))
    for (const a of AGENT_CATALOG) {
      expect(defaults.has(a.id)).toBe(false)
      expect(RETIRED_AGENT_IDS.has(a.id)).toBe(false)
    }
  })

  it('has unique ids', () => {
    const ids = AGENT_CATALOG.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('each entry declares a detect binary so it only surfaces when installed', () => {
    for (const a of AGENT_CATALOG) expect((a.detect ?? a.command).length).toBeGreaterThan(0)
  })
})
