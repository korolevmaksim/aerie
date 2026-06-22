// Broad agent-CLI detection catalog (ROADMAP M1b → M2). Each entry is a standard Agent
// template; loadAgents() surfaces an entry ONLY when its `detect` binary is found
// on PATH, and NEVER persists it to agents.json — so it appears when the tool is
// installed and disappears when it isn't.
//
// As of M2 the catalog is DATA, not hardcoded TS: the entries live in the bundled,
// schema-versioned `data/agentCatalog.json` and are parsed + validated through
// `parseCatalog` (the same chokepoint a user/remote catalog will use). Adding a CLI is
// a data edit. The bundled file is author-shipped, so its entries are author-trusted
// (their signatures are in the runner's CANONICAL_SIGNATURES); a user/remote-catalog
// entry is NOT auto-trusted and still needs exec-consent (M12) before it can run.
//
// These are popular agent CLIs BEYOND the on-machine-verified DEFAULT_AGENTS. Each
// invocation is DOCUMENTATION-researched (current official docs/sources) and
// adversarially flag-checked — not on-machine verified like DEFAULT_AGENTS. Edit
// freely in agents.json if a flag drifts. Like the user's own agents, these run in
// the disposable app-owned worktree with the user's env (the GitHub token is never
// passed); a provider API key, if the CLI needs one, comes from the user's own env.
//
// Bundled entries + their flag rationale:
//  - qwen (Qwen Code): gemini-cli fork. `--approval-mode plan` = analyze-only (no
//    edits / no shell); `--output-format text` = clean final answer (no tool/reasoning
//    transcript). `--model {{model}}` selects from the models list.
//  - cn (Continue CLI): `-p` = headless (prints only the final response), `--readonly`
//    = plan mode (read-only tools only), `--silent` = no extra chatter. No `--model`:
//    cn uses the model configured in the user's Continue config.
//
// Deferred after research (not added yet, and why):
//  - crush      : `crush run` blocks on interactive tool-approval headless — no working
//                 skip-permissions flag (`--yolo` is rejected on `run`, see charmbracelet/
//                 crush#2792) — so under a non-interactive spawn it hangs to the timeout.
//  - amp        : no per-run read-only mode + paid-credit execute mode; low confidence.
//  - aider      : no clean-output flag — stdout mixes a banner/cost summary with the review.
//  - goose      : `chat` mode (read-only) disables all tools, so it can't open the diff file.
//  - llm, sgpt  : non-agentic prompt-completion tools — can't read the file-based diff under
//                 the current contract (revisit if Aerie adds a diff-inlined prompt mode).
//  - plandex, openhands, forge : no practical one-shot headless review mode.

import type { Agent } from './agentConfig'
import bundledCatalog from './data/agentCatalog.json'
import { parseCatalog } from './catalogSchema'

const parsed = parseCatalog(bundledCatalog)
if (parsed.errors.length > 0) {
  // The bundled catalog is author-shipped and guarded by a unit test, so this should never
  // fire in a release build — but surface it loudly rather than silently shipping fewer CLIs.
  console.warn('[agentCatalog] bundled catalog has invalid entries:', parsed.errors.join('; '))
}

/** The bundled agent-CLI catalog, materialized from `data/agentCatalog.json`. */
export const AGENT_CATALOG: Agent[] = parsed.entries
