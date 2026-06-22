// Broad agent-CLI detection catalog (ROADMAP M1b). Each entry is a standard Agent
// template; loadAgents() surfaces an entry ONLY when its `detect` binary is found
// on PATH, and NEVER persists it to agents.json — so it appears when the tool is
// installed and disappears when it isn't.
//
// These are popular agent CLIs BEYOND the on-machine-verified DEFAULT_AGENTS. Each
// invocation here is DOCUMENTATION-researched (current official docs/sources) and
// adversarially flag-checked — not on-machine verified like DEFAULT_AGENTS. Edit
// freely in agents.json if a flag drifts. Like the user's own agents, these run in
// the disposable app-owned worktree with the user's env (the GitHub token is never
// passed); a provider API key, if the CLI needs one, comes from the user's own env.
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

const REVIEW_TIMEOUT = 900

export const AGENT_CATALOG: Agent[] = [
  {
    id: 'qwen',
    label: 'Qwen Code',
    command: 'qwen',
    // gemini-cli fork: --approval-mode plan = analyze-only (no edits / no shell);
    // --output-format text = clean final answer (no tool/reasoning transcript).
    args: [
      '--approval-mode',
      'plan',
      '--output-format',
      'text',
      '--model',
      '{{model}}',
      '--prompt',
      '{{prompt}}'
    ],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: REVIEW_TIMEOUT,
    env: {},
    model: 'qwen3-coder-plus',
    models: ['qwen3-coder-plus', 'qwen3-coder-next', 'qwen3-max-2026-01-23'],
    reasoning: '',
    reasoningLevels: [],
    detect: 'qwen'
  },
  {
    id: 'cn',
    label: 'Continue CLI',
    command: 'cn',
    // -p = headless (prints only the final response), --readonly = plan mode
    // (read-only tools only), --silent = no extra chatter. No --model: cn uses the
    // model configured in the user's Continue config.
    args: ['-p', '{{prompt}}', '--readonly', '--silent'],
    promptDelivery: 'arg',
    promptPlaceholder: '{{prompt}}',
    outputCapture: 'stdout',
    outputFile: null,
    timeoutSec: REVIEW_TIMEOUT,
    env: {},
    reasoning: '',
    reasoningLevels: [],
    detect: 'cn'
  }
]
