import { describe, expect, it } from 'vitest'
import bundledCatalog from './data/agentCatalog.json'
import {
  CATALOG_SCHEMA_VERSION,
  isCatalogEntry,
  mergeCatalogs,
  parseCatalog,
  parseUserCatalog,
  toAgentTemplate
} from './catalogSchema'
import { isAgent, type Agent } from './agentConfig'
import { agentSignature } from './execConsent'

// A minimal, structurally valid catalog entry (an Agent template carrying a detect binary).
const entry = (over: Partial<Agent> = {}): Agent => ({
  id: 'qwen',
  label: 'Qwen Code',
  command: 'qwen',
  args: ['--prompt', '{{prompt}}'],
  promptDelivery: 'arg',
  promptPlaceholder: '{{prompt}}',
  outputCapture: 'stdout',
  outputFile: null,
  timeoutSec: 900,
  env: {},
  detect: 'qwen',
  ...over
})

const catalog = (agents: unknown[], schemaVersion: number = CATALOG_SCHEMA_VERSION): unknown => ({
  schemaVersion,
  agents
})

describe('isCatalogEntry', () => {
  it('accepts a valid agent template that declares a detect binary', () => {
    expect(isCatalogEntry(entry())).toBe(true)
  })

  it('rejects an otherwise-valid agent with no detect (could never be surfaced)', () => {
    const { detect, ...noDetect } = entry()
    void detect
    expect(isAgent(noDetect)).toBe(true) // still a valid Agent…
    expect(isCatalogEntry(noDetect)).toBe(false) // …but not a valid catalog entry
  })

  it('rejects an empty-string detect', () => {
    expect(isCatalogEntry(entry({ detect: '' }))).toBe(false)
  })

  it('rejects a structurally invalid agent', () => {
    expect(isCatalogEntry({ id: 'x', detect: 'x' })).toBe(false)
    expect(isCatalogEntry(null)).toBe(false)
    expect(isCatalogEntry('qwen')).toBe(false)
  })
})

