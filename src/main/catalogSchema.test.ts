import { describe, expect, it } from 'vitest'
import bundledCatalog from './data/agentCatalog.json'
import { CATALOG_SCHEMA_VERSION, isCatalogEntry, parseCatalog } from './catalogSchema'
import { isAgent, type Agent } from './agentConfig'

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
})
