# Aerie

**A desktop app that runs your local AI coding agents on a GitHub commit, PR, working tree, or whole project, then posts the review back to GitHub — under your explicit confirmation.**

[![CI](https://github.com/korolevmaksim/aerie/actions/workflows/ci.yml/badge.svg)](https://github.com/korolevmaksim/aerie/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Aerie is GitHub mission-control for developers who already run AI coding-agent CLIs
(Codex, Claude Code, Cursor, Gemini, and more). Instead of copy-pasting diffs into a
terminal, you browse your repos, pick a project, commit, PR, or working-tree diff, choose
an agent + a review prompt, and Aerie checks the target out locally, runs the agent against
it, streams the output live, and — only when you confirm — posts the result as a commit
comment, PR comment, or issue.

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
- **Review cockpit** — after adding an account, Aerie opens on an account-scoped cockpit
  with active runs, attention-worthy reviews, ready-to-post results, favorite/recent repo
  targets, agent readiness, automation liveness, and the local trust boundary in one place.
  On macOS, the native traffic-light controls sit in a seamless draggable header that
  reserves space above the UI; the task sidebar can collapse to a compact rail when the
  review surface needs more room.
- **Refined desktop UI** — a token-driven design language with a single disciplined accent, a
  layered surface ladder with hairline borders, a tiered text hierarchy, and intentional
  typography. Light and dark themes follow your OS appearance automatically. See
  `docs/design-system.md`.
- **Browse repos, commits, and PRs** — cached with conditional requests (ETags), so
  re-listing costs ~0 rate limit.
- **Local checkout** — Aerie clones into an app-owned working copy (or, opt-in, a
  read-only worktree of your own clone) and builds the unified diff for the agent.
- **Review your working tree before the PR** — point an agent at the **uncommitted**
  changes in your mapped local clone (all changes via `git diff HEAD`, or just what's
  staged) for a pre-PR pass. Zero GitHub calls, no checkout, never touches your working
  copy — read-only `git diff` only.
- **Review the whole project** — start from a repo's **Project** tab to run an agent on
  the current default-branch snapshot. Aerie uses an app-owned checkout and writes a
  bounded project inventory/audit brief instead of dumping the repository into the prompt;
  the agent reads the checked-out source directly. Project reviews can be posted as a new
  issue after confirmation.
- **Edit your own agents** — the Tools tab has an in-app editor to add, clone, edit, and delete
  custom agent CLIs. The form leads with what you change most — pick the **model** and the
  **thinking/reasoning level** from add/remove chip lists (a low/medium/high quick-fill is one
  click) instead of hand-typing raw flags — and tucks the full contract (args, env, output
  capture, …) behind an **Advanced** section with a token legend. A user-added agent must be
  **explicitly approved** before Aerie will run its command — editing the command re-requires
  approval — and a custom agent can never shadow a built-in. Cancelling an edited agent draft asks
  before discarding unsaved changes.
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
- **Curated review prompts, out of the box** — Default, Project audit, Security audit,
  Tests & edge cases, Performance, Architecture & maintainability, and Quick triage.
  Edit them or add your own in Settings, then pick one per run. Aerie always prepends the
  machine context (repo, SHA, working-copy + diff/project-audit paths) so a custom prompt
  can never leave the agent without something to review. Prompt edits ask before
  discarding an unsaved draft.
- **Structured findings** — each review also extracts the agent's concrete findings (file, line,
  severity, message) into a compact list under the review; the raw block is kept out of the posted
  comment. Sets up cross-agent consensus across a panel.
- **Panel review (multi-agent) + consolidated report** — flip on "Panel review" to run one change
  through several agents at once; up to 3 run concurrently and the rest queue. Aerie persists the
  panel as one review object in Cockpit and History, not as loose child runs. Open it to see a
  single consolidated report: consensus findings agreed by ≥K agents, single-source findings to
  triage, copy-ready Markdown, confirm-gated GitHub posting, and each child agent report preserved
  below as evidence.
- **Presets** — save an agent + model + reasoning bundle and apply it in one click.
- **Live output, kill, and history** — watch the agent's transcript stream, stop a run,
  reopen any past run's logs and result, **copy a review** (plain or Markdown) to paste into a
  PR or notes, **mark a review handled or verified locally** when you fix it without posting to
  GitHub, and **re-run** it (same agent + target) for a second opinion. Search history by repo,
  agent, SHA, PR, status, local disposition, or author, narrow it to one repository, and copy the
  filtered list as Markdown or JSON.
- **Command palette (Cmd/Ctrl-K)** — fuzzy-jump to any view, account, or repo without reaching
  for the mouse.
- **Automate (pipelines)** — an **Automate** view that watches a repo's default branch on a local
  poll (never a webhook), runs your chosen agents, aggregates their findings, and then **notifies**,
  **stages** the result for you to post, or — only when you flip a per-pipeline opt-in —
  **auto-posts** it. A **`commit`** pipeline reacts to every new commit at a continuous cadence; a
  **`schedule`** pipeline polls the default branch on a cadence **you set** (every N minutes / hours
  / days). Scheduled pipelines can review either the latest commit diff when the head changes, or a
  whole-project snapshot on every due cadence using the same Project runner and repo clone/worktree
  setting. Restarting Aerie, enabling a pipeline, or saving its config does not bypass that cadence;
  the next automatic run is based on the latest pipeline run or config/enable update. **Run now**
  and **Dry run** are the explicit immediate actions. **Create/edit pipelines** in-app (repo,
  trigger + schedule cadence, review target, agent steps with model selection from the chosen
  agent/tool, scope filters, and the action) — choosing **Post** reveals an explicit auto-post toggle
  gated behind a distinct danger confirm. Multi-agent pipeline runs create the same consolidated
  report as manual Panel review — consensus findings, single-source findings, and child agent
  evidence — and the Automate run history links directly to it. Project audits post as issues. The
  editor ignores backdrop clicks, and **Cancel** / **Esc** asks before discarding unsaved pipeline
  changes. The list shows each pipeline's live run status, an enable
  switch, trigger cadence (for example **Every 24 hours**), review target, action, **Run now** /
  **Dry run** buttons, and an expandable **run history**; a dry run never writes to GitHub regardless
  of the opt-in. A liveness line distinguishes the background poller from runnable automation: it
  shows idle states when no pipeline is enabled, and otherwise shows when enabled watches last
  checked, when they'll next check, and the remaining GitHub API budget.
  Auto-post is off by default and enforced in the main process.
- **Post back to GitHub — behind a confirm** — every write (commit comment, PR comment, or
  new issue) requires an explicit in-app confirmation showing the exact body. If you edit that
  body, **Cancel** / **Esc** asks before discarding it, and backdrop clicks do not close the
  dialog. Optionally `@`-mention the commit/PR author.

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
npm run smoke:store    # Electron ABI store migrations + CRUD smoke test
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
2. Start from the **Review cockpit** — clear any active/ready-to-post runs, or jump into a
   favorite/recent repository.
3. **Pick a repo**, then a **project audit, commit, PR, or working-tree diff**.
4. (Optional) **Prepare a local checkout** to pre-clone.
5. Choose an **agent**, **model**, **reasoning level**, and a **review prompt** (or apply a
   preset), then **Review with agent**.
6. Watch the live transcript. When it finishes, **Post as commit/PR comment** where that
   target exists, or **Create issue** — confirm the exact body (optionally tag the author)
   and it's posted.
7. If you handled the audit locally instead, mark it **Handled locally** or **Verified locally**
   from the run view so it leaves the cockpit attention queue without creating a GitHub comment.

### Configuring agents & prompts

- **Agents** — use the Tools tab's in-app editor to add an agent, change its command, or curate
  its models and thinking levels; the chip lists you build there become the dropdowns on the run
  screen. Settings also shows the path to `agents.json` for hand-editing. Per-agent model and
  reasoning choices are stored separately and persist.
- **Prompts** — Settings → **Review prompts**: edit the defaults or add focused prompts;
  the picker on the run screen selects one per review. Power users can reference
  `{{repo}}`, `{{sha}}`, `{{repoPath}}`, `{{diffFile}}`, and `{{reviewFile}}`
  placeholders in a prompt body.

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