describe('parseCatalog', () => {
  it('parses the bundled catalog cleanly into its entries (regression guard)', () => {
    const res = parseCatalog(bundledCatalog)
    expect(res.errors).toEqual([])
    expect(res.schemaVersion).toBe(CATALOG_SCHEMA_VERSION)
    expect(res.entries.map((a) => a.id)).toEqual(['qwen', 'cn'])
    for (const a of res.entries) expect(isCatalogEntry(a)).toBe(true)
  })

  it('returns the valid entries from a hand-built catalog', () => {
    const res = parseCatalog(catalog([entry({ id: 'a' }), entry({ id: 'b' })]))
    expect(res.errors).toEqual([])
    expect(res.entries.map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('rejects a non-object payload', () => {
    expect(parseCatalog(null).errors).toContain('catalog must be an object')
    expect(parseCatalog([]).errors).toContain('catalog must be an object')
    expect(parseCatalog('x').entries).toEqual([])
  })

  it('rejects an unsupported schema version with no entries', () => {
    const res = parseCatalog(catalog([entry()], 99))
    expect(res.entries).toEqual([])
    expect(res.errors[0]).toMatch(/unsupported schemaVersion 99/)
  })

  it('treats a missing schemaVersion as 0 (unsupported)', () => {
    const res = parseCatalog({ agents: [entry()] })
    expect(res.entries).toEqual([])
    expect(res.errors[0]).toMatch(/unsupported schemaVersion 0/)
  })

  it('rejects any non-1 number version (NaN, float, negative)', () => {
    for (const v of [NaN, 1.5, -1]) {
      const res = parseCatalog(catalog([entry()], v))
      expect(res.entries).toEqual([])
      expect(res.errors[0]).toMatch(/unsupported schemaVersion/)
    }
  })

  it('rejects a non-array agents field', () => {
    expect(parseCatalog(catalog('nope' as unknown as unknown[])).errors).toContain(
      'catalog.agents must be an array'
    )
  })

  it('drops a malformed entry but keeps the valid ones', () => {
    const res = parseCatalog(catalog([entry({ id: 'ok' }), { id: 'bad' }, entry({ id: 'ok2' })]))
    expect(res.entries.map((a) => a.id)).toEqual(['ok', 'ok2'])
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]).toMatch(/entry 1 is invalid/)
  })

  it('drops a duplicate id (first wins) and reports it', () => {
    const res = parseCatalog(catalog([entry({ id: 'dup' }), entry({ id: 'dup', label: 'Other' })]))
    expect(res.entries.map((a) => a.id)).toEqual(['dup'])
    expect(res.entries[0].label).toBe('Qwen Code') // first wins
    expect(res.errors[0]).toMatch(/entry 1 duplicates id "dup"/)
  })

  it('rejects an entry missing a detect binary', () => {
    const { detect, ...noDetect } = entry()
    void detect
    const res = parseCatalog(catalog([noDetect]))
    expect(res.entries).toEqual([])
    expect(res.errors[0]).toMatch(/entry 0 is invalid/)
  })

  it('strips extra (attacker-controlled) keys from each entry via the allow-list', () => {
    const dirty = { ...entry({ id: 'x' }), evil: 'rm -rf', extra: 42 }
    const res = parseCatalog(catalog([dirty]))
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0]).not.toHaveProperty('evil')
    expect(res.entries[0]).not.toHaveProperty('extra')
    expect(res.entries[0].command).toBe('qwen')
  })

  it('does not pollute Object.prototype when an entry carries a __proto__ key', () => {
    const res = parseCatalog(JSON.parse('{"schemaVersion":1,"agents":[]}'))
    // A crafted payload with a literal __proto__ key parses without leaking onto the prototype.
    parseCatalog(JSON.parse('{"schemaVersion":1,"agents":[],"__proto__":{"polluted":true}}'))
    expect(res.errors).toEqual([])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('toAgentTemplate (allow-list reconstruction)', () => {
  it('keeps only known contract fields', () => {
    const out = toAgentTemplate({ ...entry(), evil: true } as unknown as Agent)
    expect(out).not.toHaveProperty('evil')
    expect(isAgent(out)).toBe(true)
  })

  it('omits absent optional fields (cn-style: no model key) and preserves the exec signature', () => {
    const noModel = entry({ detect: 'cn' }) // entry() has no `model` by default
    const out = toAgentTemplate(noModel)
    expect(Object.prototype.hasOwnProperty.call(out, 'model')).toBe(false)
    // The reconstruction must be byte-identical to the source for the signed material
    // (command/args/env/modelDiscovery.argv) — otherwise provenance trust would break.
    expect(agentSignature(out)).toBe(agentSignature(noModel))
  })

  it('shallow-copies arrays/maps so the template shares no mutable structure', () => {
    const src = entry({ args: ['--prompt', '{{prompt}}'], env: { A: '1' } })
    const out = toAgentTemplate(src)
    out.args.push('x')
    out.env.B = '2'
    expect(src.args).toEqual(['--prompt', '{{prompt}}'])
    expect(src.env).toEqual({ A: '1' })
  })

  it('clones a valid command modelDiscovery and drops a malformed one', () => {
    const good = toAgentTemplate(
      entry({ modelDiscovery: { kind: 'command', argv: ['m', 'ls'], format: 'lines' } })
    )
    expect(good.modelDiscovery).toEqual({ kind: 'command', argv: ['m', 'ls'], format: 'lines' })
    const bad = toAgentTemplate(
      entry({ modelDiscovery: { kind: 'configFile', path: '/x' } as never })
    )
    expect(bad.modelDiscovery).toBeUndefined()
  })
})

describe('parseUserCatalog', () => {
  it('parses a valid catalog file string', () => {
    const res = parseUserCatalog(JSON.stringify(catalog([entry({ id: 'mine' })])))
    expect(res.errors).toEqual([])
    expect(res.entries.map((a) => a.id)).toEqual(['mine'])
  })

  it('returns an error (never throws) on invalid JSON', () => {
    const res = parseUserCatalog('{ not json')
    expect(res.entries).toEqual([])
    expect(res.errors[0]).toMatch(/not valid JSON/)
  })
})

describe('mergeCatalogs (bundled wins)', () => {
  const bundled = [entry({ id: 'qwen' }), entry({ id: 'cn' })]

  it('drops a user entry that collides with a bundled id (trusted shipped entry survives)', () => {
    const user = [entry({ id: 'qwen', label: 'Evil Qwen', command: 'evil' }), entry({ id: 'new' })]
    const merged = mergeCatalogs(bundled, user)
    expect(merged.map((a) => a.id)).toEqual(['qwen', 'cn', 'new'])
    expect(merged.find((a) => a.id === 'qwen')?.command).toBe('qwen') // bundled, not 'evil'
  })

  it('appends non-colliding user entries and yields unique ids', () => {
    const merged = mergeCatalogs(bundled, [entry({ id: 'a' }), entry({ id: 'b' })])
    const ids = merged.map((a) => a.id)
    expect(ids).toEqual(['qwen', 'cn', 'a', 'b'])
    expect(new Set(ids).size).toBe(ids.length)
  })
})
