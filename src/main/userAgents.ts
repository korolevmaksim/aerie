// User agent CRUD validation (ROADMAP M12 editor). Pure, electron-free decision logic
// for adding/editing/cloning/removing USER-authored agents in the user slice of
// agents.json. The privileged write + IPC live in the runner; this is the unit-testable
// core that enforces: a user agent can NEVER claim a shipped (default/catalog/tool) id,
// ids are well-formed and unique within the user slice, and the payload is a valid Agent.
// Anything saved here is still subject to the M12 exec-consent gate before it can run.

import { isAgent, type Agent } from './agentConfig'

/**
 * Allowed user-agent id: lowercase-alphanumeric start, then [a-z0-9._-], ≤64 chars.
 * Lowercase-only (no /i) because the shipped-id and duplicate collision checks are
 * case-sensitive — allowing `Codex` would let a confusing near-duplicate of `codex` slip
 * past the "can't claim a built-in id" rule.
 */
export const USER_AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export type UpsertResult = { ok: true; agents: Agent[] } | { ok: false; error: string }

/**
 * Validate + upsert a user agent into the user slice (replace by id, else append).
 * Rejects: an invalid Agent payload, a malformed id, an id that collides with ANY
 * author-shipped id (can't shadow a built-in), or a duplicate of another user agent.
 * `editingId` (when editing) is the id being replaced — it may match the new id and is
 * excluded from the duplicate check (a rename is delete-old + add-new).
 */
export function upsertUserAgent(args: {
  userAgents: Agent[]
  agent: unknown
  shippedIds: ReadonlySet<string>
  editingId?: string
}): UpsertResult {
  const { userAgents, agent, shippedIds, editingId } = args
  if (!isAgent(agent)) return { ok: false, error: 'Invalid agent definition.' }
  const id = agent.id
  if (!USER_AGENT_ID_RE.test(id)) {
    return {
      ok: false,
      error: 'Id must start alphanumeric and use only letters, digits, . _ - (≤64).'
    }
  }
  if (shippedIds.has(id)) {
    return { ok: false, error: `"${id}" is a built-in agent id — choose a different id.` }
  }
  if (userAgents.some((a) => a.id === id && a.id !== editingId)) {
    return { ok: false, error: `A user agent "${id}" already exists.` }
  }
  // Drop the old (by new id, and by editingId for a rename), then append the new one.
  const without = userAgents.filter((a) => a.id !== id && a.id !== editingId)
  return { ok: true, agents: [...without, agent] }
}

/** Remove a user agent by id (no-op if absent). Only ever operates on the user slice. */
export function deleteUserAgent(userAgents: Agent[], id: string): Agent[] {
  return userAgents.filter((a) => a.id !== id)
}

/** Copy any agent into a fresh USER agent under a new id (label gets a "(copy)" suffix). */
export function cloneToUserAgent(source: Agent, newId: string): Agent {
  return { ...source, id: newId, label: `${source.label} (copy)` }
}
