// Data-driven agent-catalog schema + loader (ROADMAP M2). The broad autodiscovery
// catalog is shipped as DATA (a schema-versioned JSON), not hardcoded TS, so adding a CLI
// is a data edit — and so a USER catalog (and, later, a signed remote update) can extend it
// through the SAME validation chokepoint. Pure + electron-free so it's fully unit-testable;
// the file/network loading is wired in `agentCatalog.ts`.
//
// SECURITY (M12 provenance): a catalog entry is an Agent template — arbitrary local exec
// metadata. Validation here only proves the SHAPE is well-formed; it does NOT grant trust.
// Trust is provenance-keyed in the runner: only the AUTHOR-SHIPPED bundled catalog's entries
// are in CANONICAL_SIGNATURES, so a user/remote-catalog entry still needs exec-consent before
// its command (or any `modelDiscovery.argv`) can run.

import type { Agent } from './agentConfig'
import { isAgent } from './agentConfig'

/** The catalog schema version this build understands. Bump on a breaking field change. */
export const CATALOG_SCHEMA_VERSION = 1

export interface ParsedCatalog {
  /** The version found in the data (0 when missing/invalid). */
  schemaVersion: number
  /** The valid, de-duplicated entries (invalid/dupe entries are dropped, not thrown). */
  entries: Agent[]
  /** Human-readable reasons any entry (or the whole file) was rejected. */
  errors: string[]
}

/**
 * A catalog entry is an `Agent` template that MUST carry a non-empty `detect` binary — the
 * catalog surfaces an entry ONLY when that binary is on PATH, so a template with no `detect`
 * could never be detected and is rejected.
 */
export function isCatalogEntry(value: unknown): value is Agent {
  if (!isAgent(value)) return false
  const detect = (value as Agent).detect
  return typeof detect === 'string' && detect.length > 0
}

/**
 * Parses + validates raw catalog data (bundled JSON, a user catalog, or a remote payload)
 * into well-formed entries. Never throws: a wrong schema version or a non-array `agents`
 * yields an empty result with errors; an individual malformed/duplicate entry is dropped with
 * an error and the rest are kept (one bad entry never sinks the whole catalog).
 */
export function parseCatalog(value: unknown): ParsedCatalog {
  const errors: string[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { schemaVersion: 0, entries: [], errors: ['catalog must be an object'] }
  }
  const obj = value as { schemaVersion?: unknown; agents?: unknown }
  const schemaVersion = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 0
  if (schemaVersion !== CATALOG_SCHEMA_VERSION) {
    return {
      schemaVersion,
      entries: [],
      errors: [`unsupported schemaVersion ${schemaVersion} (expected ${CATALOG_SCHEMA_VERSION})`]
    }
  }
  if (!Array.isArray(obj.agents)) {
    return { schemaVersion, entries: [], errors: ['catalog.agents must be an array'] }
  }

  const entries: Agent[] = []
  const seen = new Set<string>()
  obj.agents.forEach((entry, i) => {
    if (!isCatalogEntry(entry)) {
      errors.push(`catalog entry ${i} is invalid (bad fields or missing detect)`)
      return
    }
    if (seen.has(entry.id)) {
      errors.push(`catalog entry ${i} duplicates id "${entry.id}"`)
      return
    }
    seen.add(entry.id)
    entries.push(entry)
  })
  return { schemaVersion, entries, errors }
}
