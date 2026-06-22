// Generic unknown-CLI detection (ROADMAP M2, comprehensive autodiscovery). Pure +
// electron-free core: given a curated registry of coding-agent CLI binary names and an
// injected PATH lookup, report which ones are installed but NOT already covered by a
// configured agent — as INERT "candidates" (display info only, never a runnable command).
// This is the property that keeps autodiscovery from rotting: a coding CLI Aerie has no
// template for still surfaces so the user knows it's there and can wire it (then consent it).
//
// SECURITY: detection is name-matching against a BOUNDED, author-curated registry plus a PATH
// file-existence check — it spawns NOTHING (no --version/--help probe here; that enrichment,
// if added, is a later slice and must be exec-consent/timeout/killTree gated). A candidate
// carries no `command`/`args` an agent runner could spawn, so it can never be auto-run.

import type { AgentCandidate } from '../shared/types'

export interface KnownCli {
  /** The binary name typed in the terminal (matched against PATH). */
  command: string
  /** Display name shown in the UI. */
  label: string
}

// Curated registry of coding-agent CLIs Aerie is AWARE of but ships NO template for. Curation
// bar: a DISTINCTIVE binary name with low false-positive risk. Generic names that commonly
// belong to non-AI tools are DELIBERATELY excluded to keep the candidate report trustworthy —
// e.g. `goose` (pressly/goose DB-migration tool), `forge` (Foundry/Solidity), `q`, `amp`,
// `llm`. Each entry's binary name is a verified, real tool. Extend freely — it's just data.
export const KNOWN_CODING_CLIS: KnownCli[] = [
  { command: 'aider', label: 'Aider' },
  { command: 'crush', label: 'Crush (Charm)' },
  { command: 'sgpt', label: 'Shell GPT' },
  { command: 'plandex', label: 'Plandex' },
  { command: 'openhands', label: 'OpenHands' },
  { command: 'aichat', label: 'aichat' },
  { command: 'gptme', label: 'gptme' },
  { command: 'mods', label: 'Mods (Charm)' }
]

/**
 * Which known coding CLIs are installed (binary on PATH) but NOT already covered by a
 * configured agent. Pure: `configuredBins` is the set of `detect ?? command` binaries of every
 * loaded agent (so a CLI already wired to an agent isn't reported), and `locate` returns the
 * absolute path of a binary on PATH or null (injected = `whichOnPath`). The result is inert —
 * display info only, never a spawnable command. De-duplicated by binary.
 */
export function detectCandidates(opts: {
  known: KnownCli[]
  configuredBins: ReadonlySet<string>
  locate: (bin: string) => string | null
}): AgentCandidate[] {
  const out: AgentCandidate[] = []
  const seen = new Set<string>()
  for (const cli of opts.known) {
    if (opts.configuredBins.has(cli.command) || seen.has(cli.command)) continue
    const path = opts.locate(cli.command)
    if (path === null) continue
    seen.add(cli.command)
    out.push({ command: cli.command, label: cli.label, path })
  }
  return out
}
