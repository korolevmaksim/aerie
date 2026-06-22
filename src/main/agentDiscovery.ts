// Dynamic model discovery (ROADMAP M2). Runs an agent CLI's non-interactive
// model-list probe (e.g. `opencode models`) and parses its live model ids, so the
// UI shows what the user can ACTUALLY pick instead of only a static seed. The static
// `models` list stays the fallback (discovery failing/empty changes nothing).
//
// Electron-free so the parse + spawn are unit-testable. Caching to the settings table
// and the synchronous overlay live in the runner/IPC layer — discovery NEVER runs on
// the synchronous `listAgentInfos()` path (no spawns there). The probe inherits the
// token-stripped process env (the GitHub token is never in process.env) and is bounded
// by a timeout + killTree via the shared `runToolCapture`.
//
// SECURITY: only AUTHOR-SHIPPED descriptors are executed. A `modelDiscovery` on a
// user-added/edited agent is arbitrary local exec and is NOT run until exec-consent
// (M12); `discoverAllModels` enforces this via the caller's `isTrusted` predicate
// (provenance: the descriptor must match the canonical shipped one).

import type { Agent } from './agentConfig'
import { runToolCapture } from './grounding'
import { whichOnPath } from './pathLookup'

/** A discovered model list for one agent, tagged with where it came from. */
export interface DiscoveredModels {
  agentId: string
  models: string[]
}

/**
 * Pure overlay used by the synchronous agent list: pick the live-discovered models
 * (from the cached JSON string) if valid + non-empty, else the static seed; always keep
 * the currently-selected model present so the picker never loses its value — on BOTH
 * paths. A corrupt/empty cache falls back to the seed.
 */
export function overlayModels(
  seed: string[],
  cachedRaw: string | undefined,
  selected: string
): { models: string[]; source: 'static' | 'discovered' } {
  let discovered: string[] | null = null
  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw)
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((m) => typeof m === 'string')
      ) {
        discovered = parsed
      }
    } catch {
      /* a corrupt cache falls back to the seed */
    }
  }
  const base = discovered ?? seed
  const models = selected && !base.includes(selected) ? [selected, ...base] : base
  return { models, source: discovered ? 'discovered' : 'static' }
}

/**
 * Parse a model-list probe's stdout into a clean, de-duplicated id list. `lines`:
 * one id per line — trims, drops blanks/comment-ish banner lines, caps the count so a
 * provider catalog of hundreds can't produce an unusable dropdown. NOTE: the 'lines'
 * format assumes whitespace-free ids (e.g. `provider/model`); a CLI whose model ids
 * contain spaces would need a different `format`.
 */
const MAX_DISCOVERED = 500

export function parseModelList(raw: string, format: 'lines'): string[] {
  if (format !== 'lines') return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const id = line.trim()
    // A real model id has no whitespace; skip banners/headers/log lines.
    if (id === '' || /\s/.test(id)) continue
    if (id.startsWith('#') || id.startsWith('[') || id.startsWith('>')) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_DISCOVERED) break
  }
  return out
}

/**
 * Run one agent's discovery probe and return its parsed model ids ([] on any
 * failure — missing binary, timeout, garbage output). Never throws.
 */
export async function discoverModels(
  agent: Agent,
  cwd: string,
  timeoutMs = 10_000
): Promise<string[]> {
  const d = agent.modelDiscovery
  if (!d || d.kind !== 'command') return []
  if (whichOnPath(agent.detect ?? agent.command) === null) return []
  // Reuse the hardened tool spawn: token-stripped env, capture stdout, never-reject,
  // timeout → killTree, stderr drained. Run the discovery argv (not the agent's args).
  const raw = await runToolCapture({ ...agent, args: d.argv }, cwd, {}, timeoutMs)
  return parseModelList(raw, d.format)
}

/**
 * Discover models for every agent that has an AUTHOR-SHIPPED command descriptor and is
 * installed. `isTrusted` decides trust by PROVENANCE (the descriptor matches the canonical
 * shipped one), not just id — a user-authored/edited probe is SKIPPED so it is never
 * executed without exec-consent (M12). Probes run in parallel; a failing one contributes
 * nothing.
 */
export async function discoverAllModels(
  agents: Agent[],
  isTrusted: (agent: Agent) => boolean,
  cwd: string,
  timeoutMs = 10_000
): Promise<DiscoveredModels[]> {
  const targets = agents.filter((a) => a.modelDiscovery?.kind === 'command' && isTrusted(a))
  const results = await Promise.all(
    targets.map(async (a) => ({ agentId: a.id, models: await discoverModels(a, cwd, timeoutMs) }))
  )
  // Only surface non-empty discoveries (an empty probe keeps the static seed).
  return results.filter((r) => r.models.length > 0)
}
