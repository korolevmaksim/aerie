# Aerie

**A desktop app that runs your local AI coding agents on a GitHub commit or PR, then posts the review back to GitHub — under your explicit confirmation.**

[![CI](https://github.com/korolevmaksim/aerie/actions/workflows/ci.yml/badge.svg)](https://github.com/korolevmaksim/aerie/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Aerie is GitHub mission-control for developers who already run AI coding-agent CLIs
(Codex, Claude Code, Cursor, Gemini, and more). Instead of copy-pasting diffs into a
terminal, you browse your repos, pick a commit or PR, choose an agent + a review prompt,
and Aerie checks the change out locally, runs the agent against it, streams the output
live, and — only when you confirm — posts the result as a commit comment, PR comment, or
issue.

The agents run **locally, on your machine, against an app-owned clone**. Your GitHub token
never leaves the main process and is never handed to an agent.

> Status: early but functional (v0.1). macOS-first, cross-platform by design.

---

## Why

The commodity GitHub features (Actions, PR dashboards, analytics) already exist. Aerie's
one job is the part nothing else does well: **turn the local AI coding agents you already
have into a first-class GitHub review loop**, without shipping your code or token to a
third-party service.

## Features

- **Multi-account GitHub** — add one or more Personal Access Tokens; tokens are encrypted
  at rest with the OS keychain (`safeStorage`) and never cross into the UI.
- **Browse repos, commits, and PRs** — cached with conditional requests (ETags), so
  re-listing costs ~0 rate limit.
- **Local checkout** — Aerie clones into an app-owned working copy (or, opt-in, a
  read-only worktree of your own clone) and builds the unified diff for the agent.
- **Review your working tree before the PR** — point an agent at the **uncommitted**
  changes in your mapped local clone (all changes via `git diff HEAD`, or just what's
  staged) for a pre-PR pass. Zero GitHub calls, no checkout, never touches your working
  copy — read-only `git diff` only.
- **Edit your own agents** — the Tools tab has an in-app editor to add, clone, edit, and delete
  custom agent CLIs (the full contract: command, args, env, output capture, …). A user-added agent
  must be **explicitly approved** before Aerie will run its command — editing the command re-requires
  approval — and a custom agent can never shadow a built-in.
- **Spots coding CLIs you haven't wired** — the Tools tab also flags coding-agent CLIs found on your
  PATH that Aerie has no agent for yet (a **"Detected, not configured"** list) with an **Add as
  agent** shortcut that opens the editor prefilled — so a newly-installed CLI surfaces even before a
  template ships. These hints are inert: nothing runs until you create and approve an agent.
- **Run any local agent** — a small, editable registry ships templates for Codex,
  Claude Code, Cursor Agent, opencode, Kimi, Gemini, Mistral Vibe, Grok, Antigravity, and
  MiMo. Installed agents are auto-detected; pick a model and (where supported) a
  reasoning/thinking level per agent.
- **Reviews grounded in local tools** — before an agent reviews a change, Aerie runs your
  installed, change-relevant quality tools (ESLint, oxlint, Biome, `tsc`, Ruff, Bandit, yamllint,
  actionlint, Gitleaks) 100% locally, scopes their findings to the diff, de-duplicates them, and
  hands them to the agent as ground truth to confirm/refute/merge — so it triages real findings
  instead of inventing noise. Best-effort; toggle off in Settings → "Ground reviews with local tools".
- **Curated review prompts, out of the box** — Default, Security audit, Tests & edge
  cases, Performance, Architecture & maintainability, and Quick triage. Edit them or add
  your own in Settings, then pick one per run. Aerie always prepends the machine context
  (repo, SHA, working-copy + diff paths) so a custom prompt can never leave the agent
  without something to review.
- **Structured findings** — each review also extracts the agent's concrete findings (file, line,
  severity, message) into a compact list under the review; the raw block is kept out of the posted
  comment. Sets up cross-agent consensus across a panel.
- **Panel review (multi-agent) + consensus** — flip on "Panel review" to run one change through
  several agents at once; each streams its own review side by side (up to 3 run concurrently, the
  rest queue). A **Consensus** view then shows the issues that ≥K of the agents agree on (by code
  location) — a second opinion, and a way to see what's worth trusting, in one click.
- **Presets** — save an agent + model + reasoning bundle and apply it in one click.
- **Live output, kill, and history** — watch the agent's transcript stream, stop a run,
  and reopen any past run's logs and result. Search history by repo, agent, SHA, PR, status, or
  author, narrow it to one repository, and copy the filtered list as Markdown or JSON.
- **Command palette (Cmd/Ctrl-K)** — fuzzy-jump to any view, account, or repo without reaching
  for the mouse.
- **Automate (pipelines)** — an **Automate** view that watches a repo's default branch on a local
  poll (never a webhook) and, on a new commit, runs your chosen agents, aggregates their findings,
  and then **notifies**, **stages** the result for you to post, or — only when you flip a per-pipeline
  opt-in — **auto-posts** it. **Create/edit pipelines** in-app (repo, trigger, agent steps, scope
  filters, and the action) — choosing **Post** reveals an explicit auto-post toggle gated behind a
  distinct danger confirm. The list shows each pipeline's live run status, an enable toggle,
  **Run now** / **Dry run** buttons, and an expandable **run history**; a dry run never writes to
  GitHub regardless of the opt-in.
  Auto-post is off by default and enforced in the main process.
- **Post back to GitHub — behind a confirm** — every write (commit comment, PR comment, or
  new issue) requires an explicit in-app confirmation showing the exact body. Optionally
  `@`-mention the commit/PR author.

## Security model

Aerie handles GitHub tokens and spawns local processes, so the boundaries are deliberate:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The renderer is UI
  only — it never imports Node, touches tokens, or shells out.
- All GitHub, git, token, and agent work happens in the **main process**. The renderer
  reaches it solely through a small, typed `contextBridge` IPC surface.
- Tokens are encrypted at rest via Electron `safeStorage`, are never sent to the renderer,
  never written to a log, and are **never** placed in an agent's environment.
- Agents run on **app-owned clones** by default, not your working copies (read-only
  worktree mode is opt-in, default off).
- **Every** GitHub write sits behind an explicit confirmation dialog.

Found a security issue? See [SECURITY.md](.github/SECURITY.md).

## Supported agents

Agent templates are plain config (`agents.json` in the app's user-data dir) — adding or
editing one is a config edit, not a code change. Ships with templates for:

`codex` · `claude-code` · `cursor-agent` · `opencode` · `kimi` · `gemini` · `vibe`
(Mistral) · `grok` · `agy` (Antigravity) · `mimo`.

Each template was tuned for a **clean, headless, read-only** review invocation (only the
final review is captured — no chat UI or tool-call transcript in the posted comment). You
only see and can run the agents whose CLI is actually installed on your PATH.

Beyond those, Aerie ships a broader **detection catalog** of agent-CLI templates that appear
automatically when their binary is on your PATH (and vanish when it isn't). You can extend it
with your own without touching `agents.json` by dropping an `agentCatalog.json` (a
`{ "schemaVersion": 1, "agents": [ …templates… ] }` file) into the app's user-data dir; those
entries likewise surface only when detected. Because they aren't author-shipped, a catalog
entry must be **explicitly approved once** (the same exec-consent prompt as a user-edited
agent) before it can run.

## Requirements

- **Node.js ≥ 20.19** (CI runs on Node 22; see `.nvmrc`).
- A **C/C++ toolchain** — `better-sqlite3` is a native module rebuilt for Electron on
  install:
  - macOS: `xcode-select --install`
  - Windows: Visual Studio Build Tools (Desktop C++) + Python 3
  - Linux: `build-essential` + `python3`
- At least one supported agent CLI installed and authenticated, if you want to run real
  reviews. (The registry ships a real-agent-only set; install whichever you use.)

## Build from source

```bash
git clone https://github.com/korolevmaksim/aerie.git
cd aerie
npm install            # postinstall rebuilds better-sqlite3 for Electron
npm run dev            # run the app in development
```

Other scripts:

```bash
npm run typecheck      # tsc (node + web projects)
npm run lint           # eslint
npm test               # vitest (pure-logic unit tests)
npm run build          # typecheck + bundle (electron-vite)
npm run build:unpack   # build an unpacked app into release/
```

### Packaging a macOS app

Builds are **unsigned** by default. To produce a local unsigned build, disable
electron-builder's signing auto-discovery:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac
```

Because the build is unsigned/un-notarized, macOS Gatekeeper will warn on first launch —
right-click the app → **Open**, or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Aerie.app
```

(On Windows an unsigned build triggers SmartScreen → **More info → Run anyway**.)

## Using it

1. **Add an account** — paste a GitHub PAT (classic or fine-grained). It's validated and
   encrypted locally.
2. **Pick a repo**, then a **commit or PR**.
3. (Optional) **Prepare a local checkout** to pre-clone.
4. Choose an **agent**, **model**, **reasoning level**, and a **review prompt** (or apply a
   preset), then **Review with agent**.
5. Watch the live transcript. When it finishes, **Post as commit/PR comment** or **Create
   issue** — confirm the exact body (optionally tag the author) and it's posted.

### Configuring agents & prompts

- **Agents** — Settings shows the path to `agents.json`; edit it to add an agent, change a
  command, or adjust model/flags. Per-agent model and reasoning choices are stored
  separately and persist.
- **Prompts** — Settings → **Review prompts**: edit the defaults or add focused prompts;
  the picker on the run screen selects one per review. Power users can reference
  `{{repo}}`, `{{sha}}`, `{{repoPath}}`, `{{diffFile}}` placeholders in a prompt body.

## Project layout

```
src/
  main/      privileged process: GitHub (Octokit), git (simple-git), agent runner,
             SQLite store, encrypted tokens, IPC handlers
  preload/   the typed contextBridge API — the only renderer ↔ main seam
  renderer/  React UI (no Node, no tokens, no shelling out)
  shared/    types, IPC channel names, validators shared across processes
.github/     CI, security policy, Dependabot
SPEC.md      the build specification (source of truth)
```

Built on Electron 42 · electron-vite · React 19 · TypeScript (strict) · better-sqlite3 ·
Octokit · simple-git. All bundled dependencies are MIT/BSD/Apache-2.0/ISC.

## Roadmap / non-goals

v1 is intentionally focused on the review loop. Out of scope for now: Actions/workflow
dashboards, analytics, org-admin actions, GitHub writes beyond commit/PR comments +
optional issue creation, and real-time webhooks — GitHub already does those well.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). In short: keep the
security boundaries intact, run `npm run typecheck && npm run lint && npm test` before a
PR, and match the existing TypeScript-strict, English-comment style.

## License

[MIT](LICENSE) © 2026 Maksim Korolyov.
