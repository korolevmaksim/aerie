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

import type { Agent, ModelDiscovery } from './agentConfig'
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
 * Reconstructs a `ModelDiscovery` descriptor from an allow-list — only the well-formed
 * `command` shape (the single kind that exists today) survives; a malformed or unknown-kind
 * descriptor is dropped rather than carried through. (The `configFile` kind arrives in a later
 * M2 slice and will extend this.)
 */
function cloneModelDiscovery(md: Agent['modelDiscovery']): ModelDiscovery | undefined {
  if (!md || typeof md !== 'object') return undefined
  const m = md as Partial<ModelDiscovery>
  if (
    m.kind === 'command' &&
    Array.isArray(m.argv) &&
    m.argv.every((x) => typeof x === 'string') &&
    m.format === 'lines'
  ) {
    return { kind: 'command', argv: [...m.argv], format: 'lines' }
  }
  return undefined
}

/**
 * Rebuilds an `Agent` from an EXPLICIT field allow-list. A catalog payload (especially a user
 * or remote one) is untrusted JSON: passing the parsed object through by reference would let
 * attacker-controlled extra keys (`__proto__`, `constructor`, or any unknown property) ride
 * along into persistence and downstream consumers. Constructing a fresh object with only the
 * known contract fields strips everything else. Optional fields are copied ONLY when present,
 * so a template that omits (e.g.) `model` stays byte-identical — preserving its exec signature
 * and therefore its provenance trust (M12). Arrays/maps are shallow-copied so the returned
 * template shares no mutable structure with the source. (`env` is spread into a fresh object —
 * even an own `__proto__` key from JSON.parse becomes an inert own data property, not
 * prototype pollution.)
 */
export function toAgentTemplate(entry: Agent): Agent {
  const out: Agent = {
    id: entry.id,
    label: entry.label,
    command: entry.command,
    args: [...entry.args],
    promptDelivery: entry.promptDelivery,
    promptPlaceholder: entry.promptPlaceholder,
    outputCapture: entry.outputCapture,
    outputFile: entry.outputFile,
    timeoutSec: entry.timeoutSec,
    env: { ...entry.env }
  }
  if (entry.model !== undefined) out.model = entry.model
  if (entry.models !== undefined) out.models = [...entry.models]
  if (entry.reasoning !== undefined) out.reasoning = entry.reasoning
  if (entry.reasoningLevels !== undefined) out.reasoningLevels = [...entry.reasoningLevels]
  if (entry.detect !== undefined) out.detect = entry.detect
  if (entry.kind !== undefined) out.kind = entry.kind
  if (entry.successExitCodes !== undefined) out.successExitCodes = [...entry.successExitCodes]
  const md = cloneModelDiscovery(entry.modelDiscovery)
  if (md !== undefined) out.modelDiscovery = md
  return out
}

/**
 * Parses + validates raw catalog data (bundled JSON, a user catalog, or a remote payload)
 * into well-formed entries. Never throws: a wrong schema version or a non-array `agents`
 * yields an empty result with errors; an individual malformed/duplicate entry is dropped with
 * an error and the rest are kept (one bad entry never sinks the whole catalog). Each surviving
 * entry is rebuilt via `toAgentTemplate`, so no extra keys from the source object survive.
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
    entries.push(toAgentTemplate(entry))
  })
  return { schemaVersion, entries, errors }
}

/**
 * Parses a user-catalog FILE's raw text (the JSON read from userData) through the same
 * `parseCatalog` chokepoint. Never throws: invalid JSON yields an empty result with an error,
 * so a corrupt user file can never crash agent loading.
 */
export function parseUserCatalog(raw: string): ParsedCatalog {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { schemaVersion: 0, entries: [], errors: [`user catalog is not valid JSON: ${reason}`] }
  }
  return parseCatalog(value)
}

/**
 * Combines the author-shipped (bundled) catalog with a user/remote catalog, BUNDLED WINNING on
 * an id collision: an author-shipped entry is in `CANONICAL_SIGNATURES` (auto-trusted), so a
 * same-id user entry must never replace it (that would surface an untrusted variant under a
 * trusted id and downgrade it to needing consent). The result has unique ids, ready for
 * `mergeAgents` (which further drops any id that collides with a default/user-added agent and
 * surfaces the rest only when detected on PATH). Pure.
 */
export function mergeCatalogs(bundled: Agent[], user: Agent[]): Agent[] {
  const bundledIds = new Set(bundled.map((a) => a.id))
  return [...bundled, ...user.filter((a) => !bundledIds.has(a.id))]
}
