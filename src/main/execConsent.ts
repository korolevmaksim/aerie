// Exec-consent (ROADMAP M12 — the core trust boundary). Aerie spawns an agent's
// `command` with its `args`/`env` — for AUTHOR-SHIPPED templates/catalog entries that's
// vetted, but a USER-authored or user-edited agent (in agents.json, or a future in-app
// editor) is arbitrary local code. This module decides, purely, whether a given agent is
// allowed to be spawned: shipped ids are implicitly trusted; any other agent must carry a
// persisted consent whose signature still matches what would be executed. Editing the
// command/args/env/discovery changes the signature, so stale consent never auto-approves
// a changed command. Electron-free + unit-tested; the runner enforces it at the spawn
// boundary and the IPC records consent.

import { createHash } from 'node:crypto'
import type { Agent } from './agentConfig'

/**
 * A stable signature over EVERYTHING that gets executed for an agent — the binary, its
 * argv, its env, and any model-discovery argv. Object keys are sorted so it's order-
 * independent; argv order is preserved (it's significant). Any change re-keys the consent.
 */
export function agentSignature(agent: Agent): string {
  const envEntries = Object.entries(agent.env ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  const discovery = agent.modelDiscovery?.kind === 'command' ? agent.modelDiscovery.argv : null
  const material = JSON.stringify([agent.command, agent.args, envEntries, discovery])
  return createHash('sha256').update(material).digest('hex')
}

/**
 * May this agent be spawned? Shipped (author-vetted) ids are always allowed. Any other
 * agent is allowed ONLY when a non-empty consent signature was recorded and still equals
 * the agent's current signature.
 */
export function isExecAllowed(args: {
  isShipped: boolean
  signature: string
  consentedSignature: string | undefined | null
}): boolean {
  if (args.isShipped) return true
  return !!args.signature && args.consentedSignature === args.signature
}

/** Convenience: does this non-shipped agent still need the user's exec approval? */
export function agentNeedsConsent(
  agent: Agent,
  isShipped: boolean,
  consentedSignature: string | undefined | null
): boolean {
  return !isExecAllowed({ isShipped, signature: agentSignature(agent), consentedSignature })
}
